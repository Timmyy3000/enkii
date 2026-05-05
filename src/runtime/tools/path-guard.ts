import { relative, resolve } from "path";

export function normalizeAllowedRoots(paths: string[]): string[] {
  const roots = paths.map((p) => resolve(p));
  return [...new Set(roots)];
}

export function resolveAllowedPath(
  requestedPath: string,
  workingDir: string,
  allowedRoots: string[],
): string {
  const absolute = resolve(workingDir, requestedPath);
  const matched = allowedRoots.some((root) => {
    const rel = relative(root, absolute);
    return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
  });

  if (!matched) {
    throw new Error(`Path is outside allowed roots: ${requestedPath}`);
  }

  return absolute;
}
