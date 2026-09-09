import { describe, expect, test } from "bun:test";
import type { Static } from "@mariozechner/pi-ai";
import { SubmitCandidatesParameters } from "./tool-schemas";
import { createSubmitCandidatesTool } from "./tools/submit";
import { runAgent } from "./run-agent";

describe("runAgent", () => {
  test.each(["provider event", "exception", "timeout"])(
    "preserves completed structured output after a trailing %s",
    async (failure) => {
      let submitted: Static<typeof SubmitCandidatesParameters> | undefined;
      let sessions = 0;
      let prompts = 0;
      const result = await runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        outputToolName: "submit_review",
        getOutput: () => submitted,
        timeoutMs: failure === "timeout" ? 20 : 1000,
        transientRetries: 1,
        missingOutputRetries: 1,
        tools: [
          createSubmitCandidatesTool((args) => {
            submitted = args;
          }),
        ],
        createAgent: (args) => {
          sessions++;
          let subscriber: any;
          let complete: (() => void) | undefined;
          return {
            subscribe(callback) {
              subscriber = callback;
              return () => {};
            },
            async prompt() {
              prompts++;
              const tool = args!.initialState!.tools!.find(
                (t) => t.name === "submit_review",
              )!;
              subscriber({
                type: "tool_execution_start",
                toolName: "submit_review",
              });
              await tool.execute("submitted", {
                version: 1,
                coverageComplete: true,
                meta: {
                  repo: "owner/repo",
                  prNumber: 1,
                  headSha: "a".repeat(40),
                  baseRef: "main",
                },
                comments: [],
                reviewSummary: { body: "Completed review." },
              });
              subscriber({
                type: "tool_execution_end",
                toolName: "submit_review",
                isError: false,
              });
              if (failure === "exception") throw new Error("connection reset");
              if (failure === "timeout") {
                await new Promise<void>((resolve) => {
                  complete = resolve;
                });
              } else {
                subscriber({
                  type: "message_end",
                  message: {
                    role: "assistant",
                    errorMessage: "Provider finish_reason: error",
                    usage: {
                      input: 10,
                      output: 2,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 12,
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                      },
                    },
                  },
                });
              }
            },
            abort() {
              complete?.();
            },
          };
        },
      });
      expect(result.output).toBe(submitted!);
      expect(result.output.reviewSummary?.body).toBe("Completed review.");
      expect(result.toolCallCount).toBe(1);
      expect(sessions).toBe(1);
      expect(prompts).toBe(1);
      if (failure === "provider event")
        expect(result.usage.totalTokens).toBe(12);
    },
  );

  test("retries once when the agent returns without calling submit_review", async () => {
    const prompts: string[] = [];
    let attempts = 0;
    let sessions = 0;
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
        sessions++;
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
    expect(sessions).toBe(1);
    expect(prompts[1]).not.toContain("Inspect files, then call submit_review.");
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

  test("permanent provider failures do not start missing-output repairs", async () => {
    let prompts = 0;
    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        tools: [],
        outputToolName: "submit_review",
        getOutput: () => undefined,
        transientRetries: 1,
        missingOutputRetries: 1,
        createAgent: () => {
          let subscriber: any;
          return {
            subscribe(callback) {
              subscriber = callback;
              return () => {};
            },
            async prompt() {
              prompts++;
              subscriber({
                type: "message_end",
                message: {
                  role: "assistant",
                  errorMessage: "402 insufficient credits",
                  usage: {
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
                  },
                },
              });
            },
            abort() {},
          };
        },
      }),
    ).rejects.toThrow("402 insufficient credits");
    expect(prompts).toBe(1);
  });

  test("timeout cannot cascade into fresh twenty-minute attempts or an output repair", async () => {
    let sessions = 0;
    let prompts = 0;
    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        tools: [],
        outputToolName: "submit_review",
        getOutput: () => undefined,
        timeoutMs: 20,
        transientRetries: 1,
        missingOutputRetries: 1,
        createAgent: () => {
          sessions++;
          let complete!: () => void;
          return {
            subscribe() {
              return () => {};
            },
            async prompt() {
              prompts++;
              await new Promise<void>((resolve) => {
                complete = resolve;
              });
            },
            abort() {
              complete();
            },
          };
        },
      }),
    ).rejects.toThrow("timed out");
    expect(sessions).toBe(1);
    expect(prompts).toBe(1);
  });

  test("repairs and transient retries retain accumulated usage", async () => {
    let sessions = 0;
    let submitted: string | undefined;
    let prompts = 0;
    const result = await runAgent({
      systemPrompt: "system",
      userPrompt: "review",
      model: "deepseek/deepseek-v4-pro",
      tools: [],
      outputToolName: "submit_review",
      getOutput: () => submitted,
      transientRetries: 1,
      missingOutputRetries: 1,
      createAgent: () => {
        sessions++;
        let subscriber: any;
        return {
          subscribe(callback) {
            subscriber = callback;
            return () => {};
          },
          async prompt() {
            prompts++;
            subscriber({
              type: "message_end",
              message: {
                role: "assistant",
                errorMessage: prompts === 1 ? "connection reset" : undefined,
                usage: {
                  input: 10,
                  output: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 12,
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 2,
                  },
                },
              },
            });
            if (prompts === 3) submitted = "done";
          },
          abort() {},
        };
      },
    });
    expect(sessions).toBe(2);
    expect(prompts).toBe(3);
    expect(result.usage.totalTokens).toBe(36);
    expect(result.usage.cost.total).toBe(6);
  });
});
