import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { loadRequiredRepositorySkill, SkillLoadError } from "./loader";

const tempRoots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "enkii-policy-loader-"));
  tempRoots.push(root);
  await mkdir(join(root, ".enkii"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("loadRequiredRepositorySkill", () => {
  test("loads a repository-owned policy prompt", async () => {
    const root = await workspace();
    await writeFile(
      join(root, ".enkii", "policy-review.md"),
      "Read docs/STYLE.md",
    );

    const loaded = await loadRequiredRepositorySkill({
      skillPath: ".enkii/policy-review.md",
      workspacePath: root,
      label: "policy review",
    });

    expect(loaded.content).toBe("Read docs/STYLE.md");
    expect(loaded.source).toBe(join(root, ".enkii", "policy-review.md"));
  });

  test.each(["../policy.md", ".enkii/../policy.md"])(
    "rejects traversal path %s",
    async (skillPath) => {
      const root = await workspace();
      await expect(
        loadRequiredRepositorySkill({
          skillPath,
          workspacePath: root,
          label: "policy review",
        }),
      ).rejects.toBeInstanceOf(SkillLoadError);
    },
  );

  test("rejects sibling-prefix workspace escapes", async () => {
    const root = await workspace();
    const sibling = `${root}-outside`;
    tempRoots.push(sibling);
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "policy.md"), "outside");

    await expect(
      loadRequiredRepositorySkill({
        skillPath: `../${sibling.split(/[\\/]/).at(-1)}/policy.md`,
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toBeInstanceOf(SkillLoadError);
  });

  test("rejects directories", async () => {
    const root = await workspace();
    await expect(
      loadRequiredRepositorySkill({
        skillPath: ".enkii",
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toBeInstanceOf(SkillLoadError);
  });

  test("rejects absolute and missing paths", async () => {
    const root = await workspace();
    await expect(
      loadRequiredRepositorySkill({
        skillPath: join(root, ".enkii", "policy-review.md"),
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toBeInstanceOf(SkillLoadError);
    await expect(
      loadRequiredRepositorySkill({
        skillPath: ".enkii/missing.md",
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toThrow("not found");
  });

  test("rejects oversized prompt files", async () => {
    const root = await workspace();
    await writeFile(
      join(root, ".enkii", "policy-review.md"),
      "x".repeat(256 * 1024 + 1),
    );
    await expect(
      loadRequiredRepositorySkill({
        skillPath: ".enkii/policy-review.md",
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toThrow("cap is 256 KB");
  });

  const symlinkTest = process.platform === "win32" ? test.skip : test;
  symlinkTest("rejects symlinked prompt files", async () => {
    const root = await workspace();
    await writeFile(join(root, "policy-target.md"), "target");
    await symlink(
      join(root, "policy-target.md"),
      join(root, ".enkii", "policy-review.md"),
    );

    await expect(
      loadRequiredRepositorySkill({
        skillPath: ".enkii/policy-review.md",
        workspacePath: root,
        label: "policy review",
      }),
    ).rejects.toBeInstanceOf(SkillLoadError);
  });
});
