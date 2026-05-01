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

import { readFile, stat } from "fs/promises";
import { resolve, isAbsolute } from "path";

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

    if (isAbsolute(overridePath) || overridePath.includes("..")) {
      throw new SkillLoadError(
        `enkii: skill path "${overridePath}" is invalid. ` +
          `Cause: paths must be relative to repo root and cannot contain "..". ` +
          `Fix: use a path like ".enkii/review.md" relative to your repo root.`,
      );
    }

    const resolved = resolve(workspacePath, overridePath);
    if (!resolved.startsWith(workspacePath)) {
      throw new SkillLoadError(
        `enkii: skill path "${overridePath}" resolves outside the workspace. ` +
          `Fix: use a path within your repo.`,
      );
    }

    const content = await readSkillFile(resolved);
    return {
      content,
      source: resolved,
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

async function readSkillFile(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new SkillLoadError(
      `enkii: skill file not found at "${path}". ` +
        `Fix: check the path exists and is committed; for overrides, the path is relative to your repo root.`,
    );
  }
  if (!info.isFile()) {
    throw new SkillLoadError(
      `enkii: skill path "${path}" is not a regular file (symlinks and directories not allowed).`,
    );
  }
  if (info.size > MAX_SKILL_BYTES) {
    throw new SkillLoadError(
      `enkii: skill file "${path}" is ${(info.size / 1024).toFixed(0)} KB; cap is 256 KB. ` +
        `Fix: trim the skill content. Consider splitting into multiple skills (v1 feature).`,
    );
  }
  return await readFile(path, "utf8");
}
