#!/usr/bin/env bun

/**
 * Post step entrypoint. Reads validated.json from the path written by
 * run-review.ts and submits a single batched PR Review via octokit.
 *
 * Inputs (env):
 *   - OVERRIDE_GITHUB_TOKEN — resolved upstream by prepare.ts
 *   - VALIDATED_PATH — typically <RUNNER_TEMP>/enkii-prompts/review_validated.json
 *   - ENKII_REVIEW_KIND — "code" | "security" (chooses the marker comment).
 *     Defaults to "code".
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import {
  postReviewFromValidatedFile,
  ENKII_REVIEW_MARKER,
  ENKII_SECURITY_MARKER,
} from "../post";

async function run(): Promise<void> {
  try {
    const validatedPath = process.env.VALIDATED_PATH;
    if (!validatedPath) {
      throw new Error(
        "enkii post-review: VALIDATED_PATH env var is required.",
      );
    }
    const reviewKind = (process.env.ENKII_REVIEW_KIND || "code") as
      | "code"
      | "security";
    const marker =
      reviewKind === "security" ? ENKII_SECURITY_MARKER : ENKII_REVIEW_MARKER;

    const context = parseGitHubContext();
    if (!isEntityContext(context) || !context.isPR) {
      throw new Error(
        "enkii post-review: only runs on pull request events.",
      );
    }

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);
    const { owner, repo } = context.repository;

    const result = await postReviewFromValidatedFile({
      octokit: octokit.rest,
      owner,
      repo,
      prNumber: context.entityNumber,
      validatedPath,
      marker,
    });

    console.log(
      `enkii: posted review #${result.reviewId} — ` +
        `${result.inlinePosted} inline comments, ${result.summarized} summarized, ` +
        `${result.totalApproved} approved total.`,
    );
    core.setOutput("review_id", String(result.reviewId));
    core.setOutput("inline_count", String(result.inlinePosted));
    core.setOutput("approved_count", String(result.totalApproved));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    core.setFailed(`enkii post-review failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
