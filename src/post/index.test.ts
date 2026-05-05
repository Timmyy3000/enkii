import { describe, expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";
import { ENKII_REVIEW_MARKER, postReviewFromValidated } from ".";
import type { ValidatedPass } from "../runtime/schemas";

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
});
