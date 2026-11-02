#!/usr/bin/env bun
import { existsSync, readdirSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  claudeModelSpec,
  priceUsage,
  promptTokens,
} from "../../src/runtime/claude-models";

type Finding = {
  path: string;
  line?: number | null;
  title?: string;
  body: string;
};
type Lane = {
  kind: string;
  status: string;
  durationMs: number;
  error?: string;
  coverageComplete?: boolean;
  comments?: Finding[];
};
type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: any;
};

const [runsDir, gtPath, ...labels] = process.argv.slice(2);
if (!runsDir || !gtPath || labels.length === 0) {
  console.error(
    "usage: bun scripts/bench/score.ts <runs-dir> <ground-truth.json> <label>...",
  );
  process.exit(2);
}
const groundTruth: Record<string, Finding[]> = JSON.parse(
  await readFile(gtPath, "utf8"),
);
const judgeCache = new Map<string, boolean>();

async function sameIssue(expected: Finding, found: Finding): Promise<boolean> {
  const key = JSON.stringify([expected.body, found.body]);
  if (judgeCache.has(key)) return judgeCache.get(key)!;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 4000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Two code review comments on ${expected.path}. Do they report the same underlying defect, even if worded differently or anchored on nearby lines? Answer YES or NO only.\n\nA:\n${expected.body}\n\nB:\n${found.body}`,
        },
      ],
    }),
  });
  const json = (await response.json()) as {
    content?: { type: string; text?: string }[];
    error?: unknown;
  };
  if (!json.content)
    throw new Error(`judge failed: ${JSON.stringify(json.error)}`);
  const verdict = json.content.some(
    (b) => b.type === "text" && /\bYES\b/.test(b.text ?? ""),
  );
  judgeCache.set(key, verdict);
  return verdict;
}

const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;

for (const label of labels) {
  const dir = join(runsDir, label);
  const runs = readdirSync(dir).filter((d) =>
    existsSync(join(dir, d, "result.json")),
  );
  const rows: string[] = [];
  const totals = {
    lanes: 0,
    failed: 0,
    incomplete: 0,
    wall: [] as number[],
    cost: [] as number[],
    reported: [] as number[],
    output: [] as number[],
    requests: 0,
    over100k: 0,
    findings: 0,
    dupes: 0,
    gtHit: 0,
    gtTotal: 0,
  };
  for (const run of runs.sort()) {
    const result = JSON.parse(
      await readFile(join(dir, run, "result.json"), "utf8"),
    );
    const diagnostics = JSON.parse(
      await readFile(join(dir, run, "diagnostics.json"), "utf8"),
    );
    const spec = claudeModelSpec(result.model)!;
    const turns = diagnostics.events.filter(
      (e: any) => e.phase === "turn" && e.usage,
    );
    const cost = turns.reduce(
      (sum: number, e: any) => sum + priceUsage(spec, e.usage as Usage).total,
      0,
    );
    const reported = diagnostics.events
      .filter((e: any) => e.phase === "pass")
      .reduce((s: number, e: any) => s + (e.usage?.cost?.total ?? 0), 0);
    const over = turns.filter(
      (e: any) => promptTokens(e.usage) > 100_000,
    ).length;
    const output = turns.reduce((s: number, e: any) => s + e.usage.output, 0);
    const lanes: Lane[] = result.lanes;
    const comments = lanes.flatMap((l) =>
      (l.comments ?? []).map((c) => ({ ...c, lane: l.kind })),
    );
    const dupes = comments.filter((c, i) =>
      comments.some(
        (o, j) =>
          j < i &&
          o.lane !== c.lane &&
          o.path === c.path &&
          Math.abs((o.line ?? 0) - (c.line ?? 0)) <= 3,
      ),
    ).length;
    const expected = groundTruth[result.case] ?? [];
    let hits = 0;
    for (const gt of expected) {
      const samePath = comments.filter((c) => c.path === gt.path);
      for (const candidate of samePath)
        if (await sameIssue(gt, candidate)) {
          hits++;
          break;
        }
    }
    totals.lanes += lanes.length;
    totals.failed += lanes.filter((l) => l.status !== "completed").length;
    totals.incomplete += lanes.filter(
      (l) => l.status === "completed" && !l.coverageComplete,
    ).length;
    totals.wall.push(result.wallMs / 1000);
    totals.cost.push(cost);
    totals.reported.push(reported);
    totals.output.push(output);
    totals.requests += turns.length;
    totals.over100k += over;
    totals.findings += comments.length;
    totals.dupes += dupes;
    totals.gtHit += hits;
    totals.gtTotal += expected.length;
    rows.push(
      `| ${run} | ${lanes.map((l) => `${l.kind[0]}:${l.status === "completed" ? (l.coverageComplete ? "ok" : "inc") : "FAIL"}`).join(" ")} | ${Math.round(result.wallMs / 1000)}s | $${cost.toFixed(3)} | $${reported.toFixed(2)} | ${Math.round(output / 1000)}k | ${over}/${turns.length} | ${comments.length} | ${dupes} | ${hits}/${expected.length} |`,
    );
  }
  console.log(`\n### ${label}\n`);
  console.log(
    "| Run | Lanes | Wall | Real cost | Enkii-reported cost | Output tokens | Requests >100K | Findings | Cross-lane dupes | Known bugs found |",
  );
  console.log(
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  console.log(rows.join("\n"));
  console.log(
    `\n**${label} summary.** ${totals.lanes - totals.failed}/${totals.lanes} lanes submitted, ${totals.incomplete} marked incomplete. Mean wall ${mean(totals.wall).toFixed(0)}s, max ${Math.max(...totals.wall).toFixed(0)}s. Mean real cost $${mean(totals.cost).toFixed(3)} per run (enkii reported $${mean(totals.reported).toFixed(2)}). Mean output ${Math.round(mean(totals.output) / 1000)}k tokens. ${totals.over100k}/${totals.requests} requests above 100K prompt. ${totals.findings} findings, ${totals.dupes} cross-lane duplicates. Known bugs found ${totals.gtHit}/${totals.gtTotal}.`,
  );
}
