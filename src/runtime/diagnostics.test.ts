import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flushDiagnostics,
  initializeDiagnostics,
  recordDiagnostic,
} from "./diagnostics";

const originalToken = process.env.TEST_DIAGNOSTIC_TOKEN;
const originalSummary = process.env.GITHUB_STEP_SUMMARY;

afterEach(() => {
  if (originalToken === undefined) delete process.env.TEST_DIAGNOSTIC_TOKEN;
  else process.env.TEST_DIAGNOSTIC_TOKEN = originalToken;
  if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  initializeDiagnostics({ enabled: false, directory: "" });
});

test("writes a bounded, redacted artifact and summary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-"));
  const summary = join(directory, "summary.md");
  await Bun.write(summary, "");
  process.env.GITHUB_STEP_SUMMARY = summary;
  process.env.TEST_DIAGNOSTIC_TOKEN = "private-token-value";
  initializeDiagnostics({ enabled: true, directory, identity: { sha: "abc" } });
  recordDiagnostic({
    kind: "code",
    pass: "candidate",
    phase: "execute",
    scope: "incremental",
    model: "model-id",
    status: "failed",
    error: "request private-token-value failed",
    prompt: "must not appear",
    toolArgs: { secret: "must not appear" },
    metrics: { durationMs: 25, ignored: "text" },
    toolDurationMs: 4,
    modelDurationMs: 20,
    repairCount: 1,
    usage: { totalTokens: 123, cost: { total: 0.1 } },
    payload: { accepted: false, candidateCount: 2, body: "must not appear" },
  });
  await flushDiagnostics();

  const artifact = await readFile(join(directory, "diagnostics.json"), "utf8");
  expect(artifact).toContain("[REDACTED]");
  expect(artifact).toContain('"candidateCount": 2');
  expect(artifact).not.toContain("must not appear");
  const renderedSummary = await readFile(summary, "utf8");
  expect(renderedSummary).toContain(
    "| code | candidate | execute | incremental |",
  );
  expect(renderedSummary).toContain("failed");
  expect(renderedSummary).toContain("123");
  expect(renderedSummary).toContain("request \\[REDACTED\\] failed");
});

test("retains structured submissions only when explicitly enabled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-"));
  initializeDiagnostics({ enabled: true, directory, payloads: true });
  recordDiagnostic({
    kind: "code",
    payload: { accepted: false, body: "rejected body" },
  });
  await flushDiagnostics();
  expect(await readFile(join(directory, "diagnostics.json"), "utf8")).toContain(
    "rejected body",
  );
});

test("preserves prior finding indices and null references without retaining source text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-"));
  initializeDiagnostics({ enabled: true, directory });
  recordDiagnostic({
    kind: "code",
    phase: "submission",
    payload: {
      comments: [{ body: "private source", path: "private.ts" }],
      priorFindingDispositions: [
        { index: 0, commentIndex: null, reason: "private source" },
        { index: 1, commentIndex: 7, reason: "" },
      ],
      "private source": 123,
    },
  });
  await flushDiagnostics();
  const text = await readFile(join(directory, "diagnostics.json"), "utf8");
  const payload = JSON.parse(text).events[0].submission;
  expect(payload.commentCount).toBe(1);
  expect(payload.priorFindingDispositions).toEqual([
    { index: 0, commentIndex: null, reasonPresent: true },
    { index: 1, commentIndex: 7, reasonPresent: false },
  ]);
  expect(text).not.toContain("private");
});

test("summary retains successful lanes alongside failures and escapes model-provided formatting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-"));
  const summary = join(directory, "summary.md");
  process.env.GITHUB_STEP_SUMMARY = summary;
  initializeDiagnostics({
    enabled: true,
    directory,
    identity: { reviewedHead: "abc" },
  });
  recordDiagnostic({
    kind: "security",
    phase: "post",
    status: "completed",
    coverage: "complete",
    durationMs: 5,
  });
  recordDiagnostic({
    kind: "code",
    phase: "execute",
    status: "failed",
    error: "missing finding ![image](https://example.com) <img>",
  });
  await flushDiagnostics();
  const text = await readFile(summary, "utf8");
  expect(text).toContain("security");
  expect(text).toContain("completed");
  expect(text).toContain("missing finding");
  expect(text).not.toContain("![image]");
  expect(text).not.toContain("<img>");
});

test("opt-in payloads redact secret keys and values and enforce size bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-"));
  process.env.TEST_DIAGNOSTIC_TOKEN = "secret-value";
  initializeDiagnostics({ enabled: true, directory, payloads: true });
  recordDiagnostic({ payload: { "secret-value": "secret-value" } });
  recordDiagnostic({
    payload: {
      comments: Array.from({ length: 100 }, () => ({ body: "x".repeat(500) })),
    },
  });
  await flushDiagnostics();
  const text = await readFile(join(directory, "diagnostics.json"), "utf8");
  expect(text).not.toContain("secret-value");
  expect(JSON.parse(text).events[1].submission.truncated).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThan(20_000);
});

test("entrypoint flushes diagnostics and retains failure exit status on setup failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "enkii-diagnostics-entry-"));
  const summary = join(directory, "summary.md");
  const outputs = join(directory, "outputs.txt");
  await Bun.write(outputs, "");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../entrypoints/main.ts")],
    {
      env: {
        ...process.env,
        OPENROUTER_API_KEY: "",
        ENKII_DIAGNOSTICS: "true",
        ENKII_DIAGNOSTIC_PAYLOADS: "false",
        ENKII_DIAGNOSTICS_DIR: directory,
        GITHUB_STEP_SUMMARY: summary,
        GITHUB_OUTPUT: outputs,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  expect(await child.exited).toBe(1);
  const artifact = JSON.parse(
    await readFile(join(directory, "diagnostics.json"), "utf8"),
  );
  expect(
    artifact.events.some(
      (event: Record<string, unknown>) =>
        event.phase === "action" && event.status === "failed",
    ),
  ).toBe(true);
  expect(await readFile(summary, "utf8")).toContain("OPENROUTER");
}, 60_000);
