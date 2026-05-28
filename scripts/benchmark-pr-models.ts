#!/usr/bin/env bun

import { execFileSync } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import type { Usage } from "@mariozechner/pi-ai";
import { AgentRunError } from "../src/runtime/run-agent";
import { loadSkill } from "../src/skills/loader";
import {
  runCodeReview,
  type RunReviewResult,
} from "../src/tag/commands/review";
import type { PreparedContext } from "../src/prompts/types";

type ModelConfig = {
  label: string;
  model: string;
};

type PullRequestData = {
  number: number;
  title: string;
  body: string | null;
  base: {
    ref: string;
  };
  head: {
    ref: string;
    sha: string;
  };
};

type ModelPricing = {
  prompt: number;
  completion: number;
  inputCacheRead: number;
};

type BenchmarkResult = {
  label: string;
  model: string;
  status: "ok" | "error";
  durationMs: number;
  costUsd: number | null;
  usage: Usage | null;
  findings: Array<{
    path: string;
    line: number;
    title: string;
    body: string;
  }>;
  summary?: string;
  error?: string;
};

const OWNER = process.env.BENCHMARK_OWNER || "Docsyde";
const REPO = process.env.BENCHMARK_REPO || "docsyde-backend";
const PR_NUMBER = Number(process.env.BENCHMARK_PR || "294");
const BACKEND_REPO = resolve(
  process.env.BENCHMARK_REPO_PATH || "../docsyde-backend",
);
const CONCURRENCY = Number(process.env.BENCHMARK_CONCURRENCY || "2");

const DEFAULT_MODELS: ModelConfig[] = [
  { label: "gpt-5.2", model: "openai/gpt-5.2" },
  { label: "kimi-k2.5", model: "moonshotai/kimi-k2.5" },
  { label: "kimi-k2.6", model: "moonshotai/kimi-k2.6" },
  { label: "minimax-m2.7", model: "minimax/minimax-m2.7" },
  { label: "deepseek-v4-pro", model: "deepseek/deepseek-v4-pro" },
  { label: "deepseek-v4-flash", model: "deepseek/deepseek-v4-flash" },
];

function selectedModels(): ModelConfig[] {
  const raw = process.env.BENCHMARK_MODELS?.trim();
  if (!raw) return DEFAULT_MODELS;
  return raw.split(",").map((model) => ({
    label: model.trim().replace(/[^\w.-]+/g, "-"),
    model: model.trim(),
  }));
}

function gh(args: string[], options?: { cwd?: string }): string {
  return execFileSync("gh", args, {
    cwd: options?.cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function safeName(value: string): string {
  return value.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractTitle(body: string): string {
  return body.split("\n", 1)[0]?.trim() || "Untitled finding";
}

function sumUsage(result: RunReviewResult): Usage {
  const usage = emptyUsage();
  addUsage(usage, result.pass1.usage);
  if (result.pass2) addUsage(usage, result.pass2.usage);
  return usage;
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  total.cost.input += usage.cost.input;
  total.cost.output += usage.cost.output;
  total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite;
  total.cost.total += usage.cost.total;
}

async function fetchOpenRouterPricing(
  models: ModelConfig[],
): Promise<Map<string, ModelPricing>> {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) {
    throw new Error(
      `OpenRouter model pricing request failed: ${response.status}`,
    );
  }
  const payload = (await response.json()) as {
    data?: Array<{
      id: string;
      pricing?: {
        prompt?: string;
        completion?: string;
        input_cache_read?: string;
      };
    }>;
  };
  const wanted = new Set(models.map((m) => m.model));
  const prices = new Map<string, ModelPricing>();
  for (const item of payload.data ?? []) {
    if (!wanted.has(item.id)) continue;
    const prompt = Number(item.pricing?.prompt);
    const completion = Number(item.pricing?.completion);
    const inputCacheRead = Number(item.pricing?.input_cache_read ?? prompt);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
      prices.set(item.id, { prompt, completion, inputCacheRead });
    }
  }
  return prices;
}

function estimateCostUsd(
  usage: Usage,
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  return (
    (usage.input + usage.cacheWrite) * pricing.prompt +
    usage.cacheRead * pricing.inputCacheRead +
    usage.output * pricing.completion
  );
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function next(): Promise<void> {
    const current = index++;
    if (current >= items.length) return;
    results[current] = await worker(items[current]);
    await next();
  }

  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, () => next()),
  );
  return results;
}

async function prepareBenchmark(runDir: string) {
  const pr = JSON.parse(
    gh(["api", `repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`]),
  ) as PullRequestData;

  const diff = gh([
    "api",
    `repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`,
    "-H",
    "Accept: application/vnd.github.v3.diff",
  ]);

  const artifactsDir = join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const diffPath = join(artifactsDir, "pr.diff");
  const commentsPath = join(artifactsDir, "existing_comments.json");
  const descriptionPath = join(artifactsDir, "pr_description.txt");
  await writeFile(diffPath, diff);
  await writeFile(
    commentsPath,
    JSON.stringify({ issueComments: [], reviewComments: [] }, null, 2),
  );
  await writeFile(
    descriptionPath,
    `# ${pr.title}\n\n${pr.body ?? ""}`.trim() + "\n",
  );

  const worktreePath = join(runDir, "worktree");
  git(
    ["fetch", "--no-tags", "origin", `refs/pull/${PR_NUMBER}/head`],
    BACKEND_REPO,
  );
  git(["worktree", "add", "--detach", worktreePath, pr.head.sha], BACKEND_REPO);

  const skill = await loadSkill({
    kind: "review",
    actionPath: process.cwd(),
    workspacePath: worktreePath,
    isForkPR: false,
  });

  const preparedContext: PreparedContext = {
    repository: `${OWNER}/${REPO}`,
    triggerPhrase: "@enkii",
    prBranchData: {
      headRefName: pr.head.ref,
      headRefOid: pr.head.sha,
    },
    reviewArtifacts: {
      diffPath,
      commentsPath,
      descriptionPath,
    },
    skillContent: skill.content,
    includeSuggestions: false,
    eventData: {
      eventName: "pull_request",
      isPR: true,
      prNumber: String(PR_NUMBER),
      baseBranch: pr.base.ref,
    },
  };

  return { pr, preparedContext, worktreePath };
}

