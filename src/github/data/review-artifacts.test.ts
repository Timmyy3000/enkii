import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Octokits } from "../api/client";
import { computeAndStoreDiff, fetchAndStoreComments } from "./review-artifacts";

describe("computeAndStoreDiff", () => {
  test("uses GitHub PR diff when PR metadata is available", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "enkii-diff-"));
    const diffText =
      "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1,2 @@\n const a = 1;\n+const b = 2;\n";
    const requestedAcceptHeaders: string[] = [];
    const octokit = {
      rest: {
        request: async (
          _route: string,
          options: { headers: { accept: string } },
        ) => {
          requestedAcceptHeaders.push(options.headers.accept);
          return { data: diffText };
        },
      },
    } as unknown as Octokits;

    try {
      const diffPath = await computeAndStoreDiff("dev", tempDir, {
        octokit,
        owner: "Docsyde",
        repo: "docsyde-backend",
        prNumber: 294,
      });

      expect(await readFile(diffPath, "utf8")).toBe(diffText);
      expect(requestedAcceptHeaders).toEqual([
        "application/vnd.github.v3.diff",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("fetchAndStoreComments", () => {
  test("fetches every page for issue and review comments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "enkii-comments-"));
    const issueComments = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      body: `issue-${index + 1}`,
    }));
    const reviewComments = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1001,
      body: `review-${index + 1}`,
    }));
    const issueEndpoint = {};
    const reviewEndpoint = {};
    const paginateCalls: unknown[] = [];
    const octokit = {
      rest: {
        issues: { listComments: issueEndpoint },
        pulls: { listReviewComments: reviewEndpoint },
        paginate: async (endpoint: unknown, params: unknown) => {
          paginateCalls.push({ endpoint, params });
          return endpoint === issueEndpoint ? issueComments : reviewComments;
        },
      },
    } as unknown as Octokits;

    try {
      const commentsPath = await fetchAndStoreComments(
        octokit,
        "Docsyde",
        "backend",
        294,
        tempDir,
      );
      const stored = JSON.parse(await readFile(commentsPath, "utf8"));
      expect(stored.issueComments).toHaveLength(101);
      expect(stored.reviewComments).toHaveLength(101);
      expect(paginateCalls).toHaveLength(2);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
