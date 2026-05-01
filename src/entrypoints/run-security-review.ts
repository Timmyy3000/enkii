#!/usr/bin/env bun

/**
 * Action entrypoint for the security-review pipeline.
 * Invoked by action.yml when prepare.ts has dispatched a "security" command.
 *
 * Same shape as run-review.ts but loads security-review.md and uses the
 * security candidate prompt. Outputs go to security_validated.json so
 * code + security runs on the same PR don't collide on disk.
 */

import * as core from "@actions/core";
import { join } from "path";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { loadSkill } from "../skills/loader";
import { runSecurityReview } from "../tag/commands/review";
import type { PreparedContext } from "../prompts/types";

async function run(): Promise<void> {
  try {
    const securityModel = process.env.SECURITY_MODEL || "@preset/enkii";
    const securitySkillPath = process.env.SECURITY_SKILL_PATH || "";
    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const workspacePath = process.env.GITHUB_WORKSPACE || process.cwd();
    const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
    const promptsDir = join(runnerTemp, "enkii-prompts");

    const context = parseGitHubContext();
    if (!isEntityContext(context)) {
      throw new Error(
        "enkii: run-security-review can only execute on PR or issue events.",
      );
    }
    if (!context.isPR) {
      throw new Error(
        "enkii: security review only runs on pull request events. " +
          "Cause: triggering event was not a PR. " +
          "Fix: comment @enkii /security on a PR.",
      );
    }

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);
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
      `enkii: fetching PR data for security review of ${owner}/${repo}#${context.entityNumber}...`,
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

    const isForkPR = detectForkPR(context);

    const skill = await loadSkill({
      kind: "security-review",
      overridePath: securitySkillPath,
      actionPath,
      workspacePath,
      isForkPR,
    });
    if (skill.refusedForkOverride) {
      console.warn(
        `enkii: ignoring security_skill_path on fork PR; using bundled skill at ${skill.source}`,
      );
    } else {
      console.log(`enkii: loaded security skill from ${skill.source}`);
    }

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
      includeSuggestions: false,
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: String(context.entityNumber),
        baseBranch: prBranch.baseRefName,
      },
    };

    const result = await runSecurityReview({
      preparedContext,
      workingDir: workspacePath,
      securityModel,
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
    core.setFailed(`enkii run-security-review failed: ${errorMessage}`);
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
