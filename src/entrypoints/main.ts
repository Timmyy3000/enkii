#!/usr/bin/env bun

/**
 * Single unified entrypoint. Handles the full enkii pipeline in one process:
 * env validation → context parse → trigger detection → dispatch → run reviews
 * (code + security in parallel when applicable) → post.
 *
 * Inputs (env):
 *   - OPENROUTER_API_KEY        (required)
 *   - OVERRIDE_GITHUB_TOKEN     (custom GitHub App token; falls back to runner token)
 *   - REVIEW_MODEL              (default "@preset/enkii")
 *   - SECURITY_MODEL            (default "@preset/enkii")
 *   - REVIEW_SKILL_PATH         (optional consumer override)
 *   - SECURITY_SKILL_PATH       (optional consumer override)
 *   - ENABLE_VALIDATOR          ("true" | "false", default "false") — Pass 2
 *   - RUN_SECURITY              ("true" | "false", default "true")  — auto-run security on PR events
 *   - GITHUB_ACTION_PATH        (set by runner; bundled skills live here)
 *   - GITHUB_WORKSPACE          (set by runner; consumer skill overrides resolve here)
 *   - RUNNER_TEMP               (set by runner; artifacts go under <RUNNER_TEMP>/enkii-prompts/)
 */

import * as core from "@actions/core";
import { join } from "path";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { checkoutPullRequestHead } from "../github/data/pr-checkout";
import { loadSkill } from "../skills/loader";
import { shouldTriggerTag, prepareTagExecution } from "../tag";
import {
  runCodeReview,
  runSecurityReview,
  type RunReviewResult,
} from "../tag/commands/review";
import {
  postReviewFromValidated,
  ENKII_REVIEW_MARKER,
  ENKII_SECURITY_MARKER,
} from "../post";
import { postHelpReply } from "../post/help";
import type { PreparedContext } from "../prompts/types";
import { fetchEnkiiComment } from "../github/operations/comments/fetch-enkii-comment";
import { updateEnkiiComment } from "../github/operations/comments/update-enkii-comment";
import { updateCommentBody } from "../github/operations/comment-logic";
import { GITHUB_SERVER_URL } from "../github/api/config";

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function validateEnv(): void {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(
      "enkii could not find OPENROUTER_API_KEY. " +
        "Cause: the secret is not set on this repo. " +
        "Fix: Settings → Secrets and variables → Actions → New repository secret " +
        "→ name OPENROUTER_API_KEY, value from https://openrouter.ai/keys",
    );
  }
}

function detectForkPR(context: ReturnType<typeof parseGitHubContext>): boolean {
  const payload = context.payload as Record<string, unknown> | undefined;
  if (!payload) return false;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) return false;
  const head = pr.head as Record<string, unknown> | undefined;
  const headRepo = head?.repo as Record<string, unknown> | undefined;
  return Boolean(headRepo?.fork);
}

