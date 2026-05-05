/**
 * Review orchestrator. Used for both code review and security review.
 *
 * Single-pass mode (default): Pass 1 produces post-ready candidates; we
 * synthesize a validated.json by approving everything and the post step runs
 * unchanged. Halves wall time vs two-pass.
 *
 * Two-pass mode (`enableValidator`): Pass 1 → validator Pass 2 re-checks each
 * candidate. Higher quality, ~2× latency.
 *
 * Output paths differ per kind so concurrent code + security runs don't
 * collide on disk.
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { join } from "path";
import type { ZodTypeAny, infer as zInfer } from "zod";
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
  /** When true, run Pass 2 validator. When false, post Pass 1 directly. */
  enableValidator?: boolean;
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
  const {
    kind,
    preparedContext,
    workingDir,
    model,
    promptsDir,
    enableValidator = false,
  } = options;

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
  if (enableValidator) {
    await writeFile(
      validatedSchemaPath,
      JSON.stringify(VALIDATED_OUTPUT_SCHEMA, null, 2),
    );
  }

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

  const candidates = await loadPassOutput(
    `${kind} Pass 1`,
    candidatesPath,
    pass1.finalMessage,
    CandidatesPassSchema,
    kind,
  );
  await writeFile(candidatesPath, JSON.stringify(candidates, null, 2));
  console.log(
    `enkii: ${kind} Pass 1 produced ${candidates.comments.length} candidates → ${candidatesPath}`,
  );

  let validated: ValidatedPass;

  if (enableValidator) {
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

    validated = await loadPassOutput(
      `${kind} Pass 2`,
      validatedPath,
      pass2.finalMessage,
      ValidatedPassSchema,
      kind,
    );
    await writeFile(validatedPath, JSON.stringify(validated, null, 2));

    const approvedCount = validated.results.filter(
      (r) => r.status === "approved",
    ).length;
    const rejectedCount = validated.results.length - approvedCount;
    console.log(
      `enkii: ${kind} Pass 2 → ${approvedCount} approved, ${rejectedCount} rejected → ${validatedPath}`,
    );
  } else {
    validated = synthesizeValidatedFromCandidates(candidates);
    await writeFile(validatedPath, JSON.stringify(validated, null, 2));
    console.log(
      `enkii: ${kind} single-pass → ${validated.results.length} comments → ${validatedPath}`,
    );
  }

  return {
    kind,
    candidatesPath,
    validatedPath,
    candidates,
    validated,
  };
}

function synthesizeValidatedFromCandidates(
  candidates: CandidatesPass,
): ValidatedPass {
  return {
    version: 1,
    meta: {
      repo: candidates.meta.repo,
      prNumber: candidates.meta.prNumber,
      headSha: candidates.meta.headSha,
      baseRef: candidates.meta.baseRef,
      validatedAt: new Date().toISOString(),
    },
    results: candidates.comments.map((c) => ({
      status: "approved" as const,
      comment: c,
    })),
    reviewSummary: candidates.reviewSummary
      ? {
          status: "approved" as const,
          body: candidates.reviewSummary.body,
        }
      : undefined,
  };
}

async function loadPassOutput<S extends ZodTypeAny>(
  passName: string,
  filePath: string,
  finalMessage: string,
  schema: S,
  kind: ReviewKind,
): Promise<zInfer<S>> {
  const command = kind === "security" ? "security" : "review";

  const sources: { label: string; text: string }[] = [];
  try {
    sources.push({ label: `file ${filePath}`, text: await readFile(filePath, "utf8") });
  } catch {
    // Model didn't write the file; fall through to final message.
  }
  sources.push({ label: "Codex final message", text: finalMessage });

  const errors: string[] = [];
  for (const { label, text } of sources) {
    try {
      const parsed = extractAndParseJson(text);
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;
      errors.push(`${label}: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    } catch (err) {
      errors.push(`${label}: ${(err as Error).message}`);
    }
  }

  throw new Error(
    `enkii: ${passName} output failed schema validation. ` +
      `Cause: ${errors.join(" | ")}. ` +
      `Fix: retry with @enkii /${command}. If repeated, the model may not be honoring the output schema.`,
  );
}

export async function runCodeReview(args: {
  preparedContext: PreparedContext;
  workingDir: string;
  reviewModel: string;
  promptsDir: string;
  enableValidator?: boolean;
}): Promise<RunReviewResult> {
  return runReview({
    kind: "code",
    preparedContext: args.preparedContext,
    workingDir: args.workingDir,
    model: args.reviewModel,
    promptsDir: args.promptsDir,
    enableValidator: args.enableValidator,
  });
}

export async function runSecurityReview(args: {
  preparedContext: PreparedContext;
  workingDir: string;
  securityModel: string;
  promptsDir: string;
  enableValidator?: boolean;
}): Promise<RunReviewResult> {
  return runReview({
    kind: "security",
    preparedContext: args.preparedContext,
    workingDir: args.workingDir,
    model: args.securityModel,
    promptsDir: args.promptsDir,
    enableValidator: args.enableValidator,
  });
}
