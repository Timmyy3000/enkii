import {
  Agent,
  type AgentEvent,
  type AgentOptions,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import {
  getModel,
  getModels,
  type Model,
  type Usage,
} from "@mariozechner/pi-ai";
import { recordDiagnostic } from "./diagnostics";
import { claudeModelSpec, priceUsage } from "./claude-models";

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
  /** True when the attempt consumed its whole time budget. Timeouts must
   * never retry: the remaining budget rounds to ~1ms, so a fresh session
   * would instantly time out again. */
  timedOut: boolean;

  constructor(
    message: string,
    durationMs: number,
    toolCallCount: number,
    usage: Usage,
    timedOut = false,
  ) {
    super(message);
    this.name = "AgentRunError";
    this.durationMs = durationMs;
    this.toolCallCount = toolCallCount;
    this.usage = usage;
    this.timedOut = timedOut;
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

const TASK_BUDGET_BETA = "task-budgets-2026-03-13";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export type AnthropicRequestTuning = {
  effort?: string;
  taskBudgetTokens?: number;
  clearToolResultsAboveTokens?: number;
};

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`enkii: ${name} must be a whole number of tokens.`);
  return value > 0 ? value : undefined;
}

export function anthropicTuningFromEnv(): AnthropicRequestTuning {
  const taskBudgetTokens = positiveIntegerEnv("ENKII_TASK_BUDGET_TOKENS");
  if (taskBudgetTokens !== undefined && taskBudgetTokens < 20_000)
    throw new Error("enkii: task_budget_tokens must be at least 20000.");
  return {
    effort: process.env.ENKII_EFFORT?.trim() || undefined,
    taskBudgetTokens,
    clearToolResultsAboveTokens: positiveIntegerEnv(
      "ENKII_CLEAR_TOOL_RESULTS_ABOVE_TOKENS",
    ),
  };
}

const OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"];

function anthropicBetas(tuning: AnthropicRequestTuning): string[] {
  return [
    ...(tuning.taskBudgetTokens ? [TASK_BUDGET_BETA] : []),
    ...(tuning.clearToolResultsAboveTokens ? [CONTEXT_MANAGEMENT_BETA] : []),
  ];
}

function getAnthropicModel(
  modelId: string,
  tuning: AnthropicRequestTuning,
): Model<any> {
  const base =
    getModels("anthropic").find((model) => model.id === modelId) ??
    getModel("anthropic", "claude-opus-4-7");
  const spec = claudeModelSpec(modelId);
  const features = anthropicBetas(tuning);
  const oauth = process.env.ANTHROPIC_API_KEY?.includes("sk-ant-oat");
  const betas =
    features.length && oauth ? [...OAUTH_BETAS, ...features] : features;
  // pi-ai predates Claude 5 and sends thinking: {type: "disabled"} for
  // reasoning models, which Claude 5 rejects. reasoning: false omits the
  // thinking param so each model uses its own default.
  return {
    ...base,
    id: modelId,
    name: modelId,
    reasoning: false,
    ...(spec
      ? { maxTokens: spec.maxOutputTokens, contextWindow: spec.contextWindow }
      : {}),
    // model.headers replaces pi-ai's own anthropic-beta list.
    ...(betas.length ? { headers: { "anthropic-beta": betas.join(",") } } : {}),
  };
}

export function getAgentModel(
  modelId: string,
  tuning: AnthropicRequestTuning = anthropicTuningFromEnv(),
): Model<any> {
  return process.env.ANTHROPIC_API_KEY?.trim()
    ? getAnthropicModel(modelId, tuning)
    : getOpenRouterModel(modelId);
}