async function markTrackingCommentFailed(args: {
  octokit: ReturnType<typeof createOctokit>;
  context: ReturnType<typeof parseGitHubContext>;
  trackingCommentId?: number;
  errorMessage: string;
}): Promise<void> {
  const { octokit, context, trackingCommentId, errorMessage } = args;
  if (!trackingCommentId || !isEntityContext(context)) return;

  try {
    const { owner, repo } = context.repository;
    const fetched = await fetchEnkiiComment(octokit, {
      owner,
      repo,
      commentId: trackingCommentId,
      isPullRequestReviewCommentEvent:
        context.eventName === "pull_request_review_comment",
    });

    const jobUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${context.runId}`;
    const nextBody = updateCommentBody({
      currentBody: fetched.comment.body ?? "",
      actionFailed: true,
      executionDetails: null,
      jobUrl,
      errorDetails: errorMessage,
    });

    await updateEnkiiComment(octokit.rest, {
      owner,
      repo,
      commentId: trackingCommentId,
      body: nextBody,
      isPullRequestReviewComment: fetched.isPRReviewComment,
    });
    console.log(`enkii: updated tracking comment ${trackingCommentId} with failure details`);
  } catch (updateError) {
    console.warn(
      `enkii: failed to update tracking comment ${trackingCommentId} after error: ${
        updateError instanceof Error ? updateError.message : String(updateError)
      }`,
    );
  }
}

async function run(): Promise<void> {
  let parsedContext: ReturnType<typeof parseGitHubContext> | null = null;
  let octokit: ReturnType<typeof createOctokit> | null = null;
  let trackingCommentId: number | undefined;

  try {
    validateEnv();

    const reviewModel = process.env.REVIEW_MODEL || "@preset/enkii";
    const securityModel = process.env.SECURITY_MODEL || "@preset/enkii";
    const reviewSkillPath = process.env.REVIEW_SKILL_PATH || "";
    const securitySkillPath = process.env.SECURITY_SKILL_PATH || "";
    const enableValidator = envFlag("ENABLE_VALIDATOR", false);
    const runSecurity = envFlag("RUN_SECURITY", true);

    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const workspacePath = process.env.GITHUB_WORKSPACE || process.cwd();
    const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
    const promptsDir = join(runnerTemp, "enkii-prompts");

    const context = parseGitHubContext();
    parsedContext = context;
    const githubToken = await setupGitHubToken();
    octokit = createOctokit(githubToken);

    if (isEntityContext(context)) {
      const tokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const ok = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        tokenProvided,
      );
      if (!ok) {
        throw new Error(
          "enkii: actor does not have write permissions on this repository. " +
            "Cause: triggering user is not a maintainer/collaborator. " +
            "Fix: only repo maintainers can trigger enkii in v0.1.",
        );
      }
    }

    const containsTrigger = shouldTriggerTag(context);
    console.log(`enkii trigger detected: ${containsTrigger}`);
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No enkii trigger in this event, skipping.");
      return;
    }

    const dispatch = await prepareTagExecution({
      context,
      octokit,
      githubToken,
    });
    trackingCommentId = dispatch.trackingCommentId;
    console.log(`enkii dispatch: ${dispatch.command}`);
    if (dispatch.reason) console.log(`Reason: ${dispatch.reason}`);

    if (!isEntityContext(context)) {
      console.log("enkii: non-entity context post-dispatch; skipping.");
      return;
    }

    if (dispatch.command === "skip") return;

    if (dispatch.command === "help" || dispatch.command === "status") {
      await postHelpReply({
        octokit,
        context,
        command: dispatch.command,
      });
      return;
    }

    if (!context.isPR) {
      throw new Error(
        "enkii: review commands only run on PR events. " +
          "Cause: triggering event was not a PR. " +
          "Fix: trigger via a pull_request event or @enkii on a PR comment.",
      );
    }

    const wantCode =
      dispatch.command === "auto" ||
      dispatch.command === "review" ||
      dispatch.command === "benchmark";
    const wantSecurity =
      dispatch.command === "security" ||
      (dispatch.command === "auto" && runSecurity);
    const benchmarkMode = dispatch.command === "benchmark";

    if (!wantCode && !wantSecurity) {
      console.log("enkii: nothing to run for this dispatch.");
      return;
    }

    const { owner, repo } = context.repository;
    const prBranch = await fetchPRBranchData({
      octokits: octokit,
      repository: { owner, repo },
      prNumber: context.entityNumber,
    });
    if (!prBranch) {
      throw new Error(
        `enkii: could not fetch PR data for #${context.entityNumber}.`,
      );
    }

    console.log(
      `enkii: fetching PR data for ${owner}/${repo}#${context.entityNumber}...`,
    );
    checkoutPullRequestHead({
      prNumber: context.entityNumber,
      headSha: prBranch.headRefOid,
    });
    const reviewArtifacts = await computeReviewArtifacts({
      baseRef: prBranch.baseRefName,
      tempDir: runnerTemp,
      octokit,
      owner,
      repo,
      prNumber: context.entityNumber,
      title: prBranch.title,
      body: prBranch.body,
      githubToken,
      ignoreExistingComments: benchmarkMode,
    });

    if (benchmarkMode) {
      console.log(
        "enkii: benchmark mode enabled; existing PR comments are omitted from the review prompt.",
      );
    }

    const isForkPR = detectForkPR(context);

    const buildContext = (
      skillContent: string,
      includeSuggestions: boolean,
    ): PreparedContext => ({
      repository: `${owner}/${repo}`,
      triggerPhrase: "@enkii",
      githubContext: context,
      prBranchData: {
        headRefName: prBranch.headRefName,
        headRefOid: prBranch.headRefOid,
      },
      reviewArtifacts,
      skillContent,
      includeSuggestions,
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: String(context.entityNumber),
        baseBranch: prBranch.baseRefName,
      },
    });

    const tasks: Promise<RunReviewResult>[] = [];

    if (wantCode) {
      const skill = await loadSkill({
        kind: "review",
        overridePath: reviewSkillPath,
        actionPath,
        workspacePath,
        isForkPR,
      });
      logSkill("review", reviewSkillPath, skill);
      tasks.push(
        runCodeReview({
          preparedContext: buildContext(skill.content, true),
          workingDir: workspacePath,
          reviewModel,
          promptsDir,
          enableValidator,
        }),
      );
    }

    if (wantSecurity) {
      const skill = await loadSkill({
        kind: "security-review",
        overridePath: securitySkillPath,
        actionPath,
        workspacePath,
        isForkPR,
      });
      logSkill("security", securitySkillPath, skill);
      tasks.push(
        runSecurityReview({
          preparedContext: buildContext(skill.content, false),
          workingDir: workspacePath,
          securityModel,
          promptsDir,
          enableValidator,
        }),
      );
    }

    console.log(
      `enkii: running ${tasks.length} review(s) in parallel ` +
        `(validator ${enableValidator ? "on" : "off"})`,
    );
    const results = await Promise.all(tasks);

    for (const result of results) {
      const marker =
        result.kind === "security"
          ? ENKII_SECURITY_MARKER
          : ENKII_REVIEW_MARKER;
      const post = await postReviewFromValidated({
        validated: result.validated,
        octokit: octokit.rest,
        owner,
        repo,
        prNumber: context.entityNumber,
        marker,
        inlineCap: 20,
      });
      console.log(
        `enkii: posted ${result.kind} review #${post.reviewId} — ` +
          `${post.inlinePosted} inline, ${post.summarized} summarized, ` +
          `${post.totalApproved} approved total.`,
      );
      core.setOutput(`${result.kind}_review_id`, String(post.reviewId));
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (octokit && parsedContext) {
      await markTrackingCommentFailed({
        octokit,
        context: parsedContext,
        trackingCommentId,
        errorMessage,
      });
    }
    core.setFailed(`enkii failed: ${errorMessage}`);
    process.exit(1);
  }
}

function logSkill(
  kind: string,
  overridePath: string,
  skill: { source: string; refusedForkOverride?: boolean },
): void {
  if (skill.refusedForkOverride) {
    console.warn(
      `enkii: ignoring ${kind}_skill_path on fork PR; using bundled skill at ${skill.source}`,
    );
  } else if (overridePath) {
    console.log(`enkii: loaded ${kind} skill from override ${skill.source}`);
  } else {
    console.log(`enkii: loaded bundled ${kind} skill from ${skill.source}`);
  }
}

if (import.meta.main) {
  run();
}
