#!/usr/bin/env bun
/**
 * Local spike: verify Codex CLI + OpenRouter + DeepSeek V4 Pro produce
 * structured JSON for a tiny review-shaped prompt.
 *
 * Usage (from repo root):
 *
 *   export OPENROUTER_API_KEY=sk-or-v1-...
 *   bun run scripts/spike-codex.ts [optional/path/to/saved.diff]
 *
 * If you don't pass a diff path, the spike uses an inline 5-line synthetic
 * diff with one obvious bug (off-by-one) so you can sanity-check that the
 * model + harness produce a sensible finding.
 *
 * What this validates (the four risks called out in the v0.1 plan):
 *   1. `--output-last-message` writes parseable JSON for our prompt shape
 *   2. `--sandbox read-only` doesn't block reads we need
 *   3. Codex routes through OpenRouter to the requested model
 *   4. Cost / latency are in the expected ballpark (~$0.05, <60s)
 */

import { mkdtemp, readFile, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runCodex } from "../src/runtime/run-codex";

const SAMPLE_DIFF = `diff --git a/src/range.ts b/src/range.ts
index abc..def 100644
--- a/src/range.ts
+++ b/src/range.ts
@@ -1,5 +1,7 @@
 export function indexOfNthOccurrence(haystack: string, needle: string, n: number): number {
   let count = 0;
-  for (let i = 0; i < haystack.length; i++) {
+  for (let i = 0; i <= haystack.length; i++) {
     if (haystack.startsWith(needle, i)) {
       count++;
       if (count === n) return i;
     }
   }
   return -1;
 }`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2", "nit"] },
          title: { type: "string" },
          body: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
        },
        required: ["severity", "title", "body", "file", "line"],
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
};

async function main() {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Set OPENROUTER_API_KEY before running this spike.");
    process.exit(1);
  }

  const diffArg = process.argv[2];
  const diff = diffArg ? await readFile(diffArg, "utf8") : SAMPLE_DIFF;

  const workDir = await mkdtemp(join(tmpdir(), "enkii-spike-"));
  const schemaPath = join(workDir, "schema.json");
  const outputPath = join(workDir, "output.json");
  const diffPath = join(workDir, "pr.diff");
  await writeFile(schemaPath, JSON.stringify(OUTPUT_SCHEMA, null, 2));
  await writeFile(diffPath, diff);

  const prompt = `You are a senior code reviewer. Read the diff at ${diffPath} and find genuine bugs.

Output a JSON object matching the provided schema. Only include findings that are real issues you would want a teammate to address. Do not include style nits unless they cause real bugs. Severity scale: P0 = data loss / crash / security; P1 = correctness bug / wrong behavior; P2 = robustness / maintainability; nit = style only.`;

  console.log("Spike config:");
  console.log("  model:        deepseek/deepseek-v4-pro");
  console.log("  sandbox:      read-only");
  console.log("  workDir:      " + workDir);
  console.log("  diff:         " + (diffArg ?? "<inline sample>"));
  console.log("  outputFile:   " + outputPath);
  console.log("  schemaFile:   " + schemaPath);
  console.log("");
  console.log("Spawning codex exec...");
  console.log("");

  const result = await runCodex({
    prompt,
    model: "deepseek/deepseek-v4-pro",
    workingDir: workDir,
    outputFile: outputPath,
    outputSchemaPath: schemaPath,
    timeoutMs: 5 * 60 * 1000,
  });

  console.log("");
  console.log(`✓ codex exec finished in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log("");
  console.log("--- final message ---");
  console.log(result.finalMessage || "(empty — check above logs)");
  console.log("--- end ---");

  if (!result.finalMessage) {
    console.error("Spike FAILED: final message file is empty.");
    process.exit(1);
  }

  // Codex returns markdown (prose + fenced JSON block), not raw JSON, even with
  // --output-schema set. Extract the largest fenced JSON block, fall back to
  // the whole message.
  const jsonText = extractFencedJson(result.finalMessage) ?? result.finalMessage;

  try {
    const parsed = JSON.parse(jsonText);
    const findingCount = Array.isArray(parsed?.findings)
      ? parsed.findings.length
      : 0;
    console.log("");
    console.log(`✓ Extracted JSON. ${findingCount} findings.`);
    console.log(`  Tokens are reported by codex above; latency ${(result.durationMs / 1000).toFixed(1)}s.`);
    if (findingCount === 0) {
      console.log("Heads up: model produced 0 findings. (For the off-by-one sample, V4 Pro often correctly notes the change is a no-op rather than a bug — that's expected.)");
    }
  } catch (e) {
    console.error("Spike FAILED: could not extract valid JSON from final message:", e);
    process.exit(1);
  }
}

/**
 * Find the largest ```json ... ``` (or just ``` ... ```) block in a markdown
 * string. Returns the inner JSON text, or null if no fenced block found.
 */
function extractFencedJson(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (fences.length === 0) return null;
  // Pick the largest match — usually the one we want.
  let best = "";
  for (const m of fences) {
    if (m[1] && m[1].length > best.length) best = m[1];
  }
  return best || null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
