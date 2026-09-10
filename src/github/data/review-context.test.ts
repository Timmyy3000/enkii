import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  encodeCheckpoint,
  checkpointSnapshotMatches,
  findCheckpoint,
  inspectCheckpoint,
  reuseEligibilityReason,
  incrementalDiff,
  prepareIncrementalScope,
  prepareReviewContext,
  reviewConfigHash,
  runtimeFingerprint,
  type ReviewCheckpoint,
  type PostedReview,
} from "./review-context";

const roots: string[] = [];

describe("artifact snapshot", () => {
  const expected = { headRefOid: "a".repeat(40), baseRefOid: "b".repeat(40) };
  test("allows checkpointing only with the same head and base", () => {
    expect(checkpointSnapshotMatches(expected, { ...expected })).toBe(true);
  });
  test("a base move permits the full review but disables checkpoint consumption and creation", () => {
    expect(
      checkpointSnapshotMatches(expected, {
        ...expected,
        baseRefOid: "c".repeat(40),
      }),
    ).toBe(false);
  });
  test("head moves and missing snapshots still stop the review", () => {
    expect(() =>
      checkpointSnapshotMatches(expected, {
        ...expected,
        headRefOid: "c".repeat(40),
      }),
    ).toThrow("PR head");
    expect(() => checkpointSnapshotMatches(expected, null)).toThrow("PR head");
  });
});
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
}
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "enkii-incremental-"));
  roots.push(cwd);
  git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "user.email", "test@example.test");
  git(cwd, "config", "commit.gpgsign", "false");
  const commit = async (name: string, content: string) => {
    await writeFile(join(cwd, name), content);
    git(cwd, "add", "--", name);
    git(cwd, "commit", "-m", "fixture");
    return git(cwd, "rev-parse", "HEAD");
  };
  const base = await commit("service.ts", "export const baseline = 1;\n");
  git(cwd, "checkout", "-b", "pr");
  const prior = await commit("feature.ts", "export const oldFeature = 1;\n");
  const head = await commit("service.ts", "export const baseline = 2;\n");
  const checkpoint: ReviewCheckpoint = {
    version: 1,
    repository: "owner/repo",
    prNumber: 1,
    kind: "code",
    head: prior,
    base,
    config: "config",
    findings: [],
  };
  const artifacts = {
    diffPath: join(cwd, "pr.diff"),
    descriptionPath: join(cwd, "description.txt"),
    commentsPath: join(cwd, "comments.json"),
  };
  await writeFile(artifacts.diffPath, git(cwd, "diff", base, head));
  await writeFile(artifacts.descriptionPath, "Test PR");
  await writeFile(
    artifacts.commentsPath,
    JSON.stringify({ issueComments: [], reviewComments: [] }),
  );
  return { cwd, base, head, prior, commit, checkpoint, artifacts };
}

