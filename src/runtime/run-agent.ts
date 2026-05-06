import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, type Model, type Usage } from "@mariozechner/pi-ai";

export type RunAgentOptions<T> = {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  tools: AgentTool[];
  outputToolName: string;
  getOutput: () => T | undefined;
  timeoutMs?: number;
  logPrefix?: string;
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

function parseEnvTransientRetries(): number {
  const raw = process.env.ENKII_AGENT_TRANSIENT_RETRIES;
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

export async function runAgent<T>(
  options: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const transientRetries = parseEnvTransientRetries();
  const maxAttempts = transientRetries + 1;
  let totalDurationMs = 0;
  let totalToolCallCount = 0;
  const totalUsage = emptyUsage();

  let lastError: AgentRunError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await runAgentAttempt(options);
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
      lastError = error;
      const retryable = isTransientProviderError(error.message);
      if (!retryable || attempt >= maxAttempts) {
        throw new AgentRunError(
          error.message,
          totalDurationMs,
          totalToolCallCount,
          totalUsage,
        );
      }
      const prefix = options.logPrefix ? `:${options.logPrefix}` : "";
      console.warn(
        `enkii${prefix}: transient provider failure, retrying agent run (${attempt}/${maxAttempts})`,
      );
    }
  }

  if (lastError) {
    throw new AgentRunError(
      lastError.message,
      totalDurationMs,
      totalToolCallCount,
      totalUsage,
    );
  }

  throw new Error("enkii: unexpected retry loop exit");
}

async function runAgentAttempt<T>(
  options: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? parseEnvTimeout() ?? 20 * 60 * 1000;
  let toolCallCount = 0;
  let errorMessage: string | undefined;
  const usage = emptyUsage();
  const prefix = options.logPrefix ? `:${options.logPrefix}` : "";

  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: getOpenRouterModel(options.model),
      thinkingLevel: "off",
      tools: options.tools,
      messages: [],
    },
    toolExecution: "sequential",
    sessionId: `enkii-${Date.now()}`,
  });

  agent.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start") {
      toolCallCount++;
      console.log(`enkii${prefix}: tool start ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      console.log(
        `enkii${prefix}: tool end ${event.toolName}${event.isError ? " (error)" : ""}`,
      );
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
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
  } finally {
    clearTimeout(timer);
  }

  const durationMs = Date.now() - start;
  const output = options.getOutput();
  if (!output) {
    throw new AgentRunError(
      `enkii: agent did not call ${options.outputToolName}.` +
        (errorMessage ? ` Provider error: ${errorMessage}` : ""),
      durationMs,
      toolCallCount,
      usage,
    );
  }

  return { output, durationMs, toolCallCount, usage };
}
