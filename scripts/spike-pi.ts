#!/usr/bin/env bun
/**
 * Local spike: verify pi-agent-core + pi-ai + OpenRouter can produce a
 * CandidatesPass-shaped output by calling a submit_review tool.
 *
 * Usage, from repo root:
 *
 *   bun run scripts/spike-pi.ts [optional/path/to/saved.diff]
 *
 * Defaults:
 *   ENKII_SPIKE_MODEL=@preset/enkii
 *   OPENROUTER_API_KEY is loaded by Bun from .env when present.
 */

import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { Agent, type AgentEvent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, Type, type Model } from "@mariozechner/pi-ai";
import { CandidatesPassSchema, type CandidatesPass } from "../src/runtime/schemas";

const SAMPLE_DIFF = `diff --git a/src/range.ts b/src/range.ts
index abc..def 100644
--- a/src/range.ts
+++ b/src/range.ts
@@ -1,5 +1,7 @@
 export function indexOfNthOccurrence(haystack: string, needle: string, n: number): number {
   let count = 0;
-  for (let i = 0; i < haystack.length; i++) {
+  for (let i = 0; i <= haystack.length; i++) {
     if (haystack.startsWith(needle, i)) {
       count++;
       if (count === n) return i;
     }
   }
   return -1;
 }`;

const CandidateSchema = Type.Object({
  path: Type.String(),
  line: Type.Integer({ minimum: 0 }),
  startLine: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  side: Type.Optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
  body: Type.String(),
  severity: Type.Optional(
    Type.Union([
      Type.Literal("P0"),
      Type.Literal("P1"),
      Type.Literal("P2"),
      Type.Literal("nit"),
    ]),
  ),
});

const SubmitReviewParameters = Type.Object({
  version: Type.Literal(1),
  meta: Type.Object({
    repo: Type.String(),
    prNumber: Type.Union([Type.Number(), Type.String()]),
    headSha: Type.String(),
    baseRef: Type.String(),
    generatedAt: Type.Optional(Type.String()),
    pass1HeadSha: Type.Optional(Type.String()),
  }),
  comments: Type.Array(CandidateSchema),
  reviewSummary: Type.Optional(
    Type.Object({
      body: Type.String(),
    }),
  ),
});

type SubmitReviewArgs = CandidatesPass;

function getOpenRouterModel(modelId: string): Model<any> {
  const base = getModel("openrouter", "deepseek/deepseek-v4-pro");
  if (modelId === base.id) return base;

  return {
    ...base,
    id: modelId,
    name: modelId,
  };
}

function createReadFileTool(workingDir: string): AgentTool {
  return {
    name: "read_file",
    label: "Read File",
    description: "Read a UTF-8 text file inside the spike working directory.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path inside the working directory." }),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      const requested = resolve(workingDir, params.path);
      const root = resolve(workingDir);
      if (!(requested === root || requested.startsWith(root + "\\"))) {
        throw new Error(`Path escapes working directory: ${params.path}`);
      }

      const content = await readFile(requested, "utf8");
      return {
        content: [{ type: "text", text: content.slice(0, 80_000) }],
        details: { path: params.path, size: content.length },
      };
    },
  };
}

function createSubmitReviewTool(onSubmit: (args: SubmitReviewArgs) => void): AgentTool<typeof SubmitReviewParameters> {
  return {
    name: "submit_review",
    label: "Submit Review",
    description: "Call this exactly once with the final review result.",
    parameters: SubmitReviewParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      onSubmit(params);
      return {
        content: [{ type: "text", text: "Review submitted." }],
        details: { commentCount: params.comments.length },
        terminate: true,
      };
    },
  };
}

function logEvent(event: AgentEvent) {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    const errorMessage = "errorMessage" in event.message ? event.message.errorMessage : undefined;
    if (errorMessage) console.log(`assistant error: ${errorMessage}`);
  }

  if (event.type === "tool_execution_start") {
    console.log(`tool start: ${event.toolName}`);
  }

  if (event.type === "tool_execution_end") {
    console.log(`tool end:   ${event.toolName}${event.isError ? " (error)" : ""}`);
  }
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Set OPENROUTER_API_KEY before running this spike.");
    process.exit(1);
  }

  const diffArg = process.argv[2];
  const diff = diffArg ? await readFile(diffArg, "utf8") : SAMPLE_DIFF;
  const modelId = process.env.ENKII_SPIKE_MODEL || "@preset/enkii";
  const workDir = await mkdtemp(join(tmpdir(), "enkii-pi-spike-"));
  const diffPath = join(workDir, "pr.diff");
  await writeFile(diffPath, diff);

  let submitted: SubmitReviewArgs | undefined;
  const start = Date.now();
  const model = getOpenRouterModel(modelId);
  const agent = new Agent({
    initialState: {
      systemPrompt: `You are a senior code reviewer.

Use read_file to inspect files. When finished, call submit_review exactly once.
Do not answer with prose. The submit_review arguments are the final output.
Only include genuine correctness, security, reliability, or maintainability findings.
Use this metadata exactly: repo="spike/repo", prNumber=1, headSha="spike-head", baseRef="main".`,
      model,
      thinkingLevel: "off",
      tools: [createReadFileTool(workDir), createSubmitReviewTool((args) => (submitted = args))],
      messages: [],
    },
    toolExecution: "sequential",
    sessionId: `enkii-pi-spike-${Date.now()}`,
  });

  agent.subscribe((event) => logEvent(event));

  console.log("Spike config:");
  console.log(`  provider:     openrouter`);
  console.log(`  model:        ${modelId}`);
  console.log(`  workDir:      ${workDir}`);
  console.log(`  diff:         ${diffArg ?? "<inline sample>"}`);
  console.log("");
  console.log("Starting pi-agent-core...");
  console.log("");

  const timeout = setTimeout(() => {
    console.error("Spike timed out; aborting agent.");
    agent.abort();
  }, 5 * 60 * 1000);

  try {
    await agent.prompt(`Review the diff in pr.diff. Read it with read_file before deciding.`);
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - start;
  if (!submitted) {
    const assistantMessages = agent.state.messages.filter((message) => message.role === "assistant");
    console.error(`Spike FAILED: model did not call submit_review. assistantMessages=${assistantMessages.length}`);
    for (const message of assistantMessages) {
      console.error(JSON.stringify(message, null, 2));
    }
    process.exit(1);
  }

  const parsed = CandidatesPassSchema.parse(submitted);
  console.log("");
  console.log(`pi-agent-core finished in ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`Validated CandidatesPass. ${parsed.comments.length} comments.`);
  console.log("");
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
