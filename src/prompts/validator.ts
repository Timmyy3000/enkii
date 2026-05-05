import type { PreparedContext } from "./types";

export function generateReviewValidatorPrompt(
  context: PreparedContext,
): string {
  const prNumber = context.eventData.isPR
    ? context.eventData.prNumber
    : context.githubContext && "entityNumber" in context.githubContext
      ? String(context.githubContext.entityNumber)
      : "unknown";

  const repoFullName = context.repository;
  const prHeadRef = context.prBranchData?.headRefName ?? "unknown";
  const prHeadSha = context.prBranchData?.headRefOid ?? "unknown";
  const prBaseRef = context.eventData.baseBranch ?? "unknown";

  const diffPath =
    context.reviewArtifacts?.diffPath ?? "$RUNNER_TEMP/enkii-prompts/pr.diff";
  const commentsPath =
    context.reviewArtifacts?.commentsPath ??
    "$RUNNER_TEMP/enkii-prompts/existing_comments.json";
  const descriptionPath =
    context.reviewArtifacts?.descriptionPath ??
    "$RUNNER_TEMP/enkii-prompts/pr_description.txt";

  const reviewCandidatesPath =
    process.env.REVIEW_CANDIDATES_PATH ??
    "$RUNNER_TEMP/enkii-prompts/review_candidates.json";
  const includeSuggestions = context.includeSuggestions !== false;

  const passInstruction = includeSuggestions
    ? "Apply the methodology above to execute **Pass 2: Validation** — including suggestion block rules."
    : "Apply the methodology above to execute **Pass 2: Validation**. Do NOT include code suggestion blocks.";

  const skillContent = context.skillContent ?? "";

  return `${skillContent ? skillContent + "\n\n---\n\n" : ""}You are validating candidate review comments for PR #${prNumber} in ${repoFullName}.

IMPORTANT: This is Pass 2 (validator) of a two-pass review pipeline.

${passInstruction}

### Context

* Repo: ${repoFullName}
* PR Number: ${prNumber}
* PR Head Ref: ${prHeadRef}
* PR Head SHA: ${prHeadSha}
* PR Base Ref: ${prBaseRef}

### Inputs

Read these files before validating:
* PR Description: \`${descriptionPath}\`
* Candidates: \`${reviewCandidatesPath}\`
* Full PR Diff: \`${diffPath}\`
* Existing Comments: \`${commentsPath}\`

If the diff is large, use Pi's \`read\` tool with offset/limit chunks. **Do not proceed until you have read enough diff context to validate every candidate.**

### Critical Requirements

1. You MUST read and validate **every** candidate before posting anything.
2. Preserve ordering: keep results in the same order as candidates.
3. **Posting rule (STRICT):** Only post comments where \`status === "approved"\`. Never post rejected items.

### Output: call \`submit_validation\`

When finished, call \`submit_validation\` exactly once using this schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "${repoFullName}",
    "prNumber": ${prNumber},
    "headSha": "${prHeadSha}",
    "baseRef": "${prBaseRef}",
    "validatedAt": "<ISO timestamp>"
  },
  "results": [
    {
      "status": "approved",
      "comment": {
        "path": "src/index.ts",
        "body": "[P1] Title\\n\\n1 paragraph.",
        "line": 42,
        "startLine": null,
        "side": "RIGHT"
      }
    },
    {
      "status": "rejected",
      "candidate": {
        "path": "src/other.ts",
        "body": "[P2] ...",
        "line": 10,
        "startLine": null,
        "side": "RIGHT"
      },
      "reason": "Not a real bug because ..."
    }
  ],
  "reviewSummary": {
    "status": "approved",
    "body": "1-3 sentence overall assessment"
  }
}
\`\`\`

Notes:
* \`results\` MUST have exactly one entry per candidate, in the same order.

Tooling note:
* Use only \`read\`, \`grep\`, \`find\`, \`ls\`, \`artifact_paths\`, and \`submit_validation\`.
* Do not write files. The action writes the validated JSON after your tool call.
* Do not post to GitHub. The action's non-LLM post step submits approved comments via octokit.
* Do not answer with prose. The \`submit_validation\` tool arguments are the final output.
`;
}
