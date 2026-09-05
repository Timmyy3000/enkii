import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import type { Octokits } from "../api/client";
import { computeAndStoreDiff } from "./review-artifacts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 60 * 1024 * 1024,
    },
  ).trim();
}

function fixture(lines = 3) {
  const root = mkdtempSync(join(tmpdir(), "enkii-local-diff-"));
  roots.push(root);
  const origin = join(root, "origin");
  const cwd = join(root, "checkout");
  mkdirSync(origin);
  git(origin, "init", "-b", "main");
  git(origin, "config", "core.autocrlf", "false");
  writeFileSync(join(origin, ".gitattributes"), "*.txt diff=sentinel\n");
  writeFileSync(join(origin, "changed.txt"), "before\n");
  writeFileSync(join(origin, "deleted.txt"), "deleted\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "ancestor");
  const ancestor = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-b", "pr");
  writeFileSync(
    join(origin, "changed.txt"),
    Array.from({ length: lines }, (_, n) => `line-${n}`).join("\n") +
      "\nTAIL-MARKER\n",
  );
  writeFileSync(join(origin, "binary.bin"), Buffer.from([0, 1, 2, 0, 255]));
  writeFileSync(join(origin, "renamed.txt"), "deleted\n");
  rmSync(join(origin, "deleted.txt"));
  git(origin, "add", ".");
  git(origin, "commit", "-m", "PR changes");
  const expectedHeadSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "main");
  writeFileSync(
    join(origin, "base-only.txt"),
    "base change excluded from PR\n",
  );
  git(origin, "add", ".");
  git(origin, "commit", "-m", "diverged base");
  const expectedBaseSha = git(origin, "rev-parse", "HEAD");
  // The branch moves after metadata was read. Only the recorded SHA is authoritative.
  writeFileSync(join(origin, "later.txt"), "later base change\n");
  git(origin, "add", ".");
  git(origin, "commit", "-m", "later base");
  git(root, "clone", "--no-local", origin, cwd);
  git(cwd, "checkout", "--detach", expectedHeadSha);
  let requests = 0;
  const octokit = {
    rest: {
      request: async () => {
        requests++;
        throw Object.assign(new Error("diff exceeds 20000 lines"), {
          status: 406,
        });
      },
    },
  } as unknown as Octokits;
  const options = {
    cwd,
    expectedBaseSha,
    expectedHeadSha,
    octokit,
    owner: "fixture",
    repo: "repo",
    prNumber: 27,
    githubToken: "unused-test-token",
  };
  const run = (overrides = {}, baseRef = "main") =>
    computeAndStoreDiff(baseRef, root, { ...options, ...overrides });
  return {
    root,
    cwd,
    origin,
    ancestor,
    options,
    run,
    requests: () => requests,
  };
}

async function rejectsWithoutArtifact(
  f: ReturnType<typeof fixture>,
  overrides = {},
  message?: string,
) {
  const assertion = expect(f.run(overrides)).rejects;
  if (message) await assertion.toThrow(message);
  else await assertion.toThrow();
  expect(existsSync(join(f.root, "enkii-prompts", "pr.diff"))).toBe(false);
}

