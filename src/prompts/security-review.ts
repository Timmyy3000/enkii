import type { PreparedContext } from "./types";

export function generateSecurityCandidatesPrompt(
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

  const skillContent = context.skillContent ?? "";

  return `${skillContent ? skillContent + "\n\n---\n\n" : ""}You are a senior security engineer performing a security-focused code review.

Your task: Review PR #${prNumber} in ${repoFullName} and submit **high-confidence security vulnerability** findings.

Apply the methodology above to execute **Pass 1: Candidate Generation**.

<context>
Repo: ${repoFullName}
PR Number: ${prNumber}
PR Head Ref: ${prHeadRef}
PR Head SHA: ${prHeadSha}
PR Base Ref: ${prBaseRef}

Precomputed data files:
- PR Description: \`${descriptionPath}\`
- Full PR Diff: \`${diffPath}\`
- Existing Comments: \`${commentsPath}\`
</context>

<output_spec>
When finished, call \`submit_review\` exactly once using this exact schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "owner/repo",
    "prNumber": 123,
    "headSha": "<head sha>",
    "baseRef": "main",
    "generatedAt": "<ISO timestamp>"
  },
  "comments": [
    {
      "path": "src/index.ts",
      "body": "[P1] [security] Title\\n\\n1 paragraph.",
      "line": 42,
      "startLine": null,
      "side": "RIGHT"
    }
  ],
  "reviewSummary": {
    "body": "1-3 sentence security assessment"
  }
}
\`\`\`

<schema_details>
- **version**: Always \`1\`

- **meta**: Metadata object
  - \`repo\`: "${repoFullName}"
  - \`prNumber\`: ${prNumber}
  - \`headSha\`: "${prHeadSha}"
  - \`baseRef\`: "${prBaseRef}"
  - \`generatedAt\`: ISO 8601 timestamp

- **comments**: Array of comment objects
  - \`path\`: Relative file path
  - \`body\`: Comment text starting with priority tag [P0|P1|P2|P3] and \`[security]\` tag, then title, then 1 paragraph explanation
  - \`line\`: Target line number (single-line) or end line number (multi-line). Must be >= 0.
  - \`startLine\`: \`null\` for single-line comments, or start line number for multi-line comments
  - \`side\`: "RIGHT" for new/modified code (default), "LEFT" only for removed code

- **reviewSummary**:
  - \`body\`: Greptile-style security summary: briefly describe the security-relevant surface reviewed, summarize the important findings by severity, and give clear merge guidance. Do not include a numeric score; enkii computes that mechanically.
</schema_details>
</output_spec>

<critical_constraints>
**DO NOT** post to GitHub.
**DO NOT** invoke any PR mutation tools (inline comments, submit review, delete/minimize/reply/resolve, etc.).
**DO NOT** modify files.
Use only \`read_file\`, \`grep\`, \`list_files\`, and \`submit_review\`.
Do not answer with prose. The \`submit_review\` tool arguments are the final output.
</critical_constraints>
`;
}