describe("incremental review scope", () => {
  test("reviews only the new delta and carries every prior finding for recheck", async () => {
    const f = await fixture();
    f.checkpoint.findings = [
      {
        path: "feature.ts",
        line: 1,
        side: "RIGHT",
        body: "[P1] Unresolved defect",
      },
    ];
    const scope = await prepareIncrementalScope({
      ...f,
      kind: "code",
      promptsDir: f.cwd,
    });
    expect(scope.incremental).toBe(true);
    expect(scope.reason).toBe("checkpoint_reused");
    expect(scope.checkpointHead).toBe(f.prior);
    expect(scope.priorFindingCount).toBe(1);
    expect(scope.scope).toContain("Unresolved defect");
    expect(scope.scope).toContain(
      "affected callers/dependencies/contracts/tests",
    );
    const delta = await readFile(scope.diffPath!, "utf8");
    expect(delta).toContain("baseline = 2");
    expect(delta).not.toContain("oldFeature");
    expect(
      incrementalDiff(f.cwd, { ...f.checkpoint, head: f.head }, f.head, f.base),
    ).toBe("");
  });
  test("falls back for changed base, missing history, shallow or mismatched checkout", async () => {
    const f = await fixture();
    expect(() =>
      incrementalDiff(f.cwd, f.checkpoint, f.head, "b".repeat(40)),
    ).toThrow();
    expect(() =>
      incrementalDiff(
        f.cwd,
        { ...f.checkpoint, head: "a".repeat(40) },
        f.head,
        f.base,
      ),
    ).toThrow();
    expect(() =>
      incrementalDiff(f.cwd, f.checkpoint, f.prior, f.base),
    ).toThrow();
    await writeFile(join(f.cwd, ".git", "shallow"), f.base + "\n");
    const scope = await prepareIncrementalScope({
      ...f,
      kind: "code",
      promptsDir: f.cwd,
    });
    expect(scope.incremental).toBe(false);
    expect(scope.reason).toBe("shallow_history");
    expect(scope.checkpointHead).toBe(f.prior);
    expect(scope.diffPath).toBeUndefined();
  });
  test("falls back on divergent history after a force push", async () => {
    const f = await fixture();
    git(f.cwd, "checkout", "-b", "rewritten", f.base);
    const rewritten = await f.commit(
      "service.ts",
      "export const unrelated = 42;\n",
    );
    expect(() =>
      incrementalDiff(f.cwd, f.checkpoint, rewritten, f.base),
    ).toThrow();
  });
  test("falls back when merging the target changes the PR merge base", async () => {
    const f = await fixture();
    git(f.cwd, "checkout", "main");
    const advancedBase = await f.commit(
      "target.ts",
      "export const target = 1;\n",
    );
    git(f.cwd, "checkout", "pr");
    git(f.cwd, "merge", "--no-ff", "main", "-m", "merge target");
    const head = git(f.cwd, "rev-parse", "HEAD");
    expect(() =>
      incrementalDiff(
        f.cwd,
        { ...f.checkpoint, base: advancedBase },
        head,
        advancedBase,
      ),
    ).toThrow("merge base changed");
  });
  test("falls back for changed guides or configuration, including deleted guides", async () => {
    const f = await fixture();
    const head = await f.commit("ENGINEERING.md", "New requirements\n");
    expect(() => incrementalDiff(f.cwd, f.checkpoint, head, f.base)).toThrow(
      "non-source",
    );
    const scope = await prepareIncrementalScope({
      ...f,
      head,
      kind: "code",
      promptsDir: f.cwd,
    });
    expect(scope.reason).toBe("non_source_or_guidance_changed");
    expect(scope.checkpointHead).toBe(f.checkpoint.head);
    expect(scope.incremental).toBe(false);
    git(f.cwd, "rm", "ENGINEERING.md");
    git(f.cwd, "commit", "-m", "remove guide");
    expect(() =>
      incrementalDiff(
        f.cwd,
        { ...f.checkpoint, head },
        git(f.cwd, "rev-parse", "HEAD"),
        f.base,
      ),
    ).toThrow("non-source");
  });
  test("configuration written in source languages still forces a full review", async () => {
    const f = await fixture();
    let previous = f.head;
    for (const path of [
      "vite.config.ts",
      "eslint.config.js",
      ".eslintrc.js",
      "setup.py",
      "scripts/check.ts",
    ]) {
      await mkdir(dirname(join(f.cwd, path)), { recursive: true });
      const head = await f.commit(path, "// changed configuration\n");
      expect(() =>
        incrementalDiff(
          f.cwd,
          { ...f.checkpoint, head: previous },
          head,
          f.base,
        ),
      ).toThrow("configuration");
      previous = head;
    }
  }, 60_000);
});

