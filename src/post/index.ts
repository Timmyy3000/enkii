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
import { basename } from "path";
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
  const { validated, octokit, owner, repo, prNumber, marker, inlineCap } = args;

  const approved: Candidate[] = validated.results
    .filter((r) => r.status === "approved")
    .map((r) => (r.status === "approved" ? r.comment : null!))
    .filter(Boolean);

  const requestedInline = approved.slice(0, inlineCap);
  const spillover = approved.slice(inlineCap);
  const resolvable = await splitResolvableInlineComments({
    octokit,
    owner,
    repo,
    prNumber,
    candidates: requestedInline,
  });
  const inline = resolvable.inline;
  const unresolved = resolvable.unresolved;

  const headSha = validated.meta.headSha;

  const kind: "code" | "security" =
    marker === ENKII_SECURITY_MARKER ? "security" : "code";

  const summaryBody = buildSummaryBody({
    marker,
    summary: validated.reviewSummary?.body,
    approved,
    totalApproved: approved.length,
    inlinePosted: inline.length,
    spillover,
    unresolved,
    kind,
  });

  const inlineComments = inline.map(toGitHubReviewComment);

  // Submit the review. Event = COMMENT (we don't approve or request changes).
  let review;
  let inlinePosted = 0;
  try {
    review = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: summaryBody,
      comments: inlineComments,
    });
    inlinePosted = inline.length;
  } catch (error) {
    if (!isLineResolutionError(error) || inlineComments.length === 0) {
      throw error;
    }

    console.warn(
      "enkii: GitHub rejected inline anchors; retrying review as summary-only.",
    );
    console.warn(
      `enkii: inline anchor rejection details: requested=${inlineComments.length}, unresolved_precheck=${unresolved.length}, error=${error instanceof Error ? error.message : String(error)}`,
    );
    for (const candidate of inline) {
      console.warn(
        `enkii: rejected inline candidate ${candidate.path}:${candidate.line} side=${candidate.side ?? "RIGHT"} startLine=${candidate.startLine ?? "null"}`,
      );
    }
    review = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: headSha,
      event: "COMMENT",
      body: buildSummaryBody({
        marker,
        summary: validated.reviewSummary?.body,
        approved,
        totalApproved: approved.length,
        inlinePosted: 0,
        spillover,
        unresolved: [...unresolved, ...inline],
        kind,
      }),
      comments: [],
    });
    inlinePosted = 0;
  }

  return {
    reviewId: review.data.id,
    inlinePosted,
    summarized: approved.length - inlinePosted,
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
    body: formatReviewCommentBody(c),
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
  approved: Candidate[];
  totalApproved: number;
  inlinePosted: number;
  spillover: Candidate[];
  unresolved?: Candidate[];
  kind?: "code" | "security";
}): string {
  const {
    marker,
    summary,
    approved,
    totalApproved,
    spillover,
    unresolved = [],
    kind = "code",
  } = args;
  const parts: string[] = [marker, brandedHeader(kind)];
  const incompleteReview = isIncompleteReview(summary);
  const score = computeMergeabilityScore({
    approved,
    totalApproved,
    incompleteReview,
  });

  if (summary) {
    parts.push("### Summary");
    parts.push(summary.trim());
  } else if (totalApproved === 0) {
    parts.push("### Summary");
    parts.push("Reviewed this PR and found no issues to flag.");
  } else {
    parts.push("### Summary");
    parts.push(`Reviewed this PR and posted ${totalApproved} comments.`);
  }

  parts.push(`**Mergeability Score:** ${score}/5`);
  parts.push(buildMergeabilityVerdict(score, totalApproved, incompleteReview));

  if (spillover.length > 0) {
    parts.push("");
    parts.push(
      `### Additional notes (${spillover.length} comments above the inline cap)`,
    );
    for (const c of spillover) {
      parts.push(
        `- **\`${c.path}:${c.line}\`** — ${formatReviewCommentTitle(c)}`,
      );
    }
  }

  if (unresolved.length > 0) {
    parts.push("");
    parts.push(`### Unanchored notes (${unresolved.length})`);
    parts.push(
      "GitHub could not resolve these findings to changed diff lines, so enkii is preserving them in the summary instead of failing the review.",
    );
    for (const c of unresolved) {
      parts.push(
        `- **\`${c.path}:${c.line}\`** — ${formatReviewCommentTitle(c)}`,
      );
    }
  }

  return parts.join("\n\n");
}

