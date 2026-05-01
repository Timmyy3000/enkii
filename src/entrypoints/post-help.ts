#!/usr/bin/env bun

/**
 * Mechanical reply to @enkii / @enkii help / @enkii status. Non-LLM.
 * Just posts a static help comment so the bot has a discoverable surface.
 *
 * Inputs (env):
 *   - OVERRIDE_GITHUB_TOKEN — resolved upstream by prepare.ts
 *   - ENKII_COMMAND — "help" | "status" | "default" (from prepare.ts dispatch)
 */

import * as core from "@actions/core";
import { setupGitHubToken } from "../github/token";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";

const ENKII_ICON_URL =
  "https://raw.githubusercontent.com/Timmyy3000/enkii/main/assets/enkii-icon.svg";
const ENKII_REPO_URL = "https://github.com/Timmyy3000/enkii";

function brandedHeader(label: string): string {
  return (
    `<a href="${ENKII_REPO_URL}"><img src="${ENKII_ICON_URL}" height="20" align="left" alt="enkii"></a>` +
    `&nbsp;**enkii** &nbsp;·&nbsp; _${label}_`
  );
}

const HELP_BODY = `${brandedHeader("help")}

I'm an open-source AI code review bot. You can invoke me on a PR with:

- \`@enkii /review\` — re-run the code review on the latest commit
- \`@enkii /security\` — run a focused security review (separate thread)
- \`@enkii help\` — show this message
- \`@enkii status\` — show the most recent run on this PR

Code review also runs automatically when a PR is opened, synchronized, or reopened.

<sub>Posted by <a href="${ENKII_REPO_URL}">enkii</a> — open-source AI code review. Bring your own OpenRouter key.</sub>`;

const STATUS_BODY = `${brandedHeader("status")}

Live status reporting is coming in a follow-up release. For now, check the **Actions** tab on this repo for the most recent enkii workflow run on this PR.

<sub>Posted by <a href="${ENKII_REPO_URL}">enkii</a> — open-source AI code review.</sub>`;

async function run(): Promise<void> {
  try {
    const command = process.env.ENKII_COMMAND || "default";

    const context = parseGitHubContext();
    if (!isEntityContext(context)) {
      console.log("enkii: not an entity context, skipping help reply.");
      return;
    }

    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);
    const { owner, repo } = context.repository;

    const body = command === "status" ? STATUS_BODY : HELP_BODY;

    const response = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: context.entityNumber,
      body,
    });

    console.log(`enkii: posted ${command} reply (comment id ${response.data.id})`);
    core.setOutput("comment_id", String(response.data.id));
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    core.setFailed(`enkii post-help failed: ${errorMessage}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  run();
}
