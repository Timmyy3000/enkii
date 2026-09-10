import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_EVENTS = 200;
const MAX_TEXT = 512;
const MAX_PAYLOAD_BYTES = 16 * 1024;

type DiagnosticState = {
  enabled: boolean;
  directory: string;
  payloads: boolean;
  identity: Record<string, string>;
  events: Record<string, unknown>[];
};

let state: DiagnosticState | undefined;

export function initializeDiagnostics(options: {
  enabled: boolean;
  directory: string;
  payloads?: boolean;
  identity?: Record<string, string | undefined>;
}): void {
  state = {
    enabled: options.enabled,
    directory: options.directory,
    payloads: options.payloads ?? false,
    identity: Object.fromEntries(
      Object.entries(options.identity ?? {}).filter(
        (entry): entry is [string, string] => Boolean(entry[1]),
      ),
    ),
    events: [],
  };
}

export function updateDiagnosticsIdentity(
  identity: Record<string, string | undefined>,
): void {
  if (!state) return;
  Object.assign(
    state.identity,
    Object.fromEntries(
      Object.entries(identity).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    ),
  );
}

/** Records bounded operational metadata. Prompts, tool arguments, and env values are never retained. */
export function recordDiagnostic(event: Record<string, unknown>): void {
  if (!state?.enabled || state.events.length >= MAX_EVENTS) return;
  try {
    state.events.push(sanitizeEvent(event, state.payloads));
  } catch {
    console.warn("enkii: skipped an unserializable diagnostic event.");
  }
}

export async function flushDiagnostics(): Promise<void> {
  if (!state?.enabled || !state.directory) return;

  try {
    await mkdir(state.directory, { recursive: true });
    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      identity: state.identity,
      events: state.events,
    };
    await writeFile(
      join(state.directory, "diagnostics.json"),
      `${JSON.stringify(artifact, null, 2)}\n`,
      "utf8",
    );
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        renderSummary(state.events, state.identity) + "\n",
      );
  } catch (error) {
    // Diagnostics must never hide the review's actual result.
    console.warn(`enkii: could not write diagnostics: ${message(error)}`);
  }
}

function sanitizeEvent(
  event: Record<string, unknown>,
  includePayloads: boolean,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of [
    "kind",
    "pass",
    "phase",
    "lane",
    "outcome",
    "status",
    "model",
    "scope",
    "coverage",
    "stage",
    "errorCode",
    "reason",
    "checkpointHead",
    "eventName",
    "eventAction",
  ]) {
    if (typeof event[key] === "string")
      safe[key] = redact(event[key]).slice(0, MAX_TEXT);
  }
  if (typeof event.error === "string")
    safe.error = redact(event.error).slice(0, MAX_TEXT);
  for (const key of [
    "attempt",
    "priorFindingCount",
    "durationMs",
    "toolDurationMs",
    "modelDurationMs",
    "toolCallCount",
    "repairCount",
    "timeoutMs",
  ]) {
    if (typeof event[key] === "number" && Number.isFinite(event[key]))
      safe[key] = event[key];
  }
  if (
    event.usage &&
    typeof event.usage === "object" &&
    !Array.isArray(event.usage)
  ) {
    safe.usage = numericObject(event.usage as Record<string, unknown>);
  }
  if (
    event.metrics &&
    typeof event.metrics === "object" &&
    !Array.isArray(event.metrics)
  ) {
    const metrics = Object.fromEntries(
      Object.entries(event.metrics as Record<string, unknown>).filter(
        ([key, value]) =>
          [
            "durationMs",
            "toolCalls",
            "inputTokens",
            "outputTokens",
            "candidateCount",
            "findingCount",
            "retryCount",
          ].includes(key) &&
          typeof value === "number" &&
          Number.isFinite(value),
      ),
    );
    if (Object.keys(metrics).length) safe.metrics = metrics;
  }
  const payload = event.payload ?? event.submission;
  if (payload && typeof payload === "object") {
    safe.submission = includePayloads
      ? boundedPayload(payload)
      : structuralPayload(payload);
  }
  return safe;
}

function numericObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (item && typeof item === "object" && !Array.isArray(item))
      result[key] = numericObject(item as Record<string, unknown>);
  }
  return result;
}

