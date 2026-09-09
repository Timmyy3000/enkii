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
  test("publishes a completed lane while another lane is still pending", async () => {
    let finishSlow!: (value: { kind: "security" }) => void;
    let firstPosted!: () => void;
    const published = new Promise<void>((resolve) => {
      firstPosted = resolve;
    });
    const slow = new Promise<{ kind: "security" }>((resolve) => {
      finishSlow = resolve;
    });
    const posts: string[] = [];
    const result = settleReviewLanes<
      ReviewLaneKind,
      { kind: ReviewLaneKind },
      string
    >(
      [
        { kind: "code", execute: async () => ({ kind: "code" }) },
        { kind: "security", execute: () => slow },
      ],
      async (review) => {
        posts.push(review.kind);
        firstPosted();
        return review.kind;
      },
    );
    try {
      await Promise.race([
        published,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("fast lane was blocked")), 500),
        ),
      ]);
      expect(posts).toEqual(["code"]);
    } finally {
      finishSlow({ kind: "security" });
      await result;
    }
    expect((await result).posted).toHaveLength(2);
  });
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
