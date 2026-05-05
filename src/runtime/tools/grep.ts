import { spawn } from "child_process";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

const GrepParameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(
    Type.String({ description: "Optional path under the repository root." }),
  ),
  literal: Type.Optional(Type.Boolean({ default: false })),
});

export type GrepToolOptions = {
  workingDir: string;
  maxBytes?: number;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
  clearTimeout(timer);

  return { exitCode, stdout, stderr };
}

export function createGrepTool(
  options: GrepToolOptions,
): AgentTool<typeof GrepParameters> {
  const maxBytes = options.maxBytes ?? 80_000;

  return {
    name: "grep",
    label: "Grep",
    description:
      "Search repository files for a literal string or regex pattern.",
    parameters: GrepParameters,
    execute: async (_toolCallId, params) => {
      const rgArgs = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        ...(params.literal ? ["--fixed-strings"] : []),
        params.pattern,
        params.path ?? ".",
      ];
      let result = await runCommand("rg", rgArgs, options.workingDir, 30_000);

      if (result.exitCode === 127) {
        const gitArgs = [
          "grep",
          "-n",
          ...(params.literal ? ["-F"] : []),
          "--",
          params.pattern,
          params.path ?? ".",
        ];
        result = await runCommand("git", gitArgs, options.workingDir, 30_000);
      }

      if (result.exitCode > 1) {
        throw new Error(
          result.stderr.trim() ||
            `grep failed with exit code ${result.exitCode}`,
        );
      }

      const text = result.stdout || "(no matches)";
      const truncated = text.length > maxBytes;
      return {
        content: [
          {
            type: "text",
            text: truncated ? text.slice(0, maxBytes) : text,
          },
        ],
        details: { truncated, exitCode: result.exitCode },
      };
    },
  };
}
