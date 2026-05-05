/**
 * Mechanical reply to @enkii / @enkii help / @enkii status. No LLM.
 */

import type { Octokits } from "../github/api/client";
import type { ParsedGitHubContext } from "../github/context";

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

Code review also runs automatically when a PR is opened, synchronized, or reopened.`;

const STATUS_BODY = `${brandedHeader("status")}

Live status reporting is coming in a follow-up release. For now, check the **Actions** tab on this repo for the most recent enkii workflow run on this PR.`;

export type PostHelpCommand = "help" | "status" | "default";

export async function postHelpReply(args: {
  octokit: Octokits;
  context: ParsedGitHubContext;
  command: PostHelpCommand;
}): Promise<{ commentId: number }> {
  const { octokit, context, command } = args;
  const { owner, repo } = context.repository;

  const body = command === "status" ? STATUS_BODY : HELP_BODY;
  const response = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: context.entityNumber,
    body,
  });
  console.log(`enkii: posted ${command} reply (comment id ${response.data.id})`);
  return { commentId: response.data.id };
}
