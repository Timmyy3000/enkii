import { describe, expect, test } from "bun:test";
import { generatePolicyCandidatesPrompt } from "./policy-review";
import type { PreparedContext } from "./types";

describe("generatePolicyCandidatesPrompt", () => {
  test("treats the repository skill as policy instructions and preserves team-defined bodies", () => {
    const context = {
      repository: "Docsyde/backend",
      triggerPhrase: "@enkii",
      skillContent: "Read docs/ENGINEERING_STYLE.md and cite rules as DS-##.",
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: "42",
        baseBranch: "main",
      },
      prBranchData: { headRefName: "feature", headRefOid: "abc123" },
      reviewArtifacts: {
        diffPath: "/tmp/pr.diff",
        commentsPath: "/tmp/comments.json",
        descriptionPath: "/tmp/description.txt",
      },
    } satisfies PreparedContext;

    const prompt = generatePolicyCandidatesPrompt(context);
    expect(prompt).toContain(
      "Read docs/ENGINEERING_STYLE.md and cite rules as DS-##.",
    );
    expect(prompt).toContain("repository-owned policy review instructions");
    expect(prompt).toContain('"severity": "P1"');
    expect(prompt).toContain(
      "Do not rewrite the team's citation or finding format",
    );
    expect(prompt).not.toContain("enkii computes that mechanically");
  });
});