export function anthropicPayloadHook(
  modelId: string,
  tuning: AnthropicRequestTuning,
): AgentOptions["onPayload"] {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return undefined;
  const spec = claudeModelSpec(modelId);
  return (payload) => {
    const params = payload as {
      max_tokens?: number;
      output_config?: Record<string, unknown>;
      context_management?: unknown;
    };
    const outputConfig = {
      ...params.output_config,
      ...(tuning.effort ? { effort: tuning.effort } : {}),
      ...(tuning.taskBudgetTokens
        ? { task_budget: { type: "tokens", total: tuning.taskBudgetTokens } }
        : {}),
    };
    return {
      ...params,
      // A hard per-response cap the model cannot see. Pacing is task_budget's job.
      ...(spec ? { max_tokens: spec.maxOutputTokens } : {}),
      ...(Object.keys(outputConfig).length
        ? { output_config: outputConfig }
        : {}),
      ...(tuning.clearToolResultsAboveTokens
        ? {
            context_management: {
              edits: [
                {
                  type: "clear_tool_uses_20250919",
                  trigger: {
                    type: "input_tokens",
                    value: tuning.clearToolResultsAboveTokens,
                  },
                  keep: { type: "tool_uses", value: 4 },
                  clear_at_least: { type: "input_tokens", value: 10_000 },
                },
              ],
            },
          }
        : {}),
    };
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
  return /network connection lost|request was aborted|timed out|timeout|connection reset|econnreset|etimedout|temporarily unavailable|overloaded/i.test(
    errorMessage,
  );
}

function buildMissingOutputRetryPrompt(
  outputToolName: string,
  attempt: number,
  truncated = false,
): string {
  return `<retry_notice>
Previous attempt ${attempt} ended without calling \`${outputToolName}\`${truncated ? " because the reply reached the output limit. Keep reasoning brief this time" : ""}.
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
      const transient =
        isTransientProviderError(error.message) && !error.timedOut;
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
        error.timedOut,
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
  let timedOut = false;
  let submissionError: string | undefined;
  let invalidSubmissions = 0;
  let submissionAttempts = 0;
  let repairCount = 0;
  let toolDurationMs = 0;
  let modelDurationMs = 0;
  let modelStart: number | undefined;
  let turnCount = 0;
  let lastStopReason: string | undefined;
  const tuning = anthropicTuningFromEnv();
  const pricing = process.env.ANTHROPIC_API_KEY?.trim()
    ? claudeModelSpec(options.model)
    : undefined;
  const toolStarts = new Map<string, number>();
  const pendingSubmissions = new Map<string, unknown>();
  const usage = emptyUsage();
  const prefix = options.logPrefix ? `:${options.logPrefix}` : "";

  const createAgent =
    options.createAgent ??
    ((args: ConstructorParameters<typeof Agent>[0]) => new Agent(args));
  const agent = createAgent({
    onPayload: anthropicPayloadHook(options.model, tuning),
    initialState: {
      systemPrompt: options.systemPrompt,
      model: getAgentModel(options.model, tuning),
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
      const turnMs =
        modelStart === undefined ? undefined : Date.now() - modelStart;
      if (turnMs !== undefined) modelDurationMs += turnMs;
      modelStart = undefined;
      turnCount++;
      lastStopReason = event.message.stopReason;
      if (pricing)
        event.message.usage.cost = priceUsage(pricing, event.message.usage);
      recordDiagnostic({
        kind: options.logPrefix,
        phase: "turn",
        turn: turnCount,
        stopReason: event.message.stopReason,
        durationMs: turnMs,
        usage: event.message.usage,
      });
      const messageError =
        "errorMessage" in event.message
          ? event.message.errorMessage
          : undefined;
      if (messageError) errorMessage = messageError;
      addUsage(usage, event.message.usage);
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
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
      const truncated = lastStopReason === "length";
      // Thinking fills the same output cap; a second deep pass would hit it again.
      if (truncated) tuning.effort = "low";
      await agent.prompt(
        submissionError
          ? `Correct the rejected ${options.outputToolName} submission in this session: ${submissionError}. Reuse gathered evidence and resubmit once.`
          : buildMissingOutputRetryPrompt(
              options.outputToolName,
              repair,
              truncated,
            ),
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
      timedOut,
    );
  }

  return { output, durationMs, toolCallCount, usage };
}
