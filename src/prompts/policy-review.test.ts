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
    expect(prompt).toContain(
      "The Enkii presentation contract below controls summary brevity",
    );
    expect(prompt).not.toContain("enkii computes that mechanically");
  });

  test("keeps policy semantics while requiring compact clean summaries", () => {
    const context = {
      repository: "Timmyy3000/allies-cloud",
      triggerPhrase: "@enkii",
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: "9",
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
    expect(prompt).toContain("repository policy above owns required semantic fields");
    expect(prompt).toContain("Profile: CLOUD");
    expect(prompt).toContain("at most 180 words");
    expect(prompt).toContain("If an earlier P2 is still present on the current head");
    expect(prompt).toContain("Do not replay resolved P2 history");
  });
});
