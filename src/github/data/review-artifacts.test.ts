import { describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "child_process";
import { existsSync } from "fs";
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
        cwd: join(tempDir, "no-repository-needed"),
      });

      expect(await readFile(diffPath, "utf8")).toBe(diffText);
      expect(requestedAcceptHeaders).toEqual([
        "application/vnd.github.v3.diff",
      ]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("preserves gh fallback for API failures other than 406", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "enkii-gh-diff-"));
    const diff = "diff --git a/file b/file\n+change\n";
    const exec = spyOn(childProcess, "execFileSync").mockReturnValue(diff);
    const octokit = {
      rest: {
        request: async () => {
          throw Object.assign(new Error("unavailable"), { status: 503 });
        },
      },
    } as unknown as Octokits;
    try {
      const path = await computeAndStoreDiff("main", tempDir, {
        octokit,
        owner: "owner",
        repo: "repo",
        prNumber: 27,
        githubToken: "test-token",
      });
      expect(await readFile(path, "utf8")).toBe(diff);
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec.mock.calls[0]?.[0]).toBe("gh");
      expect(exec.mock.calls[0]?.[1]).toEqual([
        "pr",
        "diff",
        "27",
        "--repo",
        "owner/repo",
      ]);
    } finally {
      exec.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("406 with missing SHAs fails instead of retrying gh", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "enkii-406-diff-"));
    const exec = spyOn(childProcess, "execFileSync").mockImplementation(() => {
      throw new Error("must not execute");
    });
    const octokit = {
      rest: {
        request: async () => {
          throw Object.assign(new Error("too large"), { status: 406 });
        },
      },
    } as unknown as Octokits;
    try {
      await expect(
        computeAndStoreDiff("main", tempDir, {
          octokit,
          owner: "owner",
          repo: "repo",
          prNumber: 27,
          githubToken: "test-token",
        }),
      ).rejects.toThrow("full immutable");
      expect(exec).not.toHaveBeenCalled();
      expect(existsSync(join(tempDir, "enkii-prompts", "pr.diff"))).toBe(false);
    } finally {
      exec.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("bounds stored API artifacts by UTF-8 bytes without truncation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "enkii-size-diff-"));
    const limit = 50 * 1024 * 1024;
    let diff = "x".repeat(limit);
    const octokit = {
      rest: { request: async () => ({ data: diff }) },
    } as unknown as Octokits;
    const options = { octokit, owner: "owner", repo: "repo", prNumber: 27 };
    try {
      const path = await computeAndStoreDiff("main", tempDir, options);
      expect((await readFile(path)).byteLength).toBe(limit);
      await rm(path);
      diff = "é".repeat(limit / 2 + 1);
      await expect(
        computeAndStoreDiff("main", tempDir, options),
      ).rejects.toThrow("50 MiB");
      expect(existsSync(path)).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);
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