describe("verified local diff after GitHub 406", () => {
  test("stores every change above 20,000 lines from immutable divergent commits", async () => {
    const f = fixture(21000);
    const path = await f.run();
    const diff = readFileSync(path, "utf8");
    const expected = execFileSync(
      "git",
      [
        "--no-pager",
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        `${f.ancestor}..${f.options.expectedHeadSha}`,
        "--",
      ],
      { cwd: f.cwd, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
    );
    expect(diff).toBe(expected);
    expect(diff.split("\n").length).toBeGreaterThan(20000);
    expect(diff).toContain("+TAIL-MARKER");
    expect(diff).toContain("deleted file mode");
    expect(diff).toContain("diff --git a/renamed.txt b/renamed.txt");
    expect(diff).not.toContain("rename from");
    expect(diff).toContain("GIT binary patch");
    expect(diff).not.toContain("base-only.txt");
    expect(diff).not.toContain("later.txt");
    expect(f.requests()).toBe(1);
  }, 30000);

  test("rejects a checkout at a different head", async () => {
    const f = fixture();
    git(f.cwd, "checkout", "--detach", f.options.expectedBaseSha);
    await rejectsWithoutArtifact(f, {}, "expected PR head");
  }, 30000);

  test("does not reuse cached base objects after fetch failure", async () => {
    const f = fixture();
    expect(git(f.cwd, "cat-file", "-t", f.options.expectedBaseSha)).toBe(
      "commit",
    );
    git(f.cwd, "remote", "set-url", "origin", join(f.root, "missing-origin"));
    await rejectsWithoutArtifact(f);
  }, 30000);

  test("rejects a base missing from the remote", async () => {
    const f = fixture();
    await rejectsWithoutArtifact(f, { expectedBaseSha: "f".repeat(40) });
  }, 30000);

  test("rejects a base object that is not a commit", async () => {
    const f = fixture();
    const blob = git(f.origin, "rev-parse", "HEAD:later.txt");
    await rejectsWithoutArtifact(f, { expectedBaseSha: blob });
  }, 30000);

  test("rejects unrelated base history", async () => {
    const f = fixture();
    git(f.origin, "checkout", "--orphan", "unrelated");
    git(f.origin, "commit", "-m", "unrelated root");
    await rejectsWithoutArtifact(f, {
      expectedBaseSha: git(f.origin, "rev-parse", "HEAD"),
    });
  }, 30000);

  test("rejects empty local diffs", async () => {
    const f = fixture();
    await rejectsWithoutArtifact(
      f,
      { expectedBaseSha: f.options.expectedHeadSha },
      "empty",
    );
  }, 30000);

  test("rejects shallow clones with full-history guidance", async () => {
    const f = fixture();
    const shallow = join(f.root, "shallow");
    git(
      f.root,
      "clone",
      "--depth=1",
      "--branch=pr",
      pathToFileURL(f.origin).href,
      shallow,
    );
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    await rejectsWithoutArtifact(f, { cwd: shallow }, "fetch-depth: 0");
  }, 30000);

  test("disables external diff, textconv, replacement objects and presentation config", async () => {
    const f = fixture();
    git(f.cwd, "config", "diff.external", "echo external > external-ran");
    git(
      f.cwd,
      "config",
      "diff.sentinel.textconv",
      "echo converted > textconv-ran",
    );
    git(f.cwd, "config", "color.ui", "always");
    git(f.cwd, "config", "diff.relative", "true");
    git(f.cwd, "config", "diff.noprefix", "true");
    git(f.cwd, "config", "diff.renames", "true");
    git(f.cwd, "config", "diff.ignoreSubmodules", "all");
    git(
      f.cwd,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${f.ancestor},dependency`,
    );
    git(f.cwd, "commit", "-m", "add submodule pointer");
    const head = git(f.cwd, "rev-parse", "HEAD");
    git(f.cwd, "replace", head, f.ancestor);
    const diff = readFileSync(
      await f.run({ expectedHeadSha: head }, "main; echo unsafe > branch-ran"),
      "utf8",
    );
    expect(diff).toContain("diff --git a/changed.txt b/changed.txt");
    expect(diff).toContain("+TAIL-MARKER");
    expect(diff).toContain("GIT binary patch");
    expect(diff).toContain(`+Subproject commit ${f.ancestor}`);
    expect(diff).toMatch(/index [0-9a-f]{40}\.\.[0-9a-f]{40}/);
    expect(diff).not.toContain("\u001b[");
    for (const marker of ["external-ran", "textconv-ran", "branch-ran"])
      expect(existsSync(join(f.cwd, marker))).toBe(false);
  }, 30000);

  test("fails closed when local output exceeds the 50 MiB buffer", async () => {
    const f = fixture();
    writeFileSync(
      join(f.cwd, "oversized.txt"),
      "x".repeat(51 * 1024 * 1024) + "\n",
    );
    git(f.cwd, "add", ".");
    git(f.cwd, "commit", "-m", "oversized patch");
    await rejectsWithoutArtifact(f, {
      expectedHeadSha: git(f.cwd, "rev-parse", "HEAD"),
    });
  }, 30000);
});

test("rejects missing or unsafe immutable metadata before running Git", async () => {
  const root = mkdtempSync(join(tmpdir(), "enkii-invalid-sha-"));
  roots.push(root);
  for (const invalid of [
    undefined,
    "main",
    "--output=unsafe",
    "a".repeat(39),
    "a".repeat(40) + "; echo unsafe",
  ]) {
    for (const field of ["expectedBaseSha", "expectedHeadSha"]) {
      await expect(
        computeAndStoreDiff("main", root, {
          cwd: join(root, "not-a-repository"),
          expectedBaseSha: "a".repeat(40),
          expectedHeadSha: "b".repeat(40),
          [field]: invalid,
        }),
      ).rejects.toThrow("full immutable base and head commit SHAs");
    }
  }
  expect(existsSync(join(root, "enkii-prompts", "pr.diff"))).toBe(false);
});
