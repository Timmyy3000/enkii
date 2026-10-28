import { realpathSync } from "fs";
import { homedir } from "os";
import { isAbsolute, relative, resolve, sep } from "path";
import type { AgentTool } from "@mariozechner/pi-agent-core";

// Review tools read attacker-controlled PR content while the process holds
// API keys (/proc/self/environ) and checkout credentials (.git/config). Every
// path must resolve, symlinks included, inside an allowed root and outside .git.

// Mirrors resolveToCwd in the exactly pinned @mariozechner/pi-coding-agent 0.73.0.
function resolveToolPath(raw: string, cwd: string): string {
  const path = raw.replace(/^@/, "").replace(/[  -   　]/g, " ");
  const expanded =
    path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
  return resolve(cwd, expanded);
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

const GIT_RESULT_LINE = /^(?:[^\n]*[\\/])?\.git(?:[\\/]|[:-]\d+[:-]|$)/;

export function confineTools(
  tools: AgentTool<any>[],
  cwd: string,
  roots: string[],
): AgentTool<any>[] {
  const realCwd = realOrResolved(cwd);
  const realRoots = roots.map(realOrResolved);

  const check = (raw: string): void => {
    let real: string;
    try {
      real = realpathSync(resolveToolPath(raw, cwd));
    } catch {
      throw new Error(`${raw} does not exist.`);
    }
    if (!realRoots.some((root) => isWithin(root, real)))
      throw new Error(
        `${raw} is outside the review workspace and artifact directories.`,
      );
    if (
      isWithin(realCwd, real) &&
      relative(realCwd, real).split(sep).includes(".git")
    )
      throw new Error(`${raw} is inside .git, which review tools cannot read.`);
  };

  return tools.map((tool) => ({
    ...tool,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      const params = args[1] as { path?: string };
      check(params.path ?? ".");
      const result = await tool.execute(...args);
      if (tool.name === "read") return result;
      return {
        ...result,
        content: result.content.map((block) =>
          block.type === "text"
            ? {
                ...block,
                text: block.text
                  .split("\n")
                  .filter((line) => !GIT_RESULT_LINE.test(line))
                  .join("\n"),
              }
            : block,
        ),
      };
    },
  }));
}