function structuralPayload(value: unknown): unknown {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const comments = Array.isArray(input.comments) ? input.comments : [];
  return {
    accepted: typeof input.accepted === "boolean" ? input.accepted : undefined,
    candidateCount:
      typeof input.candidateCount === "number"
        ? input.candidateCount
        : undefined,
    findingCount:
      typeof input.findingCount === "number" ? input.findingCount : undefined,
    coverageComplete:
      typeof input.coverageComplete === "boolean"
        ? input.coverageComplete
        : undefined,
    commentCount: comments.length,
    resultCount: Array.isArray(input.results)
      ? input.results.length
      : undefined,
    priorFindingDispositions: Array.isArray(input.priorFindingDispositions)
      ? input.priorFindingDispositions.slice(0, 100).map((comment) => {
          const item =
            comment && typeof comment === "object"
              ? (comment as Record<string, unknown>)
              : {};
          return {
            index: typeof item.index === "number" ? item.index : undefined,
            commentIndex:
              typeof item.commentIndex === "number" ||
              item.commentIndex === null
                ? item.commentIndex
                : undefined,
            reasonPresent:
              typeof item.reason === "string" && item.reason.length > 0,
          };
        })
      : undefined,
  };
}

function boundedPayload(value: unknown): unknown {
  const json = JSON.stringify(redactedPayload(value));
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= MAX_PAYLOAD_BYTES) return JSON.parse(json);
  return { truncated: true, bytes, limitBytes: MAX_PAYLOAD_BYTES };
}

function redactedPayload(value: unknown): unknown {
  if (typeof value === "string") return redact(value).slice(0, MAX_TEXT);
  if (Array.isArray(value)) return value.map(redactedPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      redact(key).slice(0, MAX_TEXT),
      redactedPayload(item),
    ]),
  );
}

function redact(text: string): string {
  const secrets = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        value && /(?:token|api[_-]?key|secret|password)$/i.test(name),
    )
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4);
  return secrets.reduce(
    (result, secret) => result.split(secret).join("[REDACTED]"),
    text,
  );
}

function renderSummary(
  events: Record<string, unknown>[],
  identity: Record<string, string>,
): string {
  const rows = events
    .filter((event) => event.lane || event.kind || event.phase || event.pass)
    .map((event) => {
      const duration =
        event.durationMs ??
        (event.metrics as Record<string, unknown> | undefined)?.durationMs;
      const usage = event.usage as Record<string, unknown> | undefined;
      return `| ${cell(event.lane ?? event.kind)} | ${cell(event.pass)} | ${cell(event.phase ?? event.stage)} | ${cell(event.scope)} | ${cell(event.coverage)} | ${cell(event.model)} | ${cell(event.outcome ?? event.status)} | ${typeof duration === "number" ? `${duration} ms` : "—"} | ${numeric(event.toolDurationMs)} / ${numeric(event.modelDurationMs)} | ${numeric(usage?.totalTokens)} | ${numeric(event.repairCount)} | ${cell(event.error)} |`;
    });
  return [
    "## Enkii diagnostics",
    "",
    `Reviewed head: \`${cell(identity.reviewedHead)}\` · Runtime: \`${cell(identity.runtime)}\` · Action: \`${cell(identity.actionRef)}\``,
    "",
    "### Incremental reuse",
    "",
    "| Lane | Scope | Reason | Checkpoint commit | Event |",
    "| --- | --- | --- | --- | --- |",
    ...events
      .filter((event) => event.phase === "preparation" && event.kind)
      .map(
        (event) =>
          `| ${cell(event.kind)} | ${cell(event.scope)} | ${cell(event.reason)} | ${cell(event.checkpointHead)} | ${cell(event.eventName)} / ${cell(event.eventAction)} |`,
      ),
    "",
    "| Lane | Pass | Stage | Scope | Coverage | Model | Outcome | Duration | Tool / model | Tokens | Repairs | Error |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...(rows.length
      ? rows
      : [
          "| — | — | — | — | — | — | no review work recorded | — | — | — | — | — |",
        ]),
    "",
  ].join("\n");
}

function cell(value: unknown): string {
  if (typeof value !== "string") return "—";
  return (
    value
      .slice(0, MAX_TEXT)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[|\\`\r\n]/g, " ")
      .replace(/[\[\]()*_!]/g, (character) => `\\${character}`) || "—"
  );
}

function numeric(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "—";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
