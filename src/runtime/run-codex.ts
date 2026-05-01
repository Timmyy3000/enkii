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
 *
 * Provider config is passed inline via `--ignore-user-config` + `-c` overrides so
 * runs are reproducible regardless of the user's local `~/.codex/config.toml`.
 */

import { spawn } from "child_process";
import { readFile } from "fs/promises";

export type ProviderConfig = {
  /** Provider id used in `-c model_provider="<id>"`. */
  id: string;
  /** Display name (cosmetic). */
  name: string;
  /** OpenAI-compatible base URL, e.g. "https://openrouter.ai/api/v1". */
  baseUrl: string;
  /** Env var Codex reads for the API key, e.g. "OPENROUTER_API_KEY". */
  envKey: string;
  /** Wire protocol — "chat" for OpenAI-compatible chat completions. */
  wireApi: "chat" | "responses";
};

export const OPENROUTER_PROVIDER: ProviderConfig = {
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  envKey: "OPENROUTER_API_KEY",
  // Codex 0.125+ dropped wire_api="chat"; "responses" is the only accepted value.
  // OpenRouter implements the OpenAI Responses API, so this works for any model
  // OpenRouter routes (DeepSeek, Qwen, GLM, Kimi, etc.).
  wireApi: "responses",
};

export type CodexRunOptions = {
  /** The prompt sent as the initial user instruction. */
  prompt: string;
  /** Model ID, e.g. "deepseek/deepseek-v4-pro". */
  model: string;
  /** Working directory passed to Codex via `--cd`. Usually `$GITHUB_WORKSPACE`. */
  workingDir: string;
  /** Path Codex writes the agent's final message to (`--output-last-message`). */
  outputFile: string;
  /** Optional JSON Schema file to constrain the agent's final output (`--output-schema`). */
  outputSchemaPath?: string;
  /** Provider config to inject. Defaults to OpenRouter. */
  provider?: ProviderConfig;
  /** Path to the Codex CLI executable. Defaults to "codex" on PATH. */
  codexExecutable?: string;
  /** Hard kill after this many ms. Default 10 min. */
  timeoutMs?: number;
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
    provider = OPENROUTER_PROVIDER,
    codexExecutable = "codex",
    timeoutMs = 10 * 60 * 1000,
  } = options;

  const args = [
    "exec",
    "--ignore-user-config",
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
    "-c",
    `model_provider="${provider.id}"`,
    "-c",
    `model_providers.${provider.id}.name="${provider.name}"`,
    "-c",
    `model_providers.${provider.id}.base_url="${provider.baseUrl}"`,
    "-c",
    `model_providers.${provider.id}.env_key="${provider.envKey}"`,
    "-c",
    `model_providers.${provider.id}.wire_api="${provider.wireApi}"`,
  ];

  if (outputSchemaPath) {
    args.push("--output-schema", outputSchemaPath);
  }

  // Prompt comes from stdin so we don't blow up the argv length on long skills.
  args.push("-");

  const start = Date.now();
  const child = spawn(codexExecutable, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new CodexRunError(
      "enkii: failed to open pipes to codex CLI process.",
      1,
      Date.now() - start,
    );
  }

  // Stream stdout + stderr to the parent process so logs are visible, AND
  // capture them so we can include the tail in error messages.
  let stderrBuf = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) {
      stderrBuf = stderrBuf.slice(-8192);
    }
  });

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
    const stderrTail = stderrBuf.trim().slice(-2000);
    const stderrFragment = stderrTail
      ? `\n--- codex stderr (tail) ---\n${stderrTail}\n--- end ---`
      : "";
    throw new CodexRunError(
      `enkii: codex exec failed with exit code ${exitCode}.${stderrFragment}`,
      exitCode,
      durationMs,
    );
  }

  return { exitCode, finalMessage, durationMs };
}
