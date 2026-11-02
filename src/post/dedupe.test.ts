import { describe, expect, test } from "bun:test";
import type { ValidatedPass } from "../runtime/schemas";
import {
  recordPosted,
  serialized,
  withoutPostedDuplicates,
  type PostedAnchor,
} from "./dedupe";

const pass = (
  comments: [string, number, string, ("LEFT" | "RIGHT")?][],
): ValidatedPass => ({
  version: 1,
  coverageComplete: true,
  meta: { repo: "o/r", prNumber: 1, headSha: "a".repeat(40), baseRef: "main" },
  results: comments.map(([path, line, tag, side = "RIGHT"]) => ({
    status: "approved" as const,
    comment: { path, line, side, body: `[${tag}] ${path}:${line}` },
  })),
});

const kept = (validated: ValidatedPass) =>
  validated.results.map((r) =>
    r.status === "approved" ? r.comment.body : "rejected",
  );

const postedBy = (kind: string, validated: ValidatedPass) => {
  const posted: PostedAnchor[] = [];
  recordPosted(validated, kind, posted);
  return posted;
};

describe("withoutPostedDuplicates", () => {
  test("drops a later lane's finding near an equally severe posted one, keeps the rest", () => {
    const posted = postedBy("code", pass([["auth.ts", 40, "P1"]]));
    expect(
      kept(
        withoutPostedDuplicates(
          pass([
            ["auth.ts", 42, "P1"],
            ["auth.ts", 60, "P1"],
            ["other.ts", 40, "P1"],
          ]),
          "policy",
          posted,
        ),
      ),
    ).toEqual(["[P1] auth.ts:60", "[P1] other.ts:40"]);
  });

  test("never drops a more severe finding or one on the other side of the diff", () => {
    const posted = postedBy(
      "code",
      pass([
        ["auth.ts", 40, "P2"],
        ["auth.ts", 80, "P0", "LEFT"],
      ]),
    );
    expect(
      kept(
        withoutPostedDuplicates(
          pass([
            ["auth.ts", 41, "P0"],
            ["auth.ts", 80, "P1", "RIGHT"],
          ]),
          "security",
          posted,
        ),
      ),
    ).toEqual(["[P0] auth.ts:41", "[P1] auth.ts:80"]);
  });

  test("keeps findings from the same lane on neighbouring lines", () => {
    const posted = postedBy("code", pass([["a.ts", 1, "P1"]]));
    expect(
      kept(withoutPostedDuplicates(pass([["a.ts", 2, "P1"]]), "code", posted)),
    ).toEqual(["[P1] a.ts:2"]);
  });
});

describe("serialized", () => {
  test("runs overlapping calls one after another and survives a failure", async () => {
    const events: string[] = [];
    const post = serialized(async (kind: string) => {
      events.push(`start ${kind}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end ${kind}`);
      if (kind === "code") throw new Error("post failed");
      return kind;
    });
    const results = await Promise.allSettled([post("code"), post("security")]);
    expect(events).toEqual([
      "start code",
      "end code",
      "start security",
      "end security",
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });
});
