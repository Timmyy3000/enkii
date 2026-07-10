/**
 * Load review / security-review skill content from disk.
 *
 * Two modes:
 *   1. Default: load the bundled skill at <action_path>/skills/<name>.md.
 *   2. Override: load a consumer-supplied skill from <workspace>/<override_path>.
 *
 * Safety rules:
 *   - Override paths resolve only against $GITHUB_WORKSPACE — no ".." traversal.
 *   - Skill files are capped at 256 KB to keep prompt budgets predictable.
 *   - On fork PRs, override paths are refused and the bundled default is used
 *     (a malicious fork PR could otherwise commit a hostile skill that exfils
 *     secrets — same threat model as GitHub's pull_request_target docs).
 */

import { lstat, readFile } from "fs/promises";
import { isAbsolute, relative, resolve, sep } from "path";

export type SkillKind = "review" | "security-review";

export type LoadSkillOptions = {
  /** Which bundled skill to fall back to: "review" → skills/review.md, etc. */
  kind: SkillKind;
  /** Optional consumer override path (relative to $GITHUB_WORKSPACE). Empty/undefined → use bundled. */
  overridePath?: string;
  /** Action path on disk — typically $GITHUB_ACTION_PATH. Bundled skill resolves under this. */
  actionPath: string;
  /** Consumer workspace path — typically $GITHUB_WORKSPACE. Override paths resolve under this. */
  workspacePath: string;
  /** Whether the current event is a PR from a fork. If true, override paths are refused. */
  isForkPR: boolean;
};

export type LoadSkillResult = {
  content: string;
  /** Absolute path of the file actually read. */
  source: string;
  /** True if the bundled default was used (either by absence of override or by fork-PR refusal). */
  usedBundled: boolean;
  /** True if an override was requested but refused due to fork-PR policy. */
  refusedForkOverride: boolean;
};

const MAX_SKILL_BYTES = 256 * 1024;

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export async function loadRequiredRepositorySkill(options: {
  skillPath: string;
  workspacePath: string;
  label: string;
}): Promise<{ content: string; source: string }> {
  const { skillPath, workspacePath, label } = options;
  const trimmedPath = skillPath.trim();
  if (!trimmedPath) {
    throw new SkillLoadError(`enkii: ${label} path is empty.`);
  }
  if (isAbsolute(trimmedPath) || trimmedPath.split(/[\\/]+/).includes("..")) {
    throw invalidRepositoryPath(label, skillPath);
  }

  const workspaceRoot = resolve(workspacePath);
  const source = resolve(workspaceRoot, trimmedPath);
  const relativeSource = relative(workspaceRoot, source);
  if (
    relativeSource === ".." ||
    relativeSource.startsWith(`..${sep}`) ||
    isAbsolute(relativeSource)
  ) {
    throw invalidRepositoryPath(label, skillPath);
  }

  await rejectSymlinkedPath(workspaceRoot, relativeSource, label);
  return { content: await readSkillFile(source, label), source };
}

export async function loadSkill(
  options: LoadSkillOptions,
): Promise<LoadSkillResult> {
  const { kind, overridePath, actionPath, workspacePath, isForkPR } = options;

  const bundledPath = resolve(actionPath, "skills", `${kind}.md`);

  // Override requested?
  if (overridePath && overridePath.trim() !== "") {
    if (isForkPR) {
      console.warn(
        `enkii: refusing to load skill override "${overridePath}" on a fork PR. Using bundled default.`,
      );
      const content = await readSkillFile(bundledPath);
      return {
        content,
        source: bundledPath,
        usedBundled: true,
        refusedForkOverride: true,
      };
    }

    const loaded = await loadRequiredRepositorySkill({
      skillPath: overridePath,
      workspacePath,
      label: `${kind} skill`,
    });
    return {
      content: loaded.content,
      source: loaded.source,
      usedBundled: false,
      refusedForkOverride: false,
    };
  }

  const content = await readSkillFile(bundledPath);
  return {
    content,
    source: bundledPath,
    usedBundled: true,
    refusedForkOverride: false,
  };
}

async function rejectSymlinkedPath(
  workspaceRoot: string,
  relativeSource: string,
  label: string,
): Promise<void> {
  let current = workspaceRoot;
  for (const segment of relativeSource.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      throw new SkillLoadError(
        `enkii: ${label} file not found at "${current}". ` +
          `Fix: check the path exists and is committed relative to the repo root.`,
      );
    }
    if (info.isSymbolicLink()) {
      throw new SkillLoadError(
        `enkii: ${label} path "${current}" contains a symbolic link. ` +
          `Fix: commit a regular Markdown file inside the repository.`,
      );
    }
  }
}

function invalidRepositoryPath(label: string, path: string): SkillLoadError {
  return new SkillLoadError(
    `enkii: ${label} path "${path}" is invalid. ` +
      `Cause: paths must be relative to repo root and cannot contain "..". ` +
      `Fix: use a path like ".enkii/policy-review.md" relative to your repo root.`,
  );
}

async function readSkillFile(path: string, label = "skill"): Promise<string> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new SkillLoadError(
      `enkii: ${label} file not found at "${path}". ` +
        `Fix: check the path exists and is committed; for overrides, the path is relative to your repo root.`,
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SkillLoadError(
      `enkii: ${label} path "${path}" is not a regular file (symlinks and directories not allowed).`,
    );
  }
  if (info.size > MAX_SKILL_BYTES) {
    throw new SkillLoadError(
      `enkii: ${label} file "${path}" is ${(info.size / 1024).toFixed(0)} KB; cap is 256 KB. ` +
        `Fix: trim the skill content. Consider splitting into multiple skills (v1 feature).`,
    );
  }
  return await readFile(path, "utf8");
}
