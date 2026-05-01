#!/usr/bin/env bun

/**
 * Prepare the enkii action: validate env, resolve GitHub token, parse context,
 * check trigger + permissions, dispatch to the tag-execution pipeline.
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { shouldTriggerTag, prepareTagExecution } from "../tag";

function validateEnv(): void {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey || openrouterKey.trim() === "") {
    throw new Error(
      "enkii could not find OPENROUTER_API_KEY. " +
        "Cause: the secret is not set on this repo. " +
        "Fix: Settings → Secrets and variables → Actions → New repository secret " +
        "→ name OPENROUTER_API_KEY, value from https://openrouter.ai/keys",
    );
  }
}

async function run(): Promise<void> {
  try {
    validateEnv();

    const context = parseGitHubContext();

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);

    if (isEntityContext(context)) {
      const githubTokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        githubTokenProvided,
      );
      if (!hasWritePermissions) {
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
    core.setOutput("github_token", githubToken);

    if (!containsTrigger) {
      console.log("No enkii trigger in this event, skipping.");
      return;
    }

    const dispatch = await prepareTagExecution({
      context,
      octokit,
      githubToken,
    });

    console.log(`enkii dispatch: ${dispatch.command}`);
    if (dispatch.reason) {
      console.log(`Reason: ${dispatch.reason}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    core.setFailed(`enkii prepare step failed: ${errorMessage}`);
    core.setOutput("prepare_error", errorMessage);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
