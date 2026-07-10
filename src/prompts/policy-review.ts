import type { PreparedContext } from "./types";

export function generatePolicyCandidatesPrompt(
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

  return `<repository_policy_instructions>
${skillContent}
</repository_policy_instructions>

You are performing a repository policy review for PR #${prNumber} in ${repoFullName}.

The repository-owned policy review instructions above define what standards or guides to read, which rules apply, and how the team wants findings and citations written. Follow them completely unless they conflict with the read-only and structured-output constraints below.

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

<reading_requirements>
- You MUST inspect the PR diff before submitting the policy review.
- Use the repository read-only tools to open every guide or supporting file required by the repository policy instructions.
- Use \`read\` with offsets when a required file or diff is truncated.
- Comment only on policy violations introduced or materially worsened by this PR and anchor findings to changed lines.
- If required policy material cannot be read, explain that limitation in \`reviewSummary.body\` instead of claiming compliance.
</reading_requirements>

<output_spec>
When finished, call \`submit_review\` exactly once using this schema:

\`\`\`json
{
  "version": 1,
  "meta": {
    "repo": "${repoFullName}",
    "prNumber": ${prNumber},
    "headSha": "${prHeadSha}",
    "baseRef": "${prBaseRef}",
    "generatedAt": "<ISO timestamp>"
  },
  "comments": [
    {
      "path": "src/index.ts",
      "severity": "P1",
      "body": "<the team's required finding title, citation, and explanation>",
      "line": 42,
      "startLine": null,
      "side": "RIGHT"
    }
  ],
  "reviewSummary": {
    "body": "<the team's required policy review summary>"
  }
}
\`\`\`

- Use \`severity\` as one of \`P0\`, \`P1\`, \`P2\`, or \`nit\` so Enkii can render its mechanical severity badge.
- Write \`body\` and \`reviewSummary.body\` in the format required by the repository policy instructions. Do not rewrite the team's citation or finding format to match generic code-review wording.
- Use \`RIGHT\` for new or modified lines and \`LEFT\` only for removed lines.
</output_spec>

<critical_constraints>
**DO NOT** post to GitHub.
**DO NOT** modify files.
Use only \`read\`, \`grep\`, \`find\`, \`ls\`, \`artifact_paths\`, and \`submit_review\`.
Do not answer with prose. The \`submit_review\` tool arguments are the final output.
</critical_constraints>
`;
}
