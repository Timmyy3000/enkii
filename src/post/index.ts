/**
 * Post step — read validated.json from disk and submit a single batched
 * GitHub PR review via octokit. No LLM in this step; the post is mechanical.
 *
 * v0.1 conventions:
 *   - Only items with status === "approved" are posted.
 *   - Cap at 20 inline comments per review; the rest go into the summary
 *     under an "additional notes" section.
 *   - Submits a single PR Review object (not N individual comments) so the
 *     consumer's PR thread has one logical batch from enkii.
 *   - Body of the review = the methodology summary + any spillover comments.
 *   - Event = "COMMENT" (no approve/request-changes — that's a v1 decision).
 */

import { readFile } from "fs/promises";
import type { Octokit } from "@octokit/rest";
import {
  ValidatedPassSchema,
  type ValidatedPass,
  type Candidate,
} from "../runtime/schemas";

export const ENKII_REVIEW_MARKER = "<!-- enkii-review -->";
export const ENKII_SECURITY_MARKER = "<!-- enkii-security-review -->";

export type PostReviewOptions = {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  validatedPath: string;
  /** Marker comment for dedup / "is this a security review thread?" detection. */
  marker: string;
  /** Cap on inline comments. Default 20. Spillover goes into the summary body. */
  inlineCommentCap?: number;
};

export type PostReviewResult = {
  reviewId: number;
  inlinePosted: number;
  summarized: number;
  totalApproved: number;
};

export async function postReviewFromValidatedFile(
  options: PostReviewOptions,
): Promise<PostReviewResult> {
  const { octokit, owner, repo, prNumber, validatedPath, marker } = options;
  const inlineCap = options.inlineCommentCap ?? 20;

  const raw = await readFile(validatedPath, "utf8");
  const parsed = JSON.parse(raw);
  const result = ValidatedPassSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `enkii: validated.json failed schema check at ${validatedPath}. ` +
        `Cause: ${result.error.message}. ` +
        `Fix: this is a bug in enkii's Pass 2 output handling — file an issue with the run link.`,
    );
  }

  return await postReviewFromValidated({
    validated: result.data,
    octokit,
    owner,
    repo,
    prNumber,
    marker,
    inlineCap,
  });
}

export async function postReviewFromValidated(args: {
  validated: ValidatedPass;
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  marker: string;
  inlineCap: number;
}): Promise<PostReviewResult> {
  const { validated, octokit, owner, repo, prNumber, marker, inlineCap } =
    args;

  const approved: Candidate[] = validated.results
    .filter((r) => r.status === "approved")
    .map((r) => (r.status === "approved" ? r.comment : null!))
    .filter(Boolean);

  const inline = approved.slice(0, inlineCap);
  const spillover = approved.slice(inlineCap);

  const headSha = validated.meta.headSha;

  const kind: "code" | "security" =
    marker === ENKII_SECURITY_MARKER ? "security" : "code";

  const summaryBody = buildSummaryBody({
    marker,
    summary: validated.reviewSummary?.body,
    totalApproved: approved.length,
    inlinePosted: inline.length,
    spillover,
    kind,
  });

  const inlineComments = inline.map(toGitHubReviewComment);

  // Submit the review. Event = COMMENT (we don't approve or request changes).
  const review = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: headSha,
    event: "COMMENT",
    body: summaryBody,
    comments: inlineComments,
  });

  return {
    reviewId: review.data.id,
    inlinePosted: inline.length,
    summarized: spillover.length,
    totalApproved: approved.length,
  };
}

function toGitHubReviewComment(c: Candidate) {
  // GitHub's review-comments-on-create supports either a single line or a
  // multi-line range (start_line + line). We surface both shapes.
  const base: {
    path: string;
    body: string;
    side?: "LEFT" | "RIGHT";
    line: number;
    start_line?: number;
    start_side?: "LEFT" | "RIGHT";
  } = {
    path: c.path,
    body: c.body,
    side: c.side ?? "RIGHT",
    line: c.line,
  };
  if (
    c.startLine != null &&
    c.startLine !== undefined &&
    c.startLine !== c.line
  ) {
    base.start_line = c.startLine;
    base.start_side = c.side ?? "RIGHT";
  }
  return base;
}

const ENKII_ICON_URL =
  "https://raw.githubusercontent.com/Timmyy3000/enkii/main/assets/enkii-icon.svg";
const ENKII_REPO_URL = "https://github.com/Timmyy3000/enkii";

function brandedHeader(kind: "code" | "security"): string {
  const label = kind === "security" ? "security review" : "code review";
  return (
    `<a href="${ENKII_REPO_URL}"><img src="${ENKII_ICON_URL}" height="20" align="left" alt="enkii"></a>` +
    `&nbsp;**enkii** &nbsp;·&nbsp; _${label}_`
  );
}

function buildSummaryBody(args: {
  marker: string;
  summary?: string;
  totalApproved: number;
  inlinePosted: number;
  spillover: Candidate[];
  kind?: "code" | "security";
}): string {
  const { marker, summary, totalApproved, spillover, kind = "code" } = args;
  const parts: string[] = [marker, brandedHeader(kind)];

  if (summary) {
    parts.push(summary.trim());
  } else if (totalApproved === 0) {
    parts.push("Reviewed this PR and found no issues to flag.");
  } else {
    parts.push(`Reviewed this PR and posted ${totalApproved} comments.`);
  }

  if (spillover.length > 0) {
    parts.push("");
    parts.push(
      `### Additional notes (${spillover.length} comments above the inline cap)`,
    );
    for (const c of spillover) {
      parts.push(`- **\`${c.path}:${c.line}\`** — ${c.body.split("\n")[0]}`);
    }
  }

  parts.push("");
  parts.push(
    `<sub>Posted by <a href="${ENKII_REPO_URL}">enkii</a> — open-source AI code review. Bring your own OpenRouter key.</sub>`,
  );

  return parts.join("\n\n");
}
