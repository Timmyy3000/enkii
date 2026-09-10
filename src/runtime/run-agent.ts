import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, type Model, type Usage } from "@mariozechner/pi-ai";
import { recordDiagnostic } from "./diagnostics";

type AgentLike = {
  subscribe: Agent["subscribe"];
  prompt: Agent["prompt"];
  abort: Agent["abort"];
};

export type RunAgentOptions<T> = {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  tools: AgentTool[];
  outputToolName: string;
  getOutput: () => T | undefined;
  timeoutMs?: number;
  transientRetries?: number;
  missingOutputRetries?: number;
  logPrefix?: string;
  createAgent?: (args: ConstructorParameters<typeof Agent>[0]) => AgentLike;
};

export type RunAgentResult<T> = {
  output: T;
  durationMs: number;
  toolCallCount: number;
  usage: Usage;
};

export class AgentRunError extends Error {
  durationMs: number;
  toolCallCount: number;
  usage: Usage;

  constructor(
    message: string,
    durationMs: number,
    toolCallCount: number,
    usage: Usage,
  ) {
    super(message);
    this.name = "AgentRunError";
    this.durationMs = durationMs;
    this.toolCallCount = toolCallCount;
    this.usage = usage;
  }
}

function getOpenRouterModel(modelId: string): Model<any> {
  const base = getModel("openrouter", "deepseek/deepseek-v4-pro");
  if (modelId === base.id) return base;

  return {
    ...base,
    id: modelId,
    name: modelId,
    compat: {
      ...base.compat,
      openRouterRouting: {
        sort: "price",
      },
    },
  };
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

function parseEnvTimeout(): number | null {
  const raw = process.env.ENKII_AGENT_TIMEOUT_MS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function agentTimeoutMs(): number {
  const override = parseEnvTimeout();
  if (override !== null) return Math.min(override, 120 * 60 * 1000);
  const minutes = Number(process.env.ENKII_AGENT_TIMEOUT_MINUTES || 30);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120)
    throw new Error(
      "enkii: agent_timeout_minutes must be greater than 0 and at most 120.",
    );
  return minutes * 60 * 1000;
}

function parseEnvTransientRetries(): number {
  const raw = process.env.ENKII_AGENT_TRANSIENT_RETRIES;
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function parseEnvMissingOutputRetries(): number {
  const raw = process.env.ENKII_AGENT_MISSING_OUTPUT_RETRIES;
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 1;
}

function isTransientProviderError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  return /network connection lost|request was aborted|timed out|timeout|connection reset|econnreset|etimedout|temporarily unavailable/i.test(
    errorMessage,
  );
}

function buildMissingOutputRetryPrompt(
  outputToolName: string,
  attempt: number,
): string {
  return `<retry_notice>
Previous attempt ${attempt} ended without calling \`${outputToolName}\`.
Use the evidence already gathered in this session; do not restart the review.
Call \`${outputToolName}\` exactly once now with the final structured output.
If coverage is incomplete, report it explicitly. Do not answer with prose.
</retry_notice>`;
}

export async function runAgent<T>(
  options: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  let transientRetriesRemaining =
    options.transientRetries ?? parseEnvTransientRetries();
  let totalDurationMs = 0;
  let totalToolCallCount = 0;
  const totalUsage = emptyUsage();
  const deadline = Date.now() + (options.timeoutMs ?? agentTimeoutMs());

  let attempt = 1;

  while (true) {
    try {
      const result = await runAgentAttempt({
        ...options,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      totalDurationMs += result.durationMs;
      totalToolCallCount += result.toolCallCount;
      addUsage(totalUsage, result.usage);
      return {
        output: result.output,
        durationMs: totalDurationMs,
        toolCallCount: totalToolCallCount,
        usage: totalUsage,
      };
    } catch (error) {
      if (!(error instanceof AgentRunError)) throw error;
      totalDurationMs += error.durationMs;
      totalToolCallCount += error.toolCallCount;
      addUsage(totalUsage, error.usage);
      const transient = isTransientProviderError(error.message);
      if (
        transient &&
        transientRetriesRemaining > 0 &&
        Date.now() < deadline &&
        !options.getOutput()
      ) {
        transientRetriesRemaining--;
        const prefix = options.logPrefix ? `:${options.logPrefix}` : "";
        console.warn(
          `enkii${prefix}: transient provider failure, retrying agent run (${attempt})`,
        );
        attempt++;
        recordDiagnostic({
          kind: options.logPrefix,
          phase: "retry",
          attempt,
          reason: "transient_provider_failure",
        });
        continue;
      }

      throw new AgentRunError(
        error.message,
        totalDurationMs,
        totalToolCallCount,
        totalUsage,
      );
    }
  }
}

async function runAgentAttempt<T>(
  options: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? agentTimeoutMs();
  let toolCallCount = 0;
  let errorMessage: string | undefined;
  let submissionError: string | undefined;
  let invalidSubmissions = 0;
  let submissionAttempts = 0;
  let repairCount = 0;
  let toolDurationMs = 0;
  let modelDurationMs = 0;
  let modelStart: number | undefined;
  const toolStarts = new Map<string, number>();
  const pendingSubmissions = new Map<string, unknown>();
  const usage = emptyUsage();
  const prefix = options.logPrefix ? `:${options.logPrefix}` : "";

  const createAgent =
    options.createAgent ??
    ((args: ConstructorParameters<typeof Agent>[0]) => new Agent(args));
  const agent = createAgent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: getOpenRouterModel(options.model),
      thinkingLevel: "off",
      tools: options.tools.map((tool) =>
        tool.name !== options.outputToolName
          ? tool
          : {
              ...tool,
              execute: async (...args: Parameters<typeof tool.execute>) => {
                // Semantic validation happens in the submit callback before storing output.
                // Keep the correction in this session and permit only one replacement.
                if (invalidSubmissions >= 2)
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: "Submission repair budget exhausted; review incomplete.",
                      },
                    ],
                    details: {},
                    terminate: true,
                  };
                try {
                  submissionAttempts++;
                  const result = await tool.execute(...args);
                  submissionError = undefined;
                  recordDiagnostic({
                    kind: options.logPrefix,
                    phase: "submission",
                    status: "accepted",
                    repairCount: Math.max(0, submissionAttempts - 1),
                    payload: args[1],
                  });
                  return result;
                } catch (error) {
                  invalidSubmissions++;
                  submissionError =
                    error instanceof Error ? error.message : String(error);
                  recordDiagnostic({
                    kind: options.logPrefix,
                    phase: "submission",
                    status: "rejected",
                    error: submissionError,
                    repairCount: Math.max(0, submissionAttempts - 1),
                    payload: args[1],
                  });
                  if (invalidSubmissions >= 2) agent.abort();
                  return {
                    content: [
                      {
                        type: "text" as const,
                        text: `Submission rejected: ${submissionError}\n${invalidSubmissions < 2 ? "Correct these fields and resubmit once using evidence already gathered. Do not restart review." : "Repair budget exhausted; review incomplete."}`,
                      },
                    ],
                    details: { validationFailed: true },
                    terminate: invalidSubmissions >= 2,
                  };
                }
              },
            },
      ),
      messages: [],
    },
    toolExecution: "sequential",
    sessionId: `enkii-${Date.now()}`,
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start") {
      toolCallCount++;
      toolStarts.set(event.toolCallId, Date.now());
      if (event.toolName === options.outputToolName)
        pendingSubmissions.set(event.toolCallId, event.args);
      console.log(`enkii${prefix}: tool start ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      const began = toolStarts.get(event.toolCallId);
      if (began !== undefined) toolDurationMs += Date.now() - began;
      toolStarts.delete(event.toolCallId);
      // The SDK rejects malformed arguments before our execute wrapper runs.
      // Account for those rejections in the same correction budget.
      if (
        event.toolName === options.outputToolName &&
        event.isError &&
        !options.getOutput()
      ) {
        invalidSubmissions++;
        submissionAttempts++;
        submissionError = `${options.outputToolName} arguments failed tool-schema validation; correct the tool's reported field errors.`;
        recordDiagnostic({
          kind: options.logPrefix,
          phase: "submission",
          status: "rejected",
          error: submissionError,
          errorCode: "tool_schema_validation",
          repairCount: Math.max(0, submissionAttempts - 1),
          payload: pendingSubmissions.get(event.toolCallId),
        });
        if (invalidSubmissions >= 2) agent.abort();
      }
      pendingSubmissions.delete(event.toolCallId);
      console.log(
        `enkii${prefix}: tool end ${event.toolName}${event.isError ? " (error)" : ""}`,
      );
    }
    if (event.type === "turn_start") modelStart = Date.now();
    if (event.type === "message_end" && event.message.role === "assistant") {
      if (modelStart !== undefined) modelDurationMs += Date.now() - modelStart;
      modelStart = undefined;
      const messageError =
        "errorMessage" in event.message
          ? event.message.errorMessage
          : undefined;
      if (messageError) errorMessage = messageError;
      addUsage(usage, event.message.usage);
    }
  });

  const timer = setTimeout(() => {
    errorMessage = `timed out after ${(timeoutMs / 1000).toFixed(1)}s`;
    agent.abort();
  }, timeoutMs);

  try {
    await agent.prompt(options.userPrompt);
    const repairs =
      options.missingOutputRetries ?? parseEnvMissingOutputRetries();
    for (
      let repair = 1;
      !options.getOutput() &&
      !errorMessage &&
      invalidSubmissions < 2 &&
      repair <= repairs &&
      Date.now() - start < timeoutMs;
      repair++
    ) {
      console.warn(
        `enkii${prefix}: repairing missing ${options.outputToolName} in the existing session (${repair})`,
      );
      repairCount++;
      await agent.prompt(
        submissionError
          ? `Correct the rejected ${options.outputToolName} submission in this session: ${submissionError}. Reuse gathered evidence and resubmit once.`
          : buildMissingOutputRetryPrompt(options.outputToolName, repair),
      );
    }
  } catch (error) {
    errorMessage ??= error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - start;
  const output = options.getOutput();
  if (modelStart !== undefined) modelDurationMs += Date.now() - modelStart;
  for (const began of toolStarts.values()) toolDurationMs += Date.now() - began;
  recordDiagnostic({
    kind: options.logPrefix,
    phase: "pass",
    status: output ? "completed" : "incomplete",
    durationMs,
    toolDurationMs,
    modelDurationMs,
    toolCallCount,
    repairCount: Math.max(repairCount, submissionAttempts - 1),
    usage,
    timeoutMs,
    error: submissionError ?? errorMessage,
    model: options.model,
  });
  // Submission is the terminal result. A trailing provider turn or timeout
  // must not discard it; the caller still validates its schema and coverage.
  if (!output) {
    throw new AgentRunError(
      submissionError
        ? `enkii: invalid submission after bounded repair: ${submissionError}`
        : errorMessage
          ? `enkii: provider failure: ${errorMessage}`
          : `enkii: agent did not call ${options.outputToolName}.`,
      durationMs,
      toolCallCount,
      usage,
    );
  }

  return { output, durationMs, toolCallCount, usage };
}
