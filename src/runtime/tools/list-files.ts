import { readdir } from "fs/promises";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { normalizeAllowedRoots, resolveAllowedPath } from "./path-guard";

const ListFilesParameters = Type.Object({
  path: Type.String({ default: ".", description: "Directory path." }),
});

export type ListFilesToolOptions = {
  workingDir: string;
  allowedRoots?: string[];
  maxEntries?: number;
};

export function createListFilesTool(
  options: ListFilesToolOptions,
): AgentTool<typeof ListFilesParameters> {
  const allowedRoots = normalizeAllowedRoots([
    options.workingDir,
    ...(options.allowedRoots ?? []),
  ]);
  const maxEntries = options.maxEntries ?? 500;

  return {
    name: "list_files",
    label: "List Files",
    description: "List files and directories directly inside a directory.",
    parameters: ListFilesParameters,
    execute: async (_toolCallId, params) => {
      const path = resolveAllowedPath(
        params.path || ".",
        options.workingDir,
        allowedRoots,
      );
      const entries = await readdir(path, { withFileTypes: true });
      const names = entries
        .slice(0, maxEntries)
        .map(
          (entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`,
        );
      const truncated = entries.length > maxEntries;

      return {
        content: [
          {
            type: "text",
            text: names.join("\n") + (truncated ? "\n...truncated" : ""),
          },
        ],
        details: { path, entries: entries.length, truncated },
      };
    },
  };
}
