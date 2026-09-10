import { describe, expect, test } from "bun:test";
import type { Static } from "@mariozechner/pi-ai";
import { SubmitCandidatesParameters } from "./tool-schemas";
import { createSubmitCandidatesTool } from "./tools/submit";
import { runAgent, agentTimeoutMs } from "./run-agent";

describe("runAgent", () => {
  test("SDK preflight schema failures share the same one-correction cap", async () => {
    let aborts = 0;
    let prompts = 0;
    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        tools: [],
        outputToolName: "submit_review",
        getOutput: () => undefined,
        timeoutMs: 1000,
        createAgent: () => {
          let emit: (event: any) => void;
          return {
            subscribe(callback) {
              emit = (event) => {
                void callback(event, new AbortController().signal);
              };
              return () => {};
            },
            async prompt() {
              prompts++;
              emit({
                type: "tool_execution_end",
                toolName: "read",
                toolCallId: "read",
                isError: true,
              });
              expect(aborts).toBe(0);
              for (let index = 0; index < 2; index++) {
                emit({
                  type: "tool_execution_start",
                  toolName: "submit_review",
                  toolCallId: String(index),
                  args: { version: 1 },
                });
                emit({
                  type: "tool_execution_end",
                  toolName: "submit_review",
                  toolCallId: String(index),
                  isError: true,
                });
                expect(aborts).toBe(index);
              }
            },
            abort() {
              aborts++;
            },
          };
        },
      }),
    ).rejects.toThrow("tool-schema validation");
    expect(prompts).toBe(1);
    expect(aborts).toBe(1);
  });
  test("defaults to 30 minutes and honors bounded timeout configuration", () => {
    const previousMs = process.env.ENKII_AGENT_TIMEOUT_MS;
    const previousMinutes = process.env.ENKII_AGENT_TIMEOUT_MINUTES;
    try {
      delete process.env.ENKII_AGENT_TIMEOUT_MS;
      delete process.env.ENKII_AGENT_TIMEOUT_MINUTES;
      expect(agentTimeoutMs()).toBe(30 * 60_000);
      process.env.ENKII_AGENT_TIMEOUT_MINUTES = "45";
      expect(agentTimeoutMs()).toBe(45 * 60_000);
      process.env.ENKII_AGENT_TIMEOUT_MS = "1234";
      expect(agentTimeoutMs()).toBe(1234);
      delete process.env.ENKII_AGENT_TIMEOUT_MS;
      process.env.ENKII_AGENT_TIMEOUT_MINUTES = "121";
      expect(agentTimeoutMs).toThrow("at most 120");
    } finally {
      if (previousMs === undefined) delete process.env.ENKII_AGENT_TIMEOUT_MS;
      else process.env.ENKII_AGENT_TIMEOUT_MS = previousMs;
      if (previousMinutes === undefined)
        delete process.env.ENKII_AGENT_TIMEOUT_MINUTES;
      else process.env.ENKII_AGENT_TIMEOUT_MINUTES = previousMinutes;
    }
  });

  test("invalid submission repair cannot extend the deadline or create a fresh session", async () => {
    let prompts = 0;
    let sessions = 0;
    let submitted: unknown;
    let finish: (() => void) | undefined;
    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        outputToolName: "submit_review",
        getOutput: () => submitted,
        timeoutMs: 30,
        transientRetries: 1,
        tools: [
          createSubmitCandidatesTool(() => {
            throw new Error("prior finding 0 has no disposition");
          }),
        ],
        createAgent: (args) => {
          sessions++;
          return {
            subscribe() {
              return () => {};
            },
            async prompt() {
              prompts++;
              const response = await args!.initialState!.tools![0]!.execute(
                "invalid",
                {},
              );
              expect(response.terminate).toBe(false);
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
            },
            abort() {
              finish?.();
            },
          };
        },
      }),
    ).rejects.toThrow("prior finding 0");
    expect(prompts).toBe(1);
    expect(sessions).toBe(1);
    expect(submitted).toBeUndefined();
  });

  test("only one replacement submission is allowed even within a single model loop", async () => {
    let executions = 0;
    let aborts = 0;
    await expect(
      runAgent({
        systemPrompt: "system",
        userPrompt: "review",
        model: "deepseek/deepseek-v4-pro",
        outputToolName: "submit_review",
        getOutput: () => undefined,
        timeoutMs: 1000,
        tools: [
          createSubmitCandidatesTool(() => {
            executions++;
            throw new Error("invalid disposition");
          }),
        ],
        createAgent: (args) => ({
          subscribe() {
            return () => {};
          },
          async prompt() {
            const submit = args!.initialState!.tools![0]!;
            expect((await submit.execute("one", {})).terminate).toBe(false);
            expect((await submit.execute("two", {})).terminate).toBe(true);
            expect((await submit.execute("three", {})).terminate).toBe(true);
          },
          abort() {
            aborts++;
          },
        }),
      }),
    ).rejects.toThrow("invalid disposition");
    expect(executions).toBe(2);
    expect(aborts).toBe(1);
  });
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
