import { readFile } from "fs/promises";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { normalizeAllowedRoots, resolveAllowedPath } from "./path-guard";

const ReadFileParameters = Type.Object({
  path: Type.String({
    description: "Absolute path or path relative to the repository root.",
  }),
});

export type ReadFileToolOptions = {
  workingDir: string;
  allowedRoots?: string[];
  maxBytes?: number;
};

export function createReadFileTool(
  options: ReadFileToolOptions,
): AgentTool<typeof ReadFileParameters> {
  const allowedRoots = normalizeAllowedRoots([
    options.workingDir,
    ...(options.allowedRoots ?? []),
  ]);
  const maxBytes = options.maxBytes ?? 200_000;

  return {
    name: "read_file",
    label: "Read File",
    description:
      "Read a UTF-8 text file. Use this for PR diffs, descriptions, comments, and source files.",
    parameters: ReadFileParameters,
    execute: async (_toolCallId, params) => {
      const path = resolveAllowedPath(
        params.path,
        options.workingDir,
        allowedRoots,
      );
      const content = await readFile(path, "utf8");
      const truncated = content.length > maxBytes;

      return {
        content: [
          {
            type: "text",
            text: truncated ? content.slice(0, maxBytes) : content,
          },
        ],
        details: { path, size: content.length, truncated },
      };
    },
  };
}
