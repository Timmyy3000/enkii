import { describe, expect, test } from "bun:test";
import { generateReviewCandidatesPrompt } from "./candidates";
import { generateSecurityCandidatesPrompt } from "./security-review";
import type { PreparedContext } from "./types";

function buildContext(): PreparedContext {
  return {
    repository: "Docsyde/docsyde-backend",
    eventData: {
      isPR: true,
      prNumber: 316,
      baseBranch: "main",
    },
    prBranchData: {
      headRefName: "feature/fix",
      headRefOid: "0336f63489a64f830bb75dafb926abe408d7095f",
    },
    githubContext: undefined,
    reviewArtifacts: {
      diffPath: "/tmp/pr.diff",
      commentsPath: "/tmp/existing_comments.json",
      descriptionPath: "/tmp/pr_description.txt",
    },
    skillContent: "",
    includeSuggestions: true,
  };
}

describe("review prompts", () => {
  test("code review prompt requires submit_review without forbidding it", () => {
    const prompt = generateReviewCandidatesPrompt(buildContext());

    expect(prompt).toContain("call `submit_review` exactly once");
    expect(prompt).toContain(
      "The local `submit_review` tool is required and is not a GitHub mutation.",
    );
    expect(prompt).not.toContain("submit review, delete/minimize/reply/resolve");
  });

  test("security review prompt requires submit_review without forbidding it", () => {
    const prompt = generateSecurityCandidatesPrompt(buildContext());

    expect(prompt).toContain("call `submit_review` exactly once");
    expect(prompt).toContain(
      "The local `submit_review` tool is required and is not a GitHub mutation.",
    );
    expect(prompt).not.toContain("submit review, delete/minimize/reply/resolve");
  });
});