describe("posted checkpoints", () => {
  const checkpoint: ReviewCheckpoint = {
    version: 1,
    repository: "owner/repo",
    prNumber: 1,
    kind: "code",
    head: "a".repeat(40),
    base: "b".repeat(40),
    config: "config",
    findings: [],
  };
  const review = (): PostedReview => ({
    body: "Review" + encodeCheckpoint(checkpoint),
    commit_id: checkpoint.head,
    state: "COMMENTED",
    user: { login: "github-actions[bot]", type: "Bot" },
  });
  test("explains checkpoint mismatches without rejecting an older compatible checkpoint", () => {
    const newer = {
      ...checkpoint,
      head: "c".repeat(40),
      config: "old configuration",
    };
    const changed = {
      ...review(),
      body: "Review" + encodeCheckpoint(newer),
      commit_id: newer.head,
    };
    expect(inspectCheckpoint([changed], checkpoint)).toEqual({
      reason: "checkpoint_configuration_changed",
      checkpointHead: newer.head,
    });
    expect(
      inspectCheckpoint([review(), changed], checkpoint).checkpoint,
    ).toEqual(checkpoint);
    expect(
      inspectCheckpoint([review()], { ...checkpoint, base: "d".repeat(40) })
        .reason,
    ).toBe("checkpoint_base_changed");
    expect(
      inspectCheckpoint(
        [{ ...review(), commit_id: "d".repeat(40) }],
        checkpoint,
      ).reason,
    ).toBe("checkpoint_commit_mismatch");
    expect(
      inspectCheckpoint(
        [{ ...review(), commit_id: "d".repeat(40) }],
        checkpoint,
      ).checkpointHead,
    ).toBe("d".repeat(40));
    expect(
      inspectCheckpoint([{ ...review(), commit_id: null }], checkpoint)
        .checkpointHead,
    ).toBeUndefined();
    expect(inspectCheckpoint([], checkpoint)).toEqual({
      reason: "no_compatible_checkpoint",
    });
    expect(
      inspectCheckpoint(
        [{ ...review(), user: { type: "User", login: "someone" } }],
        checkpoint,
      ),
    ).toEqual({ reason: "no_compatible_checkpoint" });
  });
  test("round-trips only successfully submitted matching bot reviews", () => {
    expect(findCheckpoint([review()], checkpoint)).toEqual(checkpoint);
    for (const wrong of [
      { state: "PENDING" },
      { state: "DISMISSED" },
      { commit_id: "c".repeat(40) },
      { user: { login: "human", type: "User" } },
      { user: { login: "other[bot]", type: "Bot" } },
      { body: "<!-- enkii-checkpoint:invalid -->" },
    ])
      expect(
        findCheckpoint([{ ...review(), ...wrong }], checkpoint),
      ).toBeUndefined();
    for (const wrong of [
      { kind: "security" as const },
      { base: "c".repeat(40) },
      { config: "changed" },
      { prNumber: 2 },
      { repository: "other/repo" },
    ]) {
      expect(
        findCheckpoint([review()], { ...checkpoint, ...wrong }),
      ).toBeUndefined();
    }
  });
  test("oversized checkpoints disable reuse without losing visible findings", () => {
    expect(
      encodeCheckpoint({
        ...checkpoint,
        findings: [
          { path: "x.ts", line: 1, side: "RIGHT", body: "x".repeat(24000) },
        ],
      }),
    ).toBe("");
  });
  test("custom GitHub App checkpoints match the posting bot's immutable identity", () => {
    const custom = {
      ...review(),
      user: { id: 123, login: "custom-enkii[bot]", type: "Bot" },
    };
    expect(findCheckpoint([custom], checkpoint, 123)).toEqual(checkpoint);
    expect(findCheckpoint([custom], checkpoint, 456)).toBeUndefined();
    expect(findCheckpoint([review()], checkpoint, 123)).toBeUndefined();
  });
  test("model, prompt, validator and runtime changes invalidate configuration", () => {
    const original = reviewConfigHash("skill", "model", false, "runtime");
    expect(reviewConfigHash("changed", "model", false, "runtime")).not.toBe(
      original,
    );
    expect(reviewConfigHash("skill", "new-model", false, "runtime")).not.toBe(
      original,
    );
    expect(reviewConfigHash("skill", "model", true, "runtime")).not.toBe(
      original,
    );
    expect(reviewConfigHash("skill", "model", false, "new-runtime")).not.toBe(
      original,
    );
  });
  test("lockfile-only dependency changes invalidate the runtime fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "enkii-fingerprint-"));
    roots.push(root);
    const sourceRoot = join(import.meta.dir, "../..");
    await cp(sourceRoot, join(root, "src"), { recursive: true });
    await copyFile(
      join(sourceRoot, "../package.json"),
      join(root, "package.json"),
    );
    await copyFile(join(sourceRoot, "../bun.lock"), join(root, "bun.lock"));
    const original = await runtimeFingerprint(root);
    await writeFile(join(root, "bun.lock"), "updated dependency resolution");
    expect(await runtimeFingerprint(root)).not.toBe(original);
  });
});

