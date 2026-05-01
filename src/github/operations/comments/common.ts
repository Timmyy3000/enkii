import { GITHUB_SERVER_URL } from "../../api/config";

const ENKII_ICON_URL =
  "https://raw.githubusercontent.com/Timmyy3000/enkii/main/assets/enkii-icon.svg";
const ENKII_REPO_URL = "https://github.com/Timmyy3000/enkii";

function brandedHeader(label: string): string {
  return (
    `<a href="${ENKII_REPO_URL}"><img src="${ENKII_ICON_URL}" height="20" align="left" alt="enkii"></a>` +
    `&nbsp;**enkii** &nbsp;·&nbsp; _${label}_`
  );
}

export function createJobRunLink(
  owner: string,
  repo: string,
  runId: string,
): string {
  const jobRunUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${runId}`;
  return `[View job run](${jobRunUrl})`;
}

export function createBranchLink(
  owner: string,
  repo: string,
  branchName: string,
): string {
  const branchUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/tree/${branchName}`;
  return `\n[View branch](${branchUrl})`;
}

export type CommentType = "default" | "security" | "review_and_security";

export function createCommentBody(
  jobRunLink: string,
  branchLink: string = "",
  type: CommentType = "default",
): string {
  let label: string;
  let message: string;
  if (type === "review_and_security") {
    label = "code + security review";
    message = "Reviewing code and running a security check…";
  } else if (type === "security") {
    label = "security review";
    message = "Running a security check…";
  } else {
    label = "code review";
    message = "Working on this PR…";
  }

  return `${brandedHeader(label)}

${message}

${jobRunLink}${branchLink}`;
}
