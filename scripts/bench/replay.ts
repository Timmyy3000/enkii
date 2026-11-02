#!/usr/bin/env bun
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join, resolve } from "path";
import {
  storeDescription,
  storeEmptyComments,
} from "../../src/github/data/review-artifacts";
import {
  prepareIncrementalScope,
  prepareReviewContext,
} from "../../src/github/data/review-context";
import {
  flushDiagnostics,
  initializeDiagnostics,
} from "../../src/runtime/diagnostics";
import { loadRequiredRepositorySkill, loadSkill } from "../../src/skills/loader";
import {
  runCodeReview,
  runPolicyReview,
  runSecurityReview,
  type ReviewKind,
  type RunReviewResult,
} from "../../src/tag/commands/review";
import type { PreparedContext } from "../../src/prompts/types";
import { claimAnchors, type PostedAnchor } from "../../src/post/dedupe";

export type BenchCase = {
  id: string;
  repo: string;
  pr: number;
  head: string;
  baseRef: string;
  /** Base commit recorded on the pull request. Survives the PR merging into its base. */
  base?: string;
  title: string;
  body: string;
};

const [casesPath, caseId, outArg] = process.argv.slice(2);
if (!casesPath || !caseId || !outArg) {
  console.error("usage: bun scripts/bench/replay.ts <cases.json> <case-id> <out-dir>");
  process.exit(2);
}
const cases: BenchCase[] = JSON.parse(await readFile(casesPath, "utf8"));
const benchCase = cases.find((c) => c.id === caseId);
if (!benchCase) throw new Error(`no case ${caseId} in ${casesPath}`);

const outDir = resolve(outArg);
const cacheDir = resolve(process.env.ENKII_BENCH_CACHE ?? join(outDir, "..", ".cache"));
const mirror = join(cacheDir, "repos", benchCase.repo.replace("/", "__"));
const workspace = join(outDir, "workspace");
const tempDir = join(outDir, "tmp");
const promptsDir = join(tempDir, "enkii-prompts");
await mkdir(promptsDir, { recursive: true });

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).trim();

if (!existsSync(mirror)) {
  await mkdir(join(cacheDir, "repos"), { recursive: true });
  execFileSync("gh", ["repo", "clone", benchCase.repo, mirror, "--", "--no-checkout", "-q"], { stdio: "inherit" });
}
try {
  for (const sha of [benchCase.head, benchCase.base].filter(Boolean)) git(mirror, ["cat-file", "-e", `${sha}^{commit}`]);
} catch {
  git(mirror, ["fetch", "-q", "origin", benchCase.head, ...(benchCase.base ? [benchCase.base] : []), `+refs/heads/${benchCase.baseRef}:refs/remotes/origin/${benchCase.baseRef}`]);
}
if (!existsSync(workspace)) git(mirror, ["worktree", "add", "-q", "--detach", workspace, benchCase.head]);
const base = git(mirror, ["merge-base", benchCase.head, benchCase.base ?? `origin/${benchCase.baseRef}`]);
if (base === benchCase.head) throw new Error(`bench: ${benchCase.id} head is already in its base; the diff would be empty`);

const diffPath = join(promptsDir, "pr.diff");
await writeFile(diffPath, git(workspace, ["diff", "--no-ext-diff", base, benchCase.head]) + "\n");
const reviewArtifacts = {
  diffPath,
  commentsPath: await storeEmptyComments(tempDir),
  descriptionPath: await storeDescription(benchCase.title, benchCase.body ?? "", tempDir),
};

initializeDiagnostics({
  enabled: true,
  directory: outDir,
  identity: { repository: benchCase.repo, commit: benchCase.head, workflow: "bench" },
});

const actionPath = resolve(import.meta.dir, "../..");
const reviewModel = process.env.REVIEW_MODEL ?? "claude-haiku-5-5";
const securityModel = process.env.SECURITY_MODEL ?? reviewModel;
const policySkillPath = process.env.POLICY_REVIEW_SKILL_PATH ?? ".enkii/policy-review.md";
const fullContext = await prepareReviewContext(reviewArtifacts, workspace, benchCase.head);

const buildContext = async (kind: ReviewKind, skillContent: string): Promise<PreparedContext> => {
  const scope = await prepareIncrementalScope({
    cwd: workspace,
    head: benchCase.head,
    base,
    artifacts: reviewArtifacts,
    kind,
    promptsDir,
    fallbackReason: "benchmark",
  });
  return {
    repository: benchCase.repo,
    triggerPhrase: "@enkii",
    githubContext: { repository: { owner: benchCase.repo.split("/")[0], repo: benchCase.repo.split("/")[1] } } as never,
    prBranchData: { headRefName: `pr-${benchCase.pr}`, headRefOid: benchCase.head },
    reviewArtifacts: { ...reviewArtifacts, fullDiffPath: diffPath, preparedContext: fullContext },
    skillContent,
    includeSuggestions: kind === "code",
    reviewScope: scope.scope,
    priorFindingCount: 0,
    eventData: { eventName: "pull_request", isPR: true, prNumber: String(benchCase.pr), baseBranch: benchCase.baseRef },
  } as PreparedContext;
};

const skillFor = async (kind: "review" | "security-review") =>
  (await loadSkill({ kind, overridePath: "", actionPath, workspacePath: workspace, isForkPR: false })).content;

const lanes: Record<ReviewKind, () => Promise<RunReviewResult>> = {
  code: async () =>
    runCodeReview({ preparedContext: await buildContext("code", await skillFor("review")), workingDir: workspace, reviewModel, promptsDir }),
  security: async () =>
    runSecurityReview({ preparedContext: await buildContext("security", await skillFor("security-review")), workingDir: workspace, securityModel, promptsDir }),
  policy: async () => {
    const skill = await loadRequiredRepositorySkill({ skillPath: policySkillPath, workspacePath: workspace, label: "policy review skill" });
    return runPolicyReview({ preparedContext: await buildContext("policy", skill.content), workingDir: workspace, policyModel: reviewModel, promptsDir });
  },
};

const kinds = (process.env.BENCH_LANES ?? "code,security,policy").split(",") as ReviewKind[];
const startedAt = Date.now();
const postedAnchors: PostedAnchor[] = [];
const settled = await Promise.all(
  kinds.map(async (kind) => {
    const laneStart = Date.now();
    try {
      const result = await lanes[kind]();
      result.validated = claimAnchors(result.validated, kind, postedAnchors);
      return {
        kind,
        status: "completed",
        durationMs: Date.now() - laneStart,
        coverageComplete: result.validated.coverageComplete,
        comments: result.validated.results.flatMap((r) => (r.status === "approved" ? [r.comment] : [])),
        summary: result.validated.reviewSummary?.body,
      };
    } catch (error) {
      return { kind, status: "failed", durationMs: Date.now() - laneStart, error: error instanceof Error ? error.message : String(error) };
    }
  }),
);
await flushDiagnostics();
await writeFile(
  join(outDir, "result.json"),
  JSON.stringify({ case: benchCase.id, head: benchCase.head, base, model: reviewModel, effort: process.env.ENKII_EFFORT ?? "", wallMs: Date.now() - startedAt, lanes: settled }, null, 2),
);
console.log(`bench: ${benchCase.id} ${settled.map((l) => `${l.kind}=${l.status}`).join(" ")} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
git(mirror, ["worktree", "remove", "--force", workspace]);