type PullFile = {
  filename: string;
  patch?: string | null;
};

async function splitResolvableInlineComments(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  candidates: Candidate[];
}): Promise<{ inline: Candidate[]; unresolved: Candidate[] }> {
  const { octokit, owner, repo, prNumber, candidates } = args;
  if (candidates.length === 0) return { inline: [], unresolved: [] };

  const files = (await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  })) as PullFile[];
  console.log(
    `enkii: fetched ${files.length} changed files for anchor resolution on PR #${prNumber}`,
  );
  const lineMap = new Map(
    files.map((file) => [file.filename, parseResolvablePatchLines(file.patch)]),
  );

  const inline: Candidate[] = [];
  const unresolved: Candidate[] = [];
  const availablePaths = new Set(files.map((f) => f.filename));
  for (const candidate of candidates) {
    const lines = lineMap.get(candidate.path);
    if (isResolvableCandidate(candidate, lines)) {
      inline.push(candidate);
    } else {
      unresolved.push(candidate);
      const pathExists = availablePaths.has(candidate.path);
      const side = candidate.side ?? "RIGHT";
      const details = describeAnchorMismatch(candidate, lines);
      console.warn(
        `enkii: summarizing unresolved inline anchor ${candidate.path}:${candidate.line} side=${side} startLine=${candidate.startLine ?? "null"} pathInDiff=${pathExists} reason=${details}`,
      );
      if (!pathExists) {
        const sameBasename = files
          .filter((f) => basename(f.filename) === basename(candidate.path))
          .slice(0, 3)
          .map((f) => f.filename);
        if (sameBasename.length > 0) {
          console.warn(
            `enkii: candidate path basename matches changed files: ${sameBasename.join(", ")}`,
          );
        }
      }
    }
  }
  console.log(
    `enkii: anchor resolution summary: requested=${candidates.length}, inline=${inline.length}, unresolved=${unresolved.length}`,
  );
  return { inline, unresolved };
}

type ResolvableLines = {
  LEFT: Set<number>;
  RIGHT: Set<number>;
};

function parseResolvablePatchLines(patch?: string | null): ResolvableLines {
  const lines: ResolvableLines = { LEFT: new Set(), RIGHT: new Set() };
  if (!patch) return lines;

  let leftLine = 0;
  let rightLine = 0;
  for (const rawLine of patch.split("\n")) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      leftLine = Number(hunk[1]);
      rightLine = Number(hunk[2]);
      continue;
    }

    if (rawLine.startsWith("+")) {
      lines.RIGHT.add(rightLine);
      rightLine++;
    } else if (rawLine.startsWith("-")) {
      lines.LEFT.add(leftLine);
      leftLine++;
    } else if (rawLine.startsWith(" ")) {
      lines.LEFT.add(leftLine);
      lines.RIGHT.add(rightLine);
      leftLine++;
      rightLine++;
    }
  }
  return lines;
}

function isResolvableCandidate(
  candidate: Candidate,
  lines: ResolvableLines | undefined,
): boolean {
  if (!lines) return false;
  const side = candidate.side ?? "RIGHT";
  const validLines = lines[side];
  if (!validLines.has(candidate.line)) return false;
  if (candidate.startLine == null || candidate.startLine === candidate.line) {
    return true;
  }
  return validLines.has(candidate.startLine);
}

