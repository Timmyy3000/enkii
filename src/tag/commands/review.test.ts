import { describe, expect, test } from "bun:test";
import { reviewArtifactPrefix, reviewRetryCommand } from "./review";

describe("policy review routing", () => {
  test("uses collision-free policy artifacts", () => {
    expect(reviewArtifactPrefix("code")).toBe("review");
    expect(reviewArtifactPrefix("security")).toBe("security");
    expect(reviewArtifactPrefix("policy")).toBe("policy");
  });

  test("does not suggest a nonexistent policy slash command", () => {
    expect(reviewRetryCommand("policy")).toBe(
      "push a new commit or re-run the workflow",
    );
  });
});
