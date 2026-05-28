#!/usr/bin/env bun
/**
 * Pull bot-review latency from past PRs across docsyde-backend + docsyde-frontend.
 *
 * For each PR + bot pair, computes:
 *   - first_review_lag   = (first review's submittedAt) - (PR createdAt)
 *   - per_commit_lag     = (review's submittedAt) - (associated commit's pushed_at)
 *
 * Bots tracked: greptile-apps, devin-ai-integration, cubic-dev-ai, github-actions
 *
 * Run: bun run scripts/bot-latency-bench.ts
 * Requires `gh` CLI authed.
 */

import { spawnSync } from "child_process";

const BOTS = [
  "greptile-apps",
  "devin-ai-integration",
  "cubic-dev-ai",
  "github-actions",
];

const REPOS_AND_PRS: { repo: string; prs: number[] }[] = [
  { repo: "Docsyde/docsyde-backend", prs: [298, 296, 295, 293, 292] },
  { repo: "Docsyde/docsyde-frontend", prs: [354, 353, 352, 351, 350] },
];

type PRData = {
  number: number;
  createdAt: string;
  reviews: Array<{
    author: { login: string };
    submittedAt: string;
    commit: { oid: string };
  }>;
  comments: Array<{
    author: { login: string };
    createdAt: string;
  }>;
  commits: Array<{
    oid: string;
    committedDate: string;
  }>;
};

function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function fetchPR(repo: string, num: number): PRData {
  const out = gh([
    "pr",
    "view",
    String(num),
    "--repo",
    repo,
    "--json",
    "number,createdAt,reviews,comments,commits",
  ]);
  return JSON.parse(out);
}

function durationMin(fromIso: string, toIso: string): number {
  return (
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000 / 60
  );
}

function fmtMin(min: number): string {
  if (Math.abs(min) < 1) return `${(min * 60).toFixed(0)}s`;
  if (Math.abs(min) < 60) return `${min.toFixed(1)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

type Row = {
  repo: string;
  pr: number;
  bot: string;
  first_review_lag_min: number | null;
  best_commit_to_review_min: number | null;
  median_commit_to_review_min: number | null;
};

const rows: Row[] = [];

for (const { repo, prs } of REPOS_AND_PRS) {
  for (const num of prs) {
    let pr: PRData;
    try {
      pr = fetchPR(repo, num);
    } catch (e) {
      console.error(`skip ${repo}#${num}:`, (e as Error).message);
      continue;
    }

    const commitMap = new Map<string, string>();
    for (const c of pr.commits) commitMap.set(c.oid, c.committedDate);

    for (const bot of BOTS) {
      const botReviews = pr.reviews.filter((r) => r.author.login === bot);
      // Some bots post issue comments, not reviews.
      const botComments = (pr.comments || []).filter(
        (c) => c.author.login === bot,
      );

      // First "review" — earliest of any submittedAt or createdAt for that bot.
      const firstSubmitted =
        botReviews.length > 0
          ? botReviews.map((r) => r.submittedAt).sort()[0]
          : botComments.length > 0
            ? botComments.map((c) => c.createdAt).sort()[0]
            : null;

      const firstReviewLag = firstSubmitted
        ? durationMin(pr.createdAt, firstSubmitted)
        : null;

      // For each review, lag from associated commit's commit-date.
      const perCommitLags: number[] = [];
      for (const r of botReviews) {
        const commitDate = commitMap.get(r.commit.oid);
        if (commitDate) {
          perCommitLags.push(durationMin(commitDate, r.submittedAt));
        }
      }
      perCommitLags.sort((a, b) => a - b);
      const best = perCommitLags[0] ?? null;
      const median =
        perCommitLags.length > 0
          ? perCommitLags[Math.floor(perCommitLags.length / 2)] ?? null
          : null;

      if (firstReviewLag !== null || perCommitLags.length > 0) {
        rows.push({
          repo: repo.replace("Docsyde/", ""),
          pr: num,
          bot,
          first_review_lag_min: firstReviewLag,
          best_commit_to_review_min: best,
          median_commit_to_review_min: median,
        });
      }
    }
  }
}

// Print per-row table.
console.log("");
console.log("Per-PR / per-bot latency (lower is faster):");
console.log("");
const header = [
  "repo".padEnd(20),
  "PR".padStart(4),
  "bot".padEnd(24),
  "first review lag".padEnd(18),
  "best commit→review".padEnd(20),
  "median commit→review",
].join(" │ ");
console.log(header);
console.log("─".repeat(header.length));

for (const r of rows) {
  console.log(
    [
      r.repo.padEnd(20),
      String(r.pr).padStart(4),
      r.bot.padEnd(24),
      (r.first_review_lag_min !== null
        ? fmtMin(r.first_review_lag_min)
        : "—"
      ).padEnd(18),
      (r.best_commit_to_review_min !== null
        ? fmtMin(r.best_commit_to_review_min)
        : "—"
      ).padEnd(20),
      r.median_commit_to_review_min !== null
        ? fmtMin(r.median_commit_to_review_min)
        : "—",
    ].join(" │ "),
  );
}

// Aggregate by bot.
console.log("");
console.log("Aggregate (median across all PR + bot pairs):");
console.log("");
const byBot = new Map<string, Row[]>();
for (const r of rows) {
  if (!byBot.has(r.bot)) byBot.set(r.bot, []);
  byBot.get(r.bot)!.push(r);
}

for (const [bot, botRows] of byBot) {
  const firstLags = botRows
    .map((r) => r.first_review_lag_min)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);
  const commitLags = botRows
    .map((r) => r.best_commit_to_review_min)
    .filter((x): x is number => x !== null)
    .sort((a, b) => a - b);

  const medFirstLag = firstLags[Math.floor(firstLags.length / 2)];
  const medCommitLag = commitLags[Math.floor(commitLags.length / 2)];
  const minCommitLag = commitLags[0];

  console.log(
    `${bot.padEnd(24)} │ first-review median: ${
      medFirstLag !== undefined ? fmtMin(medFirstLag) : "—"
    } (n=${firstLags.length})  │  commit→review best: ${
      minCommitLag !== undefined ? fmtMin(minCommitLag) : "—"
    }, median: ${medCommitLag !== undefined ? fmtMin(medCommitLag) : "—"} (n=${commitLags.length})`,
  );
}
