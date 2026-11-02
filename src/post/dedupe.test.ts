import { describe, expect, test } from "bun:test";
import type { ValidatedPass } from "../runtime/schemas";
import { claimAnchors, type PostedAnchor } from "./dedupe";

const pass = (comments: [string, number][]): ValidatedPass => ({
  version: 1,
  coverageComplete: true,
  meta: { repo: "o/r", prNumber: 1, headSha: "a".repeat(40), baseRef: "main" },
  results: comments.map(([path, line]) => ({
    status: "approved" as const,
    comment: { path, line, side: "RIGHT" as const, body: `[P1] ${path}:${line}` },
  })),
});

const anchors = (validated: ValidatedPass) =>
  validated.results.map((r) => (r.status === "approved" ? `${r.comment.path}:${r.comment.line}` : "rejected"));

describe("claimAnchors", () => {
  test("drops a later lane's finding near a line another lane already flagged", () => {
    const posted: PostedAnchor[] = [];
    expect(anchors(claimAnchors(pass([["auth.ts", 40]]), "code", posted))).toEqual(["auth.ts:40"]);
    expect(
      anchors(claimAnchors(pass([["auth.ts", 42], ["auth.ts", 60], ["other.ts", 40]]), "policy", posted)),
    ).toEqual(["auth.ts:60", "other.ts:40"]);
  });

  test("keeps findings from the same lane on neighbouring lines", () => {
    expect(anchors(claimAnchors(pass([["a.ts", 1], ["a.ts", 2]]), "code", []))).toEqual(["a.ts:1", "a.ts:2"]);
  });
});
