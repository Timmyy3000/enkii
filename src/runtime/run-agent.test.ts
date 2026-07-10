import { describe, expect, test } from "bun:test";
import type { Static } from "@mariozechner/pi-ai";
import { SubmitCandidatesParameters } from "./tool-schemas";
import { createSubmitCandidatesTool } from "./tools/submit";
import { runAgent } from "./run-agent";

describe("runAgent", () => {
  test("retries once when the agent returns without calling submit_review", async () => {
    const prompts: string[] = [];
    let attempts = 0;
    let submitted: Static<typeof SubmitCandidatesParameters> | undefined;

    const result = await runAgent<Static<typeof SubmitCandidatesParameters>>({
      systemPrompt: "system",
      userPrompt: "Inspect files, then call submit_review.",
      model: "deepseek/deepseek-v4-pro",
      outputToolName: "submit_review",
      getOutput: () => submitted,
      transientRetries: 0,
      missingOutputRetries: 1,
      tools: [
        createSubmitCandidatesTool((args) => {
          submitted = args;
        }),
      ],
      createAgent: (args) => {
        const tools = args?.initialState?.tools;
        if (!tools) {
          throw new Error("agent tools missing");
        }
        let subscriber:
          | ((event: any, signal: AbortSignal) => void | Promise<void>)
          | undefined;

        return {
          subscribe(callback) {
            subscriber = callback;
            return () => {};
          },
          async prompt(prompt) {
            prompts.push(String(prompt));
            attempts++;

            if (attempts === 1) {
              await subscriber?.(
                { type: "tool_execution_start", toolName: "read" },
                new AbortController().signal,
              );
              subscriber?.(
                {
                  type: "tool_execution_end",
                  toolName: "read",
                  isError: false,
                } as any,
                new AbortController().signal,
              );
              return;
            }

            const submitTool = tools.find(
              (tool) => tool.name === "submit_review",
            );
            if (!submitTool) throw new Error("submit_review tool missing");

            await subscriber?.(
              {
                type: "tool_execution_start",
                toolName: "submit_review",
              } as any,
              new AbortController().signal,
            );
            await submitTool.execute("tool-call-1", {
              version: 1,
              meta: {
                repo: "owner/repo",
                prNumber: 123,
                headSha: "abc123",
                baseRef: "main",
                generatedAt: "2026-05-15T00:00:00.000Z",
              },
              comments: [],
              reviewSummary: { body: "No security findings." },
            });
            await subscriber?.(
              {
                type: "tool_execution_end",
                toolName: "submit_review",
                isError: false,
              } as any,
              new AbortController().signal,
            );
          },
          abort() {},
        };
      },
    });

    expect(result.output.reviewSummary?.body).toBe("No security findings.");
    expect(result.toolCallCount).toBe(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(
      "Previous attempt 1 ended without calling `submit_review`.",
    );
  });

  test("fails after missing-output retries are exhausted", async () => {
    let submitted: unknown;

    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "Inspect files, then call submit_review.",
        model: "deepseek/deepseek-v4-pro",
        outputToolName: "submit_review",
        getOutput: () => submitted,
        transientRetries: 0,
        missingOutputRetries: 0,
        tools: [createSubmitCandidatesTool((args) => void (submitted = args))],
        createAgent: () => ({
          subscribe() {
            return () => {};
          },
          async prompt() {},
          abort() {},
        }),
      }),
    ).rejects.toThrow("enkii: agent did not call submit_review.");
  });
});
