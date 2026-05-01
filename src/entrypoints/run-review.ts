#!/usr/bin/env bun

/**
 * Action entrypoint that runs the actual code review pipeline.
 * Invoked by action.yml after prepare.ts has dispatched a "review" command.
 *
 * Inputs (env):
 *   - OPENROUTER_API_KEY (required by the Codex runtime)
 *   - OVERRIDE_GITHUB_TOKEN (resolved earlier by prepare.ts)
 *   - REVIEW_MODEL — e.g. "@preset/enkii"
 *   - REVIEW_SKILL_PATH — optional consumer override
 *   - GITHUB_ACTION_PATH — set by the runner; bundled skills live here
 *   - GITHUB_WORKSPACE — set by the runner; consumer skill overrides resolve here
 *   - RUNNER_TEMP — set by the runner; artifacts go under <RUNNER_TEMP>/enkii-prompts/
 *
 * Outputs:
 *   - <RUNNER_TEMP>/enkii-prompts/review_candidates.json (Pass 1)
 *   - <RUNNER_TEMP>/enkii-prompts/review_validated.json  (Pass 2 — what post step reads)
 */

import * as core from "@actions/core";
import { join } from "path";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { loadSkill } from "../skills/loader";
import { runCodeReview } from "../tag/commands/review";
import type { PreparedContext } from "../prompts/types";

async function run(): Promise<void> {
  try {
    const reviewModel = process.env.REVIEW_MODEL || "@preset/enkii";
    const reviewSkillPath = process.env.REVIEW_SKILL_PATH || "";
    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const workspacePath = process.env.GITHUB_WORKSPACE || process.cwd();
    const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
    const promptsDir = join(runnerTemp, "enkii-prompts");

    const context = parseGitHubContext();
    if (!isEntityContext(context)) {
      throw new Error(
        "enkii: run-review can only execute on PR or issue events.",
      );
    }
    if (!context.isPR) {
      throw new Error(
        "enkii: code review only runs on pull request events. " +
          "Cause: triggering event was not a PR. " +
          "Fix: trigger via a pull_request event or @enkii /review on a PR comment.",
      );
    }

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    const { owner, repo } = context.repository;

    // Fetch PR branch info (head + base ref + sha + title + body).
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

    // Pre-compute the review artifacts (diff, existing comments, description).
    console.log(
      `enkii: fetching PR data for ${owner}/${repo}#${context.entityNumber}...`,
    );
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
    });

    // Detect fork-PR for skill-loader safety.
    const isForkPR = detectForkPR(context);

    // Load the skill content.
    const skill = await loadSkill({
      kind: "review",
      overridePath: reviewSkillPath,
      actionPath,
      workspacePath,
      isForkPR,
    });
    if (skill.refusedForkOverride) {
      console.warn(
        `enkii: ignoring review_skill_path on fork PR; using bundled skill at ${skill.source}`,
      );
    } else {
      console.log(`enkii: loaded review skill from ${skill.source}`);
    }

    // Build the PreparedContext consumed by candidates.ts + validator.ts.
    const preparedContext: PreparedContext = {
      repository: `${owner}/${repo}`,
      triggerPhrase: "@enkii",
      githubContext: context,
      prBranchData: {
        headRefName: prBranch.headRefName,
        headRefOid: prBranch.headRefOid,
      },
      reviewArtifacts,
      skillContent: skill.content,
      includeSuggestions: true,
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: String(context.entityNumber),
        baseBranch: prBranch.baseRefName,
      },
    };

    const result = await runCodeReview({
      preparedContext,
      workingDir: workspacePath,
      reviewModel,
      promptsDir,
    });

    core.setOutput("candidates_path", result.candidatesPath);
    core.setOutput("validated_path", result.validatedPath);
    core.setOutput(
      "approved_count",
      String(
        result.validated.results.filter((r) => r.status === "approved").length,
      ),
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    core.setFailed(`enkii run-review failed: ${errorMessage}`);
    process.exit(1);
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

if (import.meta.main) {
  run();
}
