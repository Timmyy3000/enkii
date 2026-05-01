/**
 * Two-pass review orchestrator. Used for both code review (`@enkii /review`,
 * pull_request) and security review (`@enkii /security`).
 *
 * The flow is identical for both kinds:
 *   1. Write JSON Schemas to disk so Codex can constrain its output.
 *   2. Pass 1 — Codex generates candidate findings via the kind-specific
 *      Pass 1 prompt + the loaded skill content.
 *   3. Extract + zod-validate the candidates JSON, write to disk.
 *   4. Pass 2 — Codex re-verifies each candidate against source via the
 *      validator prompt + the same skill content.
 *   5. Extract + zod-validate the validated JSON, write to disk.
 *
 * Output paths differ per kind so code + security runs don't collide on
 * disk if both fire on the same PR.
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
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
import { generateSecurityCandidatesPrompt } from "../../prompts/security-review";
import { generateReviewValidatorPrompt } from "../../prompts/validator";
import type { PreparedContext } from "../../prompts/types";

export type ReviewKind = "code" | "security";

export type RunReviewOptions = {
  kind: ReviewKind;
  preparedContext: PreparedContext;
  workingDir: string;
  model: string;
  /** Where to write candidates.json + validated.json + schema files. */
  promptsDir: string;
};

export type RunReviewResult = {
  kind: ReviewKind;
  candidatesPath: string;
  validatedPath: string;
  candidates: CandidatesPass;
  validated: ValidatedPass;
};

export async function runReview(
  options: RunReviewOptions,
): Promise<RunReviewResult> {
  const { kind, preparedContext, workingDir, model, promptsDir } = options;

  await mkdir(promptsDir, { recursive: true });

  const filePrefix = kind === "security" ? "security" : "review";
  const candidatesSchemaPath = join(
    promptsDir,
    `${filePrefix}_candidates_schema.json`,
  );
  const validatedSchemaPath = join(
    promptsDir,
    `${filePrefix}_validated_schema.json`,
  );
  const candidatesPath = join(promptsDir, `${filePrefix}_candidates.json`);
  const validatedPath = join(promptsDir, `${filePrefix}_validated.json`);
  const candidatesOutFile = join(
    promptsDir,
    `${filePrefix}_pass1_codex_message.txt`,
  );
  const validatedOutFile = join(
    promptsDir,
    `${filePrefix}_pass2_codex_message.txt`,
  );

  await writeFile(
    candidatesSchemaPath,
    JSON.stringify(CANDIDATES_OUTPUT_SCHEMA, null, 2),
  );
  await writeFile(
    validatedSchemaPath,
    JSON.stringify(VALIDATED_OUTPUT_SCHEMA, null, 2),
  );

  // Pass 1 — candidates
  console.log(`enkii: starting ${kind} Pass 1 (candidates)...`);
  const pass1Prompt =
    kind === "security"
      ? generateSecurityCandidatesPrompt(preparedContext)
      : generateReviewCandidatesPrompt(preparedContext);

  const pass1 = await runCodex({
    prompt: pass1Prompt,
    model,
    workingDir,
    outputFile: candidatesOutFile,
    outputSchemaPath: candidatesSchemaPath,
  });

  console.log(
    `enkii: ${kind} Pass 1 finished in ${(pass1.durationMs / 1000).toFixed(1)}s`,
  );

  const candidatesRaw = extractAndParseJson(pass1.finalMessage);
  const candidates = CandidatesPassSchema.safeParse(candidatesRaw);
  if (!candidates.success) {
    throw new Error(
      `enkii: ${kind} Pass 1 output failed schema validation. ` +
        `Cause: ${candidates.error.message}. ` +
        `Fix: this is usually a transient model output issue — retry with @enkii /${kind === "security" ? "security" : "review"}.`,
    );
  }
  await writeFile(candidatesPath, JSON.stringify(candidates.data, null, 2));
  console.log(
    `enkii: ${kind} Pass 1 produced ${candidates.data.comments.length} candidates → ${candidatesPath}`,
  );

  // Pass 2 — validator. The validator prompt template reads paths from these
  // env vars, so we point them at the kind-specific files before invoking.
  console.log(`enkii: starting ${kind} Pass 2 (validator)...`);
  process.env.REVIEW_CANDIDATES_PATH = candidatesPath;
  process.env.REVIEW_VALIDATED_PATH = validatedPath;
  const pass2Prompt = generateReviewValidatorPrompt(preparedContext);

  const pass2 = await runCodex({
    prompt: pass2Prompt,
    model,
    workingDir,
    outputFile: validatedOutFile,
    outputSchemaPath: validatedSchemaPath,
  });

  console.log(
    `enkii: ${kind} Pass 2 finished in ${(pass2.durationMs / 1000).toFixed(1)}s`,
  );

  const validatedRaw = extractAndParseJson(pass2.finalMessage);
  const validated = ValidatedPassSchema.safeParse(validatedRaw);
  if (!validated.success) {
    throw new Error(
      `enkii: ${kind} Pass 2 output failed schema validation. ` +
        `Cause: ${validated.error.message}. ` +
        `Fix: retry with @enkii /${kind === "security" ? "security" : "review"}. The Pass 1 candidates are at ${candidatesPath} for inspection.`,
    );
  }
  await writeFile(validatedPath, JSON.stringify(validated.data, null, 2));

  const approvedCount = validated.data.results.filter(
    (r) => r.status === "approved",
  ).length;
  const rejectedCount = validated.data.results.length - approvedCount;
  console.log(
    `enkii: ${kind} Pass 2 → ${approvedCount} approved, ${rejectedCount} rejected → ${validatedPath}`,
  );

  return {
    kind,
    candidatesPath,
    validatedPath,
    candidates: candidates.data,
    validated: validated.data,
  };
}

export async function runCodeReview(args: {
  preparedContext: PreparedContext;
  workingDir: string;
  reviewModel: string;
  promptsDir: string;
}): Promise<RunReviewResult> {
  return runReview({
    kind: "code",
    preparedContext: args.preparedContext,
    workingDir: args.workingDir,
    model: args.reviewModel,
    promptsDir: args.promptsDir,
  });
}

export async function runSecurityReview(args: {
  preparedContext: PreparedContext;
  workingDir: string;
  securityModel: string;
  promptsDir: string;
}): Promise<RunReviewResult> {
  return runReview({
    kind: "security",
    preparedContext: args.preparedContext,
    workingDir: args.workingDir,
    model: args.securityModel,
    promptsDir: args.promptsDir,
  });
}
