import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";

export type RunAgentOptions<T> = {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  tools: AgentTool[];
  outputToolName: string;
  getOutput: () => T | undefined;
  timeoutMs?: number;
};

export type RunAgentResult<T> = {
  output: T;
  durationMs: number;
  toolCallCount: number;
};

export class AgentRunError extends Error {
  durationMs: number;

  constructor(message: string, durationMs: number) {
    super(message);
    this.name = "AgentRunError";
    this.durationMs = durationMs;
  }
}

function getOpenRouterModel(modelId: string): Model<any> {
  const base = getModel("openrouter", "deepseek/deepseek-v4-pro");
  if (modelId === base.id) return base;

  return {
    ...base,
    id: modelId,
    name: modelId,
  };
}

function parseEnvTimeout(): number | null {
  const raw = process.env.ENKII_AGENT_TIMEOUT_MS;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function runAgent<T>(
  options: RunAgentOptions<T>,
): Promise<RunAgentResult<T>> {
  const start = Date.now();
  const timeoutMs = options.timeoutMs ?? parseEnvTimeout() ?? 20 * 60 * 1000;
  let toolCallCount = 0;
  let errorMessage: string | undefined;

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
      console.log(`enkii: tool start ${event.toolName}`);
    }
    if (event.type === "tool_execution_end") {
      console.log(
        `enkii: tool end ${event.toolName}${event.isError ? " (error)" : ""}`,
      );
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const messageError =
        "errorMessage" in event.message
          ? event.message.errorMessage
          : undefined;
      if (messageError) errorMessage = messageError;
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
    );
  }

  return { output, durationMs, toolCallCount };
}
