import { expect, test } from "bun:test";
import type { Octokits } from "../api/client";
import { fetchPRBranchData } from "./pr-fetcher";

test("fetchPRBranchData requests and preserves both immutable commit IDs", async () => {
  const data = {
    baseRefName: "main",
    baseRefOid: "a".repeat(40),
    headRefName: "feature",
    headRefOid: "b".repeat(40),
    title: "PR",
    body: "description",
  };
  let query = "";
  const octokits = {
    graphql: async (document: string) => {
      query = document;
      return { repository: { pullRequest: data } };
    },
  } as unknown as Octokits;
  expect(
    await fetchPRBranchData({
      octokits,
      repository: { owner: "owner", repo: "repo" },
      prNumber: 27,
    }),
  ).toEqual(data);
  expect(query).toContain("baseRefOid");
  expect(query).toContain("headRefOid");
});
