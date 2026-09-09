import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import {
  ENKII_POLICY_MARKER,
  ENKII_REVIEW_MARKER,
  postReviewFromValidated,
} from ".";
import type { ValidatedPass } from "../runtime/schemas";
import {
  findCheckpoint,
  type ReviewCheckpoint,
} from "../github/data/review-context";

function makeValidated(): ValidatedPass {
  return {
    version: 1,
    meta: {
      repo: "Docsyde/docsyde-backend",
      prNumber: 294,
      headSha: "abc123",
      baseRef: "dev",
    },
    results: [
      {
        status: "approved",
        comment: {
          path: "src/service.ts",
          line: 12,
          startLine: null,
          side: "RIGHT",
          body: "[P1] Valid anchor\n\nThis can be posted inline.",
        },
      },
      {
        status: "approved",
        comment: {
          path: "src/service.ts",
          line: 99,
          startLine: null,
          side: "RIGHT",
          body: "[P1] Invalid anchor\n\nThis must be summarized.",
        },
      },
    ],
    reviewSummary: {
      status: "approved",
      body: "Review summary.",
    },
  };
}

describe("postReviewFromValidated", () => {
  test("checkpoint survives summary fallback with all findings, but never incomplete coverage", async () => {
    const checkpoint: ReviewCheckpoint = {
      version: 1,
      repository: "Docsyde/docsyde-backend",
      prNumber: 294,
      kind: "code",
      base: "b".repeat(40),
      head: "a".repeat(40),
      config: "config",
      findings: [],
    };
    for (const coverageComplete of [true, false, undefined]) {
      const calls: any[] = [];
      const octokit = {
        paginate: async () => [
          {
            filename: "src/service.ts",
            patch: "@@ -10,2 +10,3 @@\n context\n+added\n context",
          },
        ],
        rest: {
          pulls: {
            listFiles() {},
            createReview: async (args: any) => {
              calls.push(args);
              if (args.comments.length)
                throw Object.assign(new Error("line could not be resolved"), {
                  status: 422,
                });
              return { data: { id: 1 } };
            },
          },
        },
      } as unknown as Octokit;
      const validated = makeValidated();
      validated.meta.headSha = checkpoint.head;
      validated.coverageComplete = coverageComplete;
      // A model-supplied marker must never survive as host state.
      validated.reviewSummary!.body += "\n<!-- enkii-checkpoint:ZmFrZQ== -->";
      const post = await postReviewFromValidated({
        validated,
        octokit,
        owner: "Docsyde",
        repo: "docsyde-backend",
        prNumber: 294,
        marker: ENKII_REVIEW_MARKER,
        inlineCap: 20,
        checkpoint,
      });
      expect(post.summarized).toBe(2);
      const body = calls.at(-1).body;
      expect(body).not.toContain("ZmFrZQ==");
      const decoded = findCheckpoint(
        [
          {
            body,
            commit_id: checkpoint.head,
            state: "COMMENTED",
            user: { login: "github-actions[bot]", type: "Bot" },
          },
        ],
        checkpoint,
      );
      if (coverageComplete === true) expect(decoded?.findings).toHaveLength(2);
      else expect(decoded).toBeUndefined();
      if (coverageComplete === false) {
        expect(body).toContain("Coverage: incomplete");
        expect(body).not.toContain(
          "Safe to merge from this review's perspective",
        );
      }
    }
  });
  test("summarizes comments whose lines are not resolvable in the PR patch", async () => {
    const createReviewCalls: unknown[] = [];
    const octokit = {
      paginate: async () => [
        {
          filename: "src/service.ts",
          patch: "@@ -10,2 +10,3 @@\n context\n+added\n context",
        },
      ],
      rest: {
        pulls: {
          listFiles: async () => undefined,
          createReview: async (args: unknown) => {
            createReviewCalls.push(args);
            return { data: { id: 123 } };
          },
        },
      },
    } as unknown as Octokit;

    const result = await postReviewFromValidated({
      validated: makeValidated(),
      octokit,
      owner: "Docsyde",
      repo: "docsyde-backend",
      prNumber: 294,
      marker: ENKII_REVIEW_MARKER,
      inlineCap: 20,
    });

    expect(result.inlinePosted).toBe(1);
    expect(result.summarized).toBe(1);
    expect(createReviewCalls).toHaveLength(1);
    const review = createReviewCalls[0] as {
      comments: Array<{
        path: string;
        body: string;
        side: string;
        line: number;
      }>;
      body: string;
    };
    expect(review.comments).toEqual([
      {
        path: "src/service.ts",
        body: expect.any(String),
        side: "RIGHT",
        line: 12,
      },
    ]);
    expect(review.body).toContain("### Unanchored notes (1)");
    expect(review.body).toContain("Invalid anchor");
  });

  test("preserves full policy findings without a mergeability verdict", async () => {
    const createReviewCalls: unknown[] = [];
    const octokit = {
      paginate: async () => [
        { filename: "src/service.ts", patch: "@@ -10,1 +10,1 @@\n-old\n+new" },
      ],
      rest: {
        pulls: {
          listFiles: async () => undefined,
          createReview: async (args: unknown) => {
            createReviewCalls.push(args);
            return { data: { id: 456 } };
          },
        },
      },
    } as unknown as Octokit;

    await postReviewFromValidated({
      validated: makeValidated(),
      octokit,
      owner: "Docsyde",
      repo: "docsyde-backend",
      prNumber: 294,
      marker: ENKII_POLICY_MARKER,
      inlineCap: 0,
    });

    const review = createReviewCalls[0] as { body: string };
    expect(review.body).toContain("[P1] Valid anchor");
    expect(review.body).toContain("This can be posted inline.");
    expect(review.body).toContain("[P1] Invalid anchor");
    expect(review.body).toContain("This must be summarized.");
    expect(review.body).not.toContain("Mergeability Score");
    expect(review.body).not.toContain("Safe to merge");
  });

  test("preserves full policy findings in unanchored and summary-only retry paths", async () => {
    const createReviewCalls: Array<{ body: string; comments: unknown[] }> = [];
    const octokit = {
      paginate: async () => [
        {
          filename: "src/service.ts",
          patch: "@@ -10,2 +10,3 @@\n context\n+added\n context",
        },
      ],
      rest: {
        pulls: {
          listFiles: async () => undefined,
          createReview: async (args: { body: string; comments: unknown[] }) => {
            createReviewCalls.push(args);
            if (createReviewCalls.length === 1) {
              const error = new Error("line could not be resolved");
              Object.assign(error, { status: 422 });
              throw error;
            }
            return { data: { id: 789 } };
          },
        },
      },
    } as unknown as Octokit;

    await postReviewFromValidated({
      validated: makeValidated(),
      octokit,
      owner: "Docsyde",
      repo: "docsyde-backend",
      prNumber: 294,
      marker: ENKII_POLICY_MARKER,
      inlineCap: 20,
    });

    expect(createReviewCalls).toHaveLength(2);
    const retry = createReviewCalls[1]!;
    expect(retry.comments).toEqual([]);
    expect(retry.body).toContain("This can be posted inline.");
    expect(retry.body).toContain("This must be summarized.");
    expect(retry.body).not.toContain("Mergeability Score");
  });
});