function describeAnchorMismatch(
  candidate: Candidate,
  lines: ResolvableLines | undefined,
): string {
  if (!lines) return "path_not_found_in_changed_files";
  const side = candidate.side ?? "RIGHT";
  const validLines = lines[side];
  if (validLines.size === 0)
    return `side_${side.toLowerCase()}_has_no_patch_lines`;
  if (!validLines.has(candidate.line)) {
    return `line_${candidate.line}_missing_on_${side}_side (min=${minLine(validLines)}, max=${maxLine(validLines)}, count=${validLines.size})`;
  }
  if (candidate.startLine == null || candidate.startLine === candidate.line) {
    return "unknown_mismatch";
  }
  if (!validLines.has(candidate.startLine)) {
    return `start_line_${candidate.startLine}_missing_on_${side}_side (min=${minLine(validLines)}, max=${maxLine(validLines)}, count=${validLines.size})`;
  }
  return "unknown_mismatch";
}

function minLine(lines: Set<number>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const n of lines) {
    if (n < min) min = n;
  }
  return Number.isFinite(min) ? min : -1;
}

function maxLine(lines: Set<number>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (const n of lines) {
    if (n > max) max = n;
  }
  return Number.isFinite(max) ? max : -1;
}

type Severity = "P0" | "P1" | "P2" | "nit";

function getSeverity(c: Candidate): Severity {
  if (c.severity) return c.severity;
  const match = c.body.match(/^\[(P0|P1|P2|nit)\]/i);
  if (!match) return "P2";
  const raw = match[1].toLowerCase();
  return raw === "nit" ? "nit" : (raw.toUpperCase() as Severity);
}

function formatReviewCommentTitle(c: Candidate): string {
  const firstLine = c.body.split("\n")[0]?.trim() ?? "";
  return firstLine
    .replace(/^\[(P0|P1|P2|nit)\]\s*/i, "")
    .replace(/^\[security\]\s*/i, "")
    .trim();
}

function formatReviewCommentBody(c: Candidate): string {
  const severity = getSeverity(c);
  const title = formatReviewCommentTitle(c);
  const bodyWithoutTitle = c.body.split("\n").slice(1).join("\n").trim();
  const badge = severityBadge(severity);
  const heading = title ? `${badge} **${title}**` : badge;
  return bodyWithoutTitle ? `${heading}\n\n${bodyWithoutTitle}` : heading;
}

function severityBadge(severity: Severity): string {
  const color: Record<Severity, string> = {
    P0: "red",
    P1: "orange",
    P2: "yellow",
    nit: "lightgrey",
  };
  return `![${severity}](https://img.shields.io/badge/${severity}-${color[severity]}?style=flat-square)`;
}

function computeMergeabilityScore(args: {
  approved: Candidate[];
  totalApproved: number;
  incompleteReview: boolean;
}): number {
  const { approved, totalApproved, incompleteReview } = args;
  if (incompleteReview) return 1;
  if (totalApproved === 0) return 5;
  const severities = approved.map(getSeverity);
  if (severities.includes("P0")) return 1;
  if (severities.includes("P1")) return 3;
  if (severities.includes("P2")) return 4;
  return 4;
}

function buildMergeabilityVerdict(
  score: number,
  totalApproved: number,
  incompleteReview: boolean,
): string {
  if (incompleteReview) {
    return "Manual review required; enkii could not inspect enough diff context to assess mergeability.";
  }
  if (score === 5) return "Safe to merge from this review's perspective.";
  if (score >= 4) {
    return "Likely mergeable after reviewing the flagged low-risk comments.";
  }
  if (score >= 3) {
    return "Not merge-ready until the flagged correctness issues are addressed.";
  }
  if (totalApproved > 0) {
    return "Do not merge until the blocking findings are fixed.";
  }
  return "Safe to merge from this review's perspective.";
}

function isIncompleteReview(summary?: string): boolean {
  if (!summary) return false;
  return /unable to complete|cannot complete|could not inspect|cannot inspect|manual review required|diff(?: file)? .*too large|without access to .*diff|could not be inspected/i.test(
    summary,
  );
}

function isLineResolutionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const maybeStatus = "status" in error ? error.status : undefined;
  if (maybeStatus !== 422) return false;
  return /line could not be resolved/i.test(error.message);
}
