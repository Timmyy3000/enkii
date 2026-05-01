/**
 * Code review orchestrator: Pass 1 (candidates) → Pass 2 (validator).
 *
 * Inputs:
 *   - Pre-fetched PR data artifacts (pr.diff, existing_comments.json, pr_description.txt)
 *   - Loaded skill content
 *   - Codex runtime + extractor
 *
 * Outputs (written to runner.temp/enkii-prompts/):
 *   - review_candidates.json — Pass 1 result
 *   - review_validated.json  — Pass 2 result (what the post step consumes)
 */

import { writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { runCodex } from "../../runtime/run-codex";
import { extractAndParseJson } from "../../runtime/extract-json";
import {
  CandidatesPassSchema,
  ValidatedPassSchema,
  CANDIDATES_OUTPUT_SCHEMA,
  VALIDATED_OUTPUT_SCHEMA,
  type CandidatesPass,
  type ValidatedPass,
} from "../../runtime/schemas";
import { generateReviewCandidatesPrompt } from "../../prompts/candidates";
import { generateReviewValidatorPrompt } from "../../prompts/validator";
import type { PreparedContext } from "../../prompts/types";

export type RunReviewOptions = {
  preparedContext: PreparedContext;
  workingDir: string;
  reviewModel: string;
  /** Where to write candidates.json + validated.json + schema files. */
  promptsDir: string;
};

export type RunReviewResult = {
  candidatesPath: string;
  validatedPath: string;
  candidates: CandidatesPass;
  validated: ValidatedPass;
};

export async function runCodeReview(
  options: RunReviewOptions,
): Promise<RunReviewResult> {
  const { preparedContext, workingDir, reviewModel, promptsDir } = options;

  await mkdir(promptsDir, { recursive: true });

  const candidatesSchemaPath = join(promptsDir, "candidates_schema.json");
  const validatedSchemaPath = join(promptsDir, "validated_schema.json");
  const candidatesPath = join(promptsDir, "review_candidates.json");
  const validatedPath = join(promptsDir, "review_validated.json");
  const candidatesOutFile = join(promptsDir, "pass1_codex_message.txt");
  const validatedOutFile = join(promptsDir, "pass2_codex_message.txt");

  await writeFile(
    candidatesSchemaPath,
    JSON.stringify(CANDIDATES_OUTPUT_SCHEMA, null, 2),
  );
  await writeFile(
    validatedSchemaPath,
    JSON.stringify(VALIDATED_OUTPUT_SCHEMA, null, 2),
  );

  // Pass 1 — candidates
  console.log("enkii: starting Pass 1 (candidates)...");
  const pass1Prompt = generateReviewCandidatesPrompt({
    ...preparedContext,
    // Tell the candidates template where to write so the model knows the path.
    // (The orchestrator also reads it back from the file we passed via output-last-message.)
  });

  const pass1 = await runCodex({
    prompt: pass1Prompt,
    model: reviewModel,
    workingDir,
    outputFile: candidatesOutFile,
    outputSchemaPath: candidatesSchemaPath,
  });

  console.log(
    `enkii: Pass 1 finished in ${(pass1.durationMs / 1000).toFixed(1)}s`,
  );

  const candidatesRaw = extractAndParseJson(pass1.finalMessage);
  const candidates = CandidatesPassSchema.safeParse(candidatesRaw);
  if (!candidates.success) {
    throw new Error(
      `enkii: Pass 1 output failed schema validation. ` +
        `Cause: ${candidates.error.message}. ` +
        `Fix: this is usually a transient model output issue — retry with @enkii /review.`,
    );
  }
  await writeFile(candidatesPath, JSON.stringify(candidates.data, null, 2));
  console.log(
    `enkii: Pass 1 produced ${candidates.data.comments.length} candidates → ${candidatesPath}`,
  );

  // Pass 2 — validator
  console.log("enkii: starting Pass 2 (validator)...");
  process.env.REVIEW_CANDIDATES_PATH = candidatesPath;
  process.env.REVIEW_VALIDATED_PATH = validatedPath;
  const pass2Prompt = generateReviewValidatorPrompt(preparedContext);

  const pass2 = await runCodex({
    prompt: pass2Prompt,
    model: reviewModel,
    workingDir,
    outputFile: validatedOutFile,
    outputSchemaPath: validatedSchemaPath,
  });

  console.log(
    `enkii: Pass 2 finished in ${(pass2.durationMs / 1000).toFixed(1)}s`,
  );

  const validatedRaw = extractAndParseJson(pass2.finalMessage);
  const validated = ValidatedPassSchema.safeParse(validatedRaw);
  if (!validated.success) {
    throw new Error(
      `enkii: Pass 2 output failed schema validation. ` +
        `Cause: ${validated.error.message}. ` +
        `Fix: retry with @enkii /review. The Pass 1 candidates file is at ${candidatesPath} for inspection.`,
    );
  }
  await writeFile(validatedPath, JSON.stringify(validated.data, null, 2));

  const approvedCount = validated.data.results.filter(
    (r) => r.status === "approved",
  ).length;
  const rejectedCount = validated.data.results.length - approvedCount;
  console.log(
    `enkii: Pass 2 → ${approvedCount} approved, ${rejectedCount} rejected → ${validatedPath}`,
  );

  return {
    candidatesPath,
    validatedPath,
    candidates: candidates.data,
    validated: validated.data,
  };
}

// Avoid unused import warning until we wire the prompts dir consumer.
void dirname;
