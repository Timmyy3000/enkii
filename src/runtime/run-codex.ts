/**
 * Spawn Codex CLI in non-interactive mode and capture its final structured output.
 *
 * Codex's `--output-last-message <FILE>` writes the agent's final message to disk;
 * `--output-schema <FILE>` constrains that message to a JSON Schema. Together they
 * give us a clean contract for Pass 1 (candidates JSON) and Pass 2 (validated JSON).
 *
 * Sandbox is forced to `read-only` — Pass 1/2 must never modify the workspace,
 * never run shell commands, never reach the network. The action's post step (octokit)
 * is the only thing that mutates GitHub state.
 */

import { spawn } from "child_process";
import { readFile } from "fs/promises";

export type CodexRunOptions = {
  /** The prompt sent as the initial user instruction. */
  prompt: string;
  /** Model ID, e.g. "deepseek/deepseek-v4-pro". Routed via the configured model_provider. */
  model: string;
  /** Working directory passed to Codex via `--cd`. Usually `$GITHUB_WORKSPACE`. */
  workingDir: string;
  /** Path Codex writes the agent's final message to (`--output-last-message`). */
  outputFile: string;
  /** Optional JSON Schema file to constrain the agent's final output (`--output-schema`). */
  outputSchemaPath?: string;
  /** Path to the Codex CLI executable. Defaults to "codex" on PATH. */
  codexExecutable?: string;
  /** Hard kill after this many ms. Default 10 min. */
  timeoutMs?: number;
  /** Stream Codex stdout/stderr to the parent? Default true (visible in Action logs). */
  inheritStdio?: boolean;
};

export type CodexRunResult = {
  exitCode: number;
  /** Raw contents of the `outputFile` after the run. Empty string if Codex didn't write it. */
  finalMessage: string;
  durationMs: number;
};

export class CodexRunError extends Error {
  exitCode: number;
  durationMs: number;
  constructor(message: string, exitCode: number, durationMs: number) {
    super(message);
    this.name = "CodexRunError";
    this.exitCode = exitCode;
    this.durationMs = durationMs;
  }
}

export async function runCodex(
  options: CodexRunOptions,
): Promise<CodexRunResult> {
  const {
    prompt,
    model,
    workingDir,
    outputFile,
    outputSchemaPath,
    codexExecutable = "codex",
    timeoutMs = 10 * 60 * 1000,
    inheritStdio = true,
  } = options;

  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--cd",
    workingDir,
    "--output-last-message",
    outputFile,
    "-m",
    model,
  ];

  if (outputSchemaPath) {
    args.push("--output-schema", outputSchemaPath);
  }

  // Prompt comes from stdin so we don't blow up the argv length on long skills.
  args.push("-");

  const start = Date.now();
  const child = spawn(codexExecutable, args, {
    stdio: [
      "pipe",
      inheritStdio ? "inherit" : "pipe",
      inheritStdio ? "inherit" : "pipe",
    ],
    env: process.env,
  });

  if (!child.stdin) {
    throw new CodexRunError(
      "enkii: failed to open stdin to codex CLI process.",
      1,
      Date.now() - start,
    );
  }
  child.stdin.write(prompt);
  child.stdin.end();

  const timer = setTimeout(() => {
    child.kill("SIGTERM");
  }, timeoutMs);

  const exitCode: number = await new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
  clearTimeout(timer);

  const durationMs = Date.now() - start;

  let finalMessage = "";
  try {
    finalMessage = await readFile(outputFile, "utf8");
  } catch {
    // File may not exist if Codex crashed before writing.
  }

  if (exitCode !== 0) {
    throw new CodexRunError(
      `enkii: codex exec failed with exit code ${exitCode}. ` +
        `Cause: the harness or the upstream model returned a non-zero status. ` +
        `Fix: retry with @enkii /review. If repeated, check the action logs above and file an issue with the run link.`,
      exitCode,
      durationMs,
    );
  }

  return { exitCode, finalMessage, durationMs };
}
