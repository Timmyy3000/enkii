import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { confineTools } from "./confine";

const base = mkdtempSync(join(tmpdir(), "enkii-confine-"));
const workspace = join(base, "workspace");
const artifacts = join(base, "artifacts");
const outside = join(base, "outside.txt");
mkdirSync(join(workspace, "src"), { recursive: true });
mkdirSync(join(workspace, ".git"));
mkdirSync(artifacts);
writeFileSync(join(workspace, "src", "ok.ts"), "export const answer = 42;\n");
writeFileSync(
  join(workspace, ".git", "config"),
  "[http]\n\textraheader = AUTHORIZATION: basic GIT_TOKEN_VALUE\n",
);
writeFileSync(join(artifacts, "diff.patch"), "+export const answer = 42;\n");
writeFileSync(outside, "OUTSIDE_SECRET_VALUE\n");
let symlinked = true;
try {
  symlinkSync(outside, join(workspace, "escape.txt"));
} catch {
  symlinked = false;
}
afterAll(() => rmSync(base, { recursive: true, force: true }));

const tools = confineTools(createReadOnlyTools(workspace), workspace, [
  workspace,
  artifacts,
]);
const tool = (name: string) => tools.find((t) => t.name === name)!;
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.map((block) => block.text ?? "").join("\n");
const read = (path: string) =>
  tool("read").execute("id", { path }, undefined as any);

describe("confineTools", () => {
  test("reads workspace files and artifact files", async () => {
    expect(text(await read("src/ok.ts"))).toContain("answer = 42");
    expect(text(await read(join(artifacts, "diff.patch")))).toContain(
      "answer = 42",
    );
  });

  test("rejects paths that escape the allowed roots", async () => {
    await expect(read(outside)).rejects.toThrow("outside the review workspace");
    await expect(read("../outside.txt")).rejects.toThrow(
      "outside the review workspace",
    );
    await expect(read("~/anything")).rejects.toThrow();
    await expect(read("@" + outside)).rejects.toThrow(
      "outside the review workspace",
    );
  });

  test.skipIf(!symlinked)(
    "rejects a committed symlink pointing outside",
    async () => {
      await expect(read("escape.txt")).rejects.toThrow(
        "outside the review workspace",
      );
    },
  );

  test("blocks .git reads and filters .git from listings", async () => {
    await expect(read(".git/config")).rejects.toThrow("inside .git");
    const listing = text(await tool("ls").execute("id", {}, undefined as any));
    expect(listing).toContain("src/");
    expect(listing).not.toContain(".git");
  });

  test("grep never surfaces .git contents", async () => {
    const found = text(
      await tool("grep").execute(
        "id",
        { pattern: "GIT_TOKEN_VALUE|answer" },
        undefined as any,
      ),
    );
    expect(found).toContain("answer = 42");
    expect(found).not.toContain("GIT_TOKEN_VALUE");
  });
});