describe("incremental eligibility diagnostics", () => {
  test("full scope retains the rejected checkpoint and gate reason without reading Git", async () => {
    const scope = await prepareIncrementalScope({
      cwd: "does-not-exist",
      head: "a".repeat(40),
      base: "b".repeat(40),
      kind: "code",
      promptsDir: "does-not-exist",
      artifacts: {
        diffPath: "full.diff",
        descriptionPath: "description.txt",
        commentsPath: "comments.json",
      },
      fallbackReason: "checkpoint_configuration_changed",
      checkpointHead: "c".repeat(40),
    });
    expect(scope.incremental).toBe(false);
    expect(scope.reason).toBe("checkpoint_configuration_changed");
    expect(scope.checkpointHead).toBe("c".repeat(40));
    expect(scope.diffPath).toBeUndefined();
  });
  const eligible = {
    enabled: true,
    snapshotSafe: true,
    benchmark: false,
    fork: false,
    command: "auto",
    eventAction: "synchronize",
    runtime: "fingerprint",
    actorId: 42,
    lookupFailed: false,
  };
  test("eligible updates have no gate rejection", () => {
    expect(reuseEligibilityReason(eligible)).toBeUndefined();
  });
  test.each([
    [{ enabled: false }, "incremental_disabled"],
    [{ snapshotSafe: false }, "base_moved_during_preparation"],
    [{ benchmark: true }, "benchmark_full_review"],
    [{ fork: true }, "fork_full_review"],
    [{ command: "review" }, "explicit_full_review"],
    [{ eventAction: "opened" }, "event_not_synchronize"],
    [{ runtime: "" }, "runtime_unavailable"],
    [{ actorId: undefined }, "posting_identity_unavailable"],
    [{ lookupFailed: true }, "checkpoint_lookup_failed"],
  ] as const)("reports gate %j as %s", (override, reason) => {
    expect(reuseEligibilityReason({ ...eligible, ...override })).toBe(reason);
  });
});

describe("prepared context", () => {
  test("bounds excerpts, retains artifact paths and includes changed-hunk source", async () => {
    const f = await fixture();
    await writeFile(f.artifacts.descriptionPath, "description".repeat(2000));
    const source = Array.from(
      { length: 150 },
      (_, i) => `export const line${i + 1} = ${i + 1};`,
    ).join("\n");
    const head = await f.commit("service.ts", source);
    await writeFile(
      f.artifacts.diffPath,
      "diff --git a/service.ts b/service.ts\n--- a/service.ts\n+++ b/service.ts\n@@ -100,1 +100,1 @@\n-old\n+new\n" +
        " context\n".repeat(3000),
    );
    await writeFile(
      f.artifacts.commentsPath,
      JSON.stringify({
        reviewComments: [
          {
            id: 1,
            path: "service.ts",
            line: 100,
            body: "finding",
            user: { login: "author", avatar_url: "unused" },
          },
        ],
      }),
    );
    const prepared = await prepareReviewContext(f.artifacts, f.cwd, head);
    expect(prepared.length).toBeLessThan(44000);
    expect(prepared).toContain("Excerpt incomplete");
    expect(prepared).toContain(f.artifacts.diffPath);
    expect(prepared).toContain("100: export const line100");
    expect(prepared).toContain('"body":"finding"');
    expect(prepared).not.toContain("avatar_url");
  });
});
