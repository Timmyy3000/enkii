import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { Octokits } from "../api/client";
import { computeAndStoreDiff } from "./review-artifacts";

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