async function runModel(args: {
  model: ModelConfig;
  preparedContext: PreparedContext;
  worktreePath: string;
  runDir: string;
  pricing: Map<string, ModelPricing>;
}): Promise<BenchmarkResult> {
  const modelDir = join(args.runDir, "models", safeName(args.model.label));
  await mkdir(modelDir, { recursive: true });

  const started = Date.now();
  try {
    const result = await runCodeReview({
      preparedContext: args.preparedContext,
      workingDir: args.worktreePath,
      reviewModel: args.model.model,
      promptsDir: modelDir,
      enableValidator: false,
    });
    const durationMs = Date.now() - started;
    const usage = sumUsage(result);
    const findings = result.validated.results
      .filter((r) => r.status === "approved")
      .map((r) => ({
        path: r.comment.path,
        line: r.comment.line,
        title: extractTitle(r.comment.body),
        body: r.comment.body,
      }));
    const benchmarkResult: BenchmarkResult = {
      label: args.model.label,
      model: args.model.model,
      status: "ok",
      durationMs,
      costUsd: estimateCostUsd(usage, args.pricing.get(args.model.model)),
      usage,
      findings,
      summary: result.validated.reviewSummary?.body,
    };
    await writeFile(
      join(modelDir, "benchmark-result.json"),
      JSON.stringify(benchmarkResult, null, 2),
    );
    return benchmarkResult;
  } catch (error) {
    const durationMs = Date.now() - started;
    const usage = error instanceof AgentRunError ? error.usage : null;
    const benchmarkResult: BenchmarkResult = {
      label: args.model.label,
      model: args.model.model,
      status: "error",
      durationMs,
      costUsd: usage
        ? estimateCostUsd(usage, args.pricing.get(args.model.model))
        : null,
      usage,
      findings: [],
      error: error instanceof Error ? error.message : String(error),
    };
    await writeFile(
      join(modelDir, "benchmark-result.json"),
      JSON.stringify(benchmarkResult, null, 2),
    );
    return benchmarkResult;
  }
}

function renderSummary(results: BenchmarkResult[]): string {
  const lines = [
    "# enkii Local Model Benchmark",
    "",
    `PR: ${OWNER}/${REPO}#${PR_NUMBER}`,
    `Generated: ${new Date().toISOString()}`,
    `OpenRouter routing: sort=price; speed tracked as observed duration.`,
    "",
    "| Model | Status | Findings | Time | Cost USD |",
    "|---|---:|---:|---:|---:|",
  ];

  for (const result of results) {
    const time = `${(result.durationMs / 1000).toFixed(1)}s`;
    const cost =
      result.costUsd == null ? "n/a" : `$${result.costUsd.toFixed(6)}`;
    lines.push(
      `| ${result.model} | ${result.status} | ${result.findings.length} | ${time} | ${cost} |`,
    );
  }

  lines.push("");
  for (const result of results) {
    lines.push(`## ${result.model}`);
    if (result.error) {
      lines.push("");
      lines.push(`Error: ${result.error}`);
      lines.push("");
      continue;
    }
    lines.push("");
    lines.push(result.summary || "No summary.");
    lines.push("");
    if (result.findings.length === 0) {
      lines.push("- No findings.");
    } else {
      for (const finding of result.findings) {
        lines.push(`- ${finding.path}:${finding.line} — ${finding.title}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required.");
  }

  const models = selectedModels();
  const runId =
    process.env.BENCHMARK_RUN_ID ||
    new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = resolve("benchmarks", `backend-pr-${PR_NUMBER}`, runId);
  await mkdir(runDir, { recursive: true });

  console.log(`Benchmark run: ${runDir}`);
  console.log(`Models: ${models.map((m) => m.model).join(", ")}`);
  console.log(`Concurrency: ${CONCURRENCY}`);

  const pricing = await fetchOpenRouterPricing(models);
  const { pr, preparedContext, worktreePath } = await prepareBenchmark(runDir);
  await writeFile(join(runDir, "pr.json"), JSON.stringify(pr, null, 2));
  await writeFile(join(runDir, "models.json"), JSON.stringify(models, null, 2));

  try {
    const results = await runWithConcurrency(models, CONCURRENCY, (model) =>
      runModel({
        model,
        preparedContext,
        worktreePath,
        runDir,
        pricing,
      }),
    );
    await writeFile(
      join(runDir, "results.json"),
      JSON.stringify(results, null, 2),
    );
    await writeFile(join(runDir, "summary.md"), renderSummary(results));
    console.log(renderSummary(results));
  } finally {
    if (process.env.BENCHMARK_KEEP_WORKTREE !== "1") {
      git(["worktree", "remove", "--force", worktreePath], BACKEND_REPO);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
