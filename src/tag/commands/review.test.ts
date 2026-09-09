import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import {
  assertPriorFindingsRechecked,
  runReview,
  reviewArtifactPrefix,
  reviewRetryCommand,
} from "./review";
import type { CandidatesPass, ValidatedPass } from "../../runtime/schemas";
import type { RunAgentOptions } from "../../runtime/run-agent";
import { runAgent } from "../../runtime/run-agent";
import type { PreparedContext } from "../../prompts/types";

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

const candidate: CandidatesPass = {
  version: 1,
  coverageComplete: true,
  meta: {
    repo: "owner/repo",
    prNumber: 1,
    headSha: "a".repeat(40),
    baseRef: "main",
  },
  comments: [
    {
      path: "prior.ts",
      line: 10,
      startLine: 8,
      side: "RIGHT",
      body: "[P1] Existing risk",
    },
  ],
  priorFindingDispositions: [
    { index: 0, commentIndex: 0, reason: "Still reachable at HEAD" },
  ],
  reviewSummary: { body: "Incremental review: existing risk still present." },
};

describe("incremental review orchestration", () => {
  test("cannot silently omit a prior finding or reference a nonexistent result", () => {
    expect(() => assertPriorFindingsRechecked(candidate, 1)).not.toThrow();
    expect(() =>
      assertPriorFindingsRechecked(
        { ...candidate, priorFindingDispositions: [] },
        1,
      ),
    ).toThrow();
    expect(() =>
      assertPriorFindingsRechecked(
        {
          ...candidate,
          priorFindingDispositions: [
            { index: 0, commentIndex: 3, reason: "Retained" },
          ],
        },
        1,
      ),
    ).toThrow();
    expect(() =>
      assertPriorFindingsRechecked(
        {
          ...candidate,
          priorFindingDispositions: [
            candidate.priorFindingDispositions![0]!,
            candidate.priorFindingDispositions![0]!,
          ],
        },
        2,
      ),
    ).toThrow();
    expect(() =>
      assertPriorFindingsRechecked(
        {
          ...candidate,
          comments: [],
          priorFindingDispositions: [
            {
              index: 0,
              commentIndex: null,
              reason: "Removed the affected entrypoint",
            },
          ],
        },
        1,
      ),
    ).not.toThrow();
  });

  async function reviewWithOutputs(
    pass1: CandidatesPass,
    pass2?: ValidatedPass,
  ) {
    const cwd = await mkdtemp(join(tmpdir(), "enkii-review-flow-"));
    const prompts: string[] = [];
    const context: PreparedContext = {
      repository: "owner/repo",
      triggerPhrase: "@enkii",
      eventData: {
        eventName: "pull_request",
        isPR: true,
        prNumber: "1",
        baseBranch: "main",
      },
      prBranchData: { headRefName: "pr", headRefOid: "a".repeat(40) },
      reviewArtifacts: {
        diffPath: join(cwd, "delta.diff"),
        fullDiffPath: join(cwd, "full.diff"),
        commentsPath: join(cwd, "comments.json"),
        descriptionPath: join(cwd, "description.txt"),
        preparedContext: "prepared evidence",
      },
      reviewScope: "Review incremental delta and prior findings.",
      priorFindingCount: 1,
    };
    const agentRunner = async <T>(options: RunAgentOptions<T>) =>
      runAgent({
        ...options,
        createAgent: () => ({
          subscribe() {
            return () => {};
          },
          async prompt(prompt) {
            prompts.push(String(prompt));
            const output =
              options.outputToolName === "submit_review" ? pass1 : pass2;
            const submit = options.tools.find(
              (t) => t.name === options.outputToolName,
            )!;
            await submit.execute("test-submit", output);
          },
          abort() {},
        }),
      });
    try {
      const result = await runReview({
        kind: "code",
        preparedContext: context,
        workingDir: cwd,
        promptsDir: cwd,
        model: "deepseek/deepseek-v4-pro",
        enableValidator: !!pass2,
        agentRunner,
      });
      return { result, prompts, cwd };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
  const validation = (): ValidatedPass => ({
    version: 1,
    coverageComplete: true,
    meta: candidate.meta,
    results: [{ status: "approved", comment: candidate.comments[0]! }],
    reviewSummary: {
      status: "approved",
      body: "Incremental review: retained finding.",
    },
  });

  test("two-pass review retains old findings and gives validator the full PR diff", async () => {
    const { result, prompts, cwd } = await reviewWithOutputs(
      candidate,
      validation(),
    );
    expect(result.validated.results).toHaveLength(1);
    expect(result.validated.coverageComplete).toBe(true);
    expect(prompts[0]).toContain("prepared evidence");
    expect(prompts[0]).toContain(join(cwd, "delta.diff"));
    expect(prompts[1]).toContain(join(cwd, "full.diff"));
    expect(prompts[1]).toContain(join(cwd, "review_candidates.json"));
    expect(prompts[1]).toContain("Do not reject a retained finding merely");
  });
  test("validation cannot promote missing or incomplete coverage to complete", async () => {
    for (const coverageComplete of [undefined, false]) {
      const { result } = await reviewWithOutputs(
        { ...candidate, coverageComplete },
        validation(),
      );
      expect(result.validated.coverageComplete).toBe(false);
    }
  });
  test("validator omissions and changed multiline anchors fail before posting", async () => {
    await expect(
      reviewWithOutputs(candidate, { ...validation(), results: [] }),
    ).rejects.toThrow("every candidate");
    await expect(
      reviewWithOutputs(candidate, {
        ...validation(),
        results: [
          {
            status: "approved",
            comment: { ...candidate.comments[0]!, startLine: 4 },
          },
        ],
      }),
    ).rejects.toThrow("preserve anchors");
  });
  test("wrong candidate or validator head fails instead of emitting reusable output", async () => {
    await expect(
      reviewWithOutputs({
        ...candidate,
        meta: { ...candidate.meta, headSha: "wrong" },
      }),
    ).rejects.toThrow("assigned PR head");
    await expect(
      reviewWithOutputs(candidate, {
        ...validation(),
        meta: { ...candidate.meta, headSha: "wrong" },
      }),
    ).rejects.toThrow("assigned PR head");
  });
});
