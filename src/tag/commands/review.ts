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

import { writeFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { createReadOnlyTools } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import type { infer as zInfer, ZodTypeAny } from "zod";
import { runAgent, type RunAgentResult } from "../../runtime/run-agent";
import {
  createSubmitCandidatesTool,
  createSubmitValidatedTool,
} from "../../runtime/tools/submit";
import {
  CandidatesPassSchema,
  ValidatedPassSchema,
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
  /** Where to write candidates.json + validated.json files. */
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
  pass1: ReviewPassMetrics;
  pass2?: ReviewPassMetrics;
};

export type ReviewPassMetrics = Pick<
  RunAgentResult<unknown>,
  "durationMs" | "toolCallCount" | "usage"
>;

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
  const candidatesPath = join(promptsDir, `${filePrefix}_candidates.json`);
  const validatedPath = join(promptsDir, `${filePrefix}_validated.json`);

  console.log(`enkii: starting ${kind} Pass 1 (candidates)...`);
  const pass1Prompt =
    kind === "security"
      ? generateSecurityCandidatesPrompt(preparedContext)
      : generateReviewCandidatesPrompt(preparedContext);

  let candidatesOutput: unknown;
  const pass1 = await runAgent({
    systemPrompt:
      "You are enkii's code review runtime. Use tools to inspect files and submit structured output.",
    userPrompt: pass1Prompt,
    model,
    tools: [
      ...createContextTools(workingDir, preparedContext),
      createSubmitCandidatesTool((args) => {
        candidatesOutput = args;
      }),
    ],
    outputToolName: "submit_review",
    getOutput: () => candidatesOutput,
    logPrefix: kind,
  });

  console.log(
    `enkii: ${kind} Pass 1 finished in ${(pass1.durationMs / 1000).toFixed(1)}s`,
  );

  const candidates = parsePassOutput(
    `${kind} Pass 1`,
    pass1.output,
    CandidatesPassSchema,
    kind,
  );
  await writeFile(candidatesPath, JSON.stringify(candidates, null, 2));
  console.log(
    `enkii: ${kind} Pass 1 produced ${candidates.comments.length} candidates → ${candidatesPath}`,
  );

  let validated: ValidatedPass;
  let pass2Metrics: ReviewPassMetrics | undefined;

  if (enableValidator) {
    console.log(`enkii: starting ${kind} Pass 2 (validator)...`);
    process.env.REVIEW_CANDIDATES_PATH = candidatesPath;
    process.env.REVIEW_VALIDATED_PATH = validatedPath;
    const pass2Prompt = generateReviewValidatorPrompt(preparedContext);

    let validatedOutput: unknown;
    const pass2 = await runAgent({
      systemPrompt:
        "You are enkii's review validation runtime. Use tools to inspect files and submit structured validation output.",
      userPrompt: pass2Prompt,
      model,
      tools: [
        ...createContextTools(workingDir, preparedContext, [candidatesPath]),
        createSubmitValidatedTool((args) => {
          validatedOutput = args;
        }),
      ],
      outputToolName: "submit_validation",
      getOutput: () => validatedOutput,
      logPrefix: `${kind}:validator`,
    });
    pass2Metrics = pass2;

    console.log(
      `enkii: ${kind} Pass 2 finished in ${(pass2.durationMs / 1000).toFixed(1)}s`,
    );

    validated = parsePassOutput(
      `${kind} Pass 2`,
      pass2.output,
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
    pass1,
    pass2: pass2Metrics,
  };
}

function createContextTools(
  workingDir: string,
  context: PreparedContext,
  extraAllowedPaths: string[] = [],
) {
  const artifactPaths = context.reviewArtifacts
    ? [
        context.reviewArtifacts.diffPath,
        context.reviewArtifacts.commentsPath,
        context.reviewArtifacts.descriptionPath,
      ]
    : [];
  const allowedRoots = [
    workingDir,
    ...artifactPaths.map((path) => dirname(path)),
    ...extraAllowedPaths.map((path) => dirname(path)),
  ];

  return [
    ...createReadOnlyTools(workingDir),
    createArtifactPathsTool(allowedRoots),
  ];
}

function createArtifactPathsTool(allowedRoots: string[]) {
  return {
    name: "artifact_paths",
    label: "Artifact Paths",
    description:
      "List the precomputed review artifact directories available as absolute paths.",
    parameters: Type.Object({}),
    executionMode: "sequential" as const,
    execute: async () => ({
      content: [
        {
          type: "text" as const,
          text:
            "Precomputed artifact roots:\n" +
            [...new Set(allowedRoots)].map((path) => `- ${path}`).join("\n"),
        },
      ],
      details: { roots: allowedRoots },
    }),
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

function parsePassOutput<S extends ZodTypeAny>(
  passName: string,
  output: unknown,
  schema: S,
  kind: ReviewKind,
): zInfer<S> {
  const command = kind === "security" ? "security" : "review";
  const result = schema.safeParse(output);
  if (result.success) return result.data;

  throw new Error(
    `enkii: ${passName} output failed schema validation. ` +
      `Cause: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}. ` +
      `Fix: retry with @enkii /${command}. If repeated, the model may not be honoring the submit tool schema.`,
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
