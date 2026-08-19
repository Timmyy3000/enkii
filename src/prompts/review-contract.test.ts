import { describe, expect, test } from "bun:test";
import { generateReviewCandidatesPrompt } from "./candidates";
import { generateSecurityCandidatesPrompt } from "./security-review";
import { generateReviewValidatorPrompt } from "./validator";
import type { PreparedContext } from "./types";

const context = {
  repository: "owner/repo",
  triggerPhrase: "@enkii",
  eventData: {
    eventName: "pull_request",
    isPR: true,
    prNumber: "1",
    baseBranch: "main",
  },
  prBranchData: { headRefName: "feature", headRefOid: "abc123" },
  reviewArtifacts: {
    diffPath: "/tmp/pr.diff",
    commentsPath: "/tmp/comments.json",
    descriptionPath: "/tmp/description.txt",
  },
} satisfies PreparedContext;

describe("review quality contracts", () => {
  test("preserves full code review coverage while narrowing P2 noise", () => {
    const prompt = generateReviewCandidatesPrompt(context);
    expect(prompt).toContain("Apply this gate only to P2 candidates");
    expect(prompt).toContain("preserve the existing P0/P1 search");
    expect(prompt).toContain("same concrete risk is still present");
    expect(prompt).toContain("at most 100 words");
  });

  test("preserves full security review coverage while narrowing P2 noise", () => {
    const prompt = generateSecurityCandidatesPrompt(context);
    expect(prompt).toContain("preserve P0/P1 security detection");
    expect(prompt).toContain("concrete reachable trigger");
    expect(prompt).toContain("A genuinely new regression");
    expect(prompt).toContain("at most 100 words");
  });

  test("makes the validator retain unresolved current-head P2s", () => {
    const prompt = generateReviewValidatorPrompt(context);
    expect(prompt).toContain("Do not reject a");
    expect(prompt).toContain("misleading clean score");
    expect(prompt).toContain("resolved-history replay");
  });
});
