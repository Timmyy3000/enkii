import { describe, expect, test } from "bun:test";
import {
  type ReviewLane,
  type ReviewLaneKind,
  isForkPullRequestPayload,
  selectReviewKinds,
  settleReviewLanes,
} from "./review-lanes";

describe("isForkPullRequestPayload", () => {
  test("does not treat a same-repository PR as a fork when the repository itself is forked", () => {
    expect(
      isForkPullRequestPayload({
        pull_request: {
          head: { repo: { full_name: "Docsyde/enkii", fork: true } },
          base: { repo: { full_name: "Docsyde/enkii" } },
        },
      }),
    ).toBe(false);
  });

  test("detects a cross-repository PR by repository identity", () => {
    expect(
      isForkPullRequestPayload({
        pull_request: {
          head: { repo: { full_name: "contributor/enkii", fork: true } },
          base: { repo: { full_name: "Docsyde/enkii" } },
        },
      }),
    ).toBe(true);
  });
});

describe("selectReviewKinds", () => {
  test("selects policy only for automatic dispatch with a configured path", () => {
    expect(
      selectReviewKinds({
        command: "auto",
        runSecurity: true,
        policySkillPath: ".enkii/policy-review.md",
        isForkPR: false,
      }),
    ).toEqual({
      kinds: ["code", "security", "policy"],
    });
    expect(
      selectReviewKinds({
        command: "auto",
        runSecurity: false,
        policySkillPath: "",
        isForkPR: false,
      }),
    ).toEqual({ kinds: ["code"] });
    for (const command of [
      "review",
      "benchmark",
      "security",
      "help",
      "status",
      "skip",
    ] as const) {
      expect(
        selectReviewKinds({
          command,
          runSecurity: true,
          policySkillPath: ".enkii/policy-review.md",
          isForkPR: false,
        }).kinds,
      ).not.toContain("policy");
    }
  });

  test("skips only policy for fork-owned HEAD prompts", () => {
    expect(
      selectReviewKinds({
        command: "auto",
        runSecurity: true,
        policySkillPath: ".enkii/policy-review.md",
        isForkPR: true,
      }),
    ).toEqual({
      kinds: ["code", "security"],
      policySkippedReason: "fork_prompt",
    });
  });
});

describe("settleReviewLanes", () => {
  test("posts successful lanes after another lane execution fails", async () => {
    const posted: string[] = [];
    const lanes: ReviewLane<
      { kind: ReviewLaneKind; value?: number },
      ReviewLaneKind
    >[] = [
      {
        kind: "code",
        execute: async () => ({ kind: "code" as const, value: 1 }),
      },
      {
        kind: "policy",
        execute: async () => {
          throw new Error("policy failed");
        },
      },
      {
        kind: "security",
        execute: async () => ({ kind: "security" as const, value: 2 }),
      },
    ];
    const result = await settleReviewLanes(lanes, async (review) => {
      posted.push(review.kind);
      return `${review.kind}-posted`;
    });

    expect(posted.sort()).toEqual(["code", "security"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.phase).toBe("execute");
  });

  test("attempts later posts after one GitHub post fails", async () => {
    const attempted: string[] = [];
    const lanes: ReviewLane<{ kind: ReviewLaneKind }, ReviewLaneKind>[] = [
      { kind: "code", execute: async () => ({ kind: "code" as const }) },
      {
        kind: "security",
        execute: async () => ({ kind: "security" as const }),
      },
      { kind: "policy", execute: async () => ({ kind: "policy" as const }) },
    ];
    const result = await settleReviewLanes(lanes, async (review) => {
      attempted.push(review.kind);
      if (review.kind === "security")
        throw new Error("GitHub rejected security");
      return `${review.kind}-posted`;
    });

    expect(attempted.sort()).toEqual(["code", "policy", "security"]);
    expect(result.posted.map((entry) => entry.kind).sort()).toEqual([
      "code",
      "policy",
    ]);
    expect(result.errors).toEqual([
      expect.objectContaining({ kind: "security", phase: "post" }),
    ]);
  });
});
