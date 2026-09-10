#!/usr/bin/env bun

/**
 * Single unified entrypoint. Handles the full enkii pipeline in one process:
 * env validation → context parse → trigger detection → dispatch → run reviews
 * (code + security + configured policy review in parallel) → post.
 *
 * Inputs (env):
 *   - OPENROUTER_API_KEY        (required)
 *   - OVERRIDE_GITHUB_TOKEN     (custom GitHub App token; falls back to runner token)
 *   - REVIEW_MODEL              (default "@preset/enkii")
 *   - SECURITY_MODEL            (default "@preset/enkii")
 *   - REVIEW_SKILL_PATH         (optional consumer override)
 *   - SECURITY_SKILL_PATH       (optional consumer override)
 *   - POLICY_REVIEW_SKILL_PATH  (optional repository-owned policy prompt; empty disables)
 *   - POLICY_REVIEW_MODEL       (empty inherits REVIEW_MODEL)
 *   - ENABLE_VALIDATOR          ("true" | "false", default "false") — Pass 2
 *   - RUN_SECURITY              ("true" | "false", default "true")  — auto-run security on PR events
 *   - GITHUB_ACTION_PATH        (set by runner; bundled skills live here)
 *   - GITHUB_WORKSPACE          (set by runner; consumer skill overrides resolve here)
 *   - RUNNER_TEMP               (set by runner; artifacts go under <RUNNER_TEMP>/enkii-prompts/)
 */

import * as core from "@actions/core";
import { basename, join } from "path";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { createOctokit } from "../github/api/client";
import { parseGitHubContext, isEntityContext } from "../github/context";
import { fetchPRBranchData } from "../github/data/pr-fetcher";
import { computeReviewArtifacts } from "../github/data/review-artifacts";
import { checkoutPullRequestHead } from "../github/data/pr-checkout";
import { loadRequiredRepositorySkill, loadSkill } from "../skills/loader";
import { shouldTriggerTag, prepareTagExecution } from "../tag";
import {
  runCodeReview,
  runPolicyReview,
  runSecurityReview,
  type ReviewKind,
  type RunReviewResult,
} from "../tag/commands/review";
import {
  postReviewFromValidated,
  ENKII_REVIEW_MARKER,
  ENKII_POLICY_MARKER,
  ENKII_SECURITY_MARKER,
} from "../post";
import { postHelpReply } from "../post/help";
import type { PreparedContext } from "../prompts/types";
import { fetchEnkiiComment } from "../github/operations/comments/fetch-enkii-comment";
import { updateEnkiiComment } from "../github/operations/comments/update-enkii-comment";
import { updateCommentBody } from "../github/operations/comment-logic";
import { GITHUB_SERVER_URL } from "../github/api/config";
import {
  type ReviewLane,
  isForkPullRequestPayload,
  selectReviewKinds,
  settleReviewLanes,
} from "./review-lanes";
import { reportUsage } from "../usage/drain";
import {
  inspectCheckpoint,
  reuseEligibilityReason,
  checkpointSnapshotMatches,
  prepareReviewContext,
  prepareIncrementalScope,
  reviewConfigHash,
  runtimeFingerprint,
  type ReviewCheckpoint,
  type PostedReview,
} from "../github/data/review-context";
import {
  flushDiagnostics,
  initializeDiagnostics,
  recordDiagnostic,
  updateDiagnosticsIdentity,
} from "../runtime/diagnostics";

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

function validateEnv(): void {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error(
      "enkii could not find OPENROUTER_API_KEY. " +
        "Cause: the secret is not set on this repo. " +
        "Fix: Settings → Secrets and variables → Actions → New repository secret " +
        "→ name OPENROUTER_API_KEY, value from https://openrouter.ai/keys",
    );
  }
}

async function markTrackingCommentFailed(args: {
  octokit: ReturnType<typeof createOctokit>;
  context: ReturnType<typeof parseGitHubContext>;
  trackingCommentId?: number;
  errorMessage: string;
}): Promise<void> {
  const { octokit, context, trackingCommentId, errorMessage } = args;
  if (!trackingCommentId || !isEntityContext(context)) return;

  try {
    const { owner, repo } = context.repository;
    const fetched = await fetchEnkiiComment(octokit, {
      owner,
      repo,
      commentId: trackingCommentId,
      isPullRequestReviewCommentEvent:
        context.eventName === "pull_request_review_comment",
    });

    const jobUrl = `${GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${context.runId}`;
    const nextBody = updateCommentBody({
      currentBody: fetched.comment.body ?? "",
      actionFailed: true,
      executionDetails: null,
      jobUrl,
      errorDetails: errorMessage,
    });

    await updateEnkiiComment(octokit.rest, {
      owner,
      repo,
      commentId: trackingCommentId,
      body: nextBody,
      isPullRequestReviewComment: fetched.isPRReviewComment,
    });
    console.log(
      `enkii: updated tracking comment ${trackingCommentId} with failure details`,
    );
  } catch (updateError) {
    console.warn(
      `enkii: failed to update tracking comment ${trackingCommentId} after error: ${
        updateError instanceof Error ? updateError.message : String(updateError)
      }`,
    );
  }
}

async function markTrackingCommentPolicySkipped(args: {
  octokit: ReturnType<typeof createOctokit>;
  context: ReturnType<typeof parseGitHubContext>;
  trackingCommentId?: number;
}): Promise<void> {
  const { octokit, context, trackingCommentId } = args;
  if (!trackingCommentId || !isEntityContext(context)) return;

  try {
    const { owner, repo } = context.repository;
    const fetched = await fetchEnkiiComment(octokit, {
      owner,
      repo,
      commentId: trackingCommentId,
      isPullRequestReviewCommentEvent:
        context.eventName === "pull_request_review_comment",
    });
    const notice =
      "> Policy review was skipped because the configured prompt would be loaded from a fork-owned PR HEAD. Code and security review continue normally.";
    const currentBody = fetched.comment.body ?? "";
    if (currentBody.includes(notice)) return;
    await updateEnkiiComment(octokit.rest, {
      owner,
      repo,
      commentId: trackingCommentId,
      body: `${currentBody.trim()}\n\n${notice}`.trim(),
      isPullRequestReviewComment: fetched.isPRReviewComment,
    });
  } catch (error) {
    console.warn(
      `enkii: failed to add the fork policy-skip notice: ${getErrorMessage(error)}`,
    );
  }
}

async function run(): Promise<void> {
  let parsedContext: ReturnType<typeof parseGitHubContext> | null = null;
  let octokit: ReturnType<typeof createOctokit> | null = null;
  let trackingCommentId: number | undefined;
  const diagnosticsEnabled = envFlag("ENKII_DIAGNOSTICS", true);
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const diagnosticsDirectory =
    process.env.ENKII_DIAGNOSTICS_DIR ||
    join(
      runnerTemp,
      `enkii-diagnostics-${process.env.GITHUB_RUN_ID || "local"}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`,
    );
  initializeDiagnostics({
    enabled: diagnosticsEnabled,
    directory: diagnosticsDirectory,
    payloads: envFlag("ENKII_DIAGNOSTIC_PAYLOADS", false),
    identity: {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      commit: process.env.GITHUB_SHA,
      workflow: process.env.GITHUB_WORKFLOW,
    },
  });
  if (diagnosticsEnabled)
    core.setOutput("diagnostics_path", diagnosticsDirectory);
  if (diagnosticsEnabled)
    core.setOutput("diagnostics_name", basename(diagnosticsDirectory));
  const preparationStartedAt = Date.now();

  try {
    validateEnv();
    reportUsage();

    const reviewModel = process.env.REVIEW_MODEL || "@preset/enkii";
    const securityModel = process.env.SECURITY_MODEL || "@preset/enkii";
    const policyModel = process.env.POLICY_REVIEW_MODEL || reviewModel;
    const reviewSkillPath = process.env.REVIEW_SKILL_PATH || "";
    const securitySkillPath = process.env.SECURITY_SKILL_PATH || "";
    const policySkillPath = process.env.POLICY_REVIEW_SKILL_PATH || "";
    const enableValidator = envFlag("ENABLE_VALIDATOR", false);
    const runSecurity = envFlag("RUN_SECURITY", true);

    const actionPath = process.env.GITHUB_ACTION_PATH || process.cwd();
    const workspacePath = process.env.GITHUB_WORKSPACE || process.cwd();
    const promptsDir = join(runnerTemp, "enkii-prompts");

    const context = parseGitHubContext();
    parsedContext = context;
    recordDiagnostic({ phase: "preparation", status: "started" });
    const githubToken = await setupGitHubToken();
    octokit = createOctokit(githubToken);

    if (isEntityContext(context)) {
      const tokenProvided = !!process.env.OVERRIDE_GITHUB_TOKEN;
      const ok = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        tokenProvided,
      );
      if (!ok) {
        throw new Error(
          "enkii: actor does not have write permissions on this repository. " +
            "Cause: triggering user is not a maintainer/collaborator. " +
            "Fix: only repo maintainers can trigger enkii in v0.1.",
        );
      }
    }

    const containsTrigger = shouldTriggerTag(context);
    console.log(`enkii trigger detected: ${containsTrigger}`);
    core.setOutput("contains_trigger", containsTrigger.toString());

    if (!containsTrigger) {
      console.log("No enkii trigger in this event, skipping.");
      return;
    }

    const dispatch = await prepareTagExecution({
      context,
      octokit,
      githubToken,
    });
    trackingCommentId = dispatch.trackingCommentId;
    console.log(`enkii dispatch: ${dispatch.command}`);
    if (dispatch.reason) console.log(`Reason: ${dispatch.reason}`);

    if (!isEntityContext(context)) {
      console.log("enkii: non-entity context post-dispatch; skipping.");
      return;
    }

    if (dispatch.command === "skip") return;

    if (dispatch.command === "help" || dispatch.command === "status") {
      await postHelpReply({
        octokit,
        context,
        command: dispatch.command,
      });
      return;
    }

    if (!context.isPR) {
      throw new Error(
        "enkii: review commands only run on PR events. " +
          "Cause: triggering event was not a PR. " +
          "Fix: trigger via a pull_request event or @enkii on a PR comment.",
      );
    }

    const isForkPR = isForkPullRequestPayload(context.payload);
    const selection = selectReviewKinds({
      command: dispatch.command,
      runSecurity,
      policySkillPath,
      isForkPR,
    });
    const benchmarkMode = dispatch.command === "benchmark";

    if (selection.policySkippedReason === "fork_prompt") {
      console.warn(
        "enkii: policy review skipped because its prompt would come from fork-owned PR HEAD.",
      );
      await markTrackingCommentPolicySkipped({
        octokit,
        context,
        trackingCommentId,
      });
    }

    if (selection.kinds.length === 0) {
      console.log("enkii: nothing to run for this dispatch.");
      return;
    }

    const { owner, repo } = context.repository;
    const prBranch = await fetchPRBranchData({
      octokits: octokit,
      repository: { owner, repo },
      prNumber: context.entityNumber,
    });
    if (!prBranch) {
      throw new Error(
        `enkii: could not fetch PR data for #${context.entityNumber}.`,
      );
    }

    console.log(
      `enkii: fetching PR data for ${owner}/${repo}#${context.entityNumber}...`,
    );
    checkoutPullRequestHead({
      prNumber: context.entityNumber,
      headSha: prBranch.headRefOid,
    });
    const reviewArtifacts = await computeReviewArtifacts({
      baseRef: prBranch.baseRefName,
      tempDir: runnerTemp,
      octokit,
      owner,
      repo,
      prNumber: context.entityNumber,
      title: prBranch.title,
      body: prBranch.body,
      githubToken,
      expectedBaseSha: prBranch.baseRefOid,
      expectedHeadSha: prBranch.headRefOid,
      ignoreExistingComments: benchmarkMode,
    });
    recordDiagnostic({
      phase: "preparation",
      status: "completed",
      scope: benchmarkMode ? "benchmark" : "review",
      durationMs: Date.now() - preparationStartedAt,
    });
    updateDiagnosticsIdentity({ reviewedHead: prBranch.headRefOid });
    // GitHub's diff endpoint follows the live PR. Never bind that diff to a
    // checkpoint if the PR moved while artifacts were being fetched.
    const artifactSnapshot = await fetchPRBranchData({
      octokits: octokit,
      repository: { owner, repo },
      prNumber: context.entityNumber,
    });
    const checkpointSnapshotSafe = checkpointSnapshotMatches(
      prBranch,
      artifactSnapshot,
    );
    if (!checkpointSnapshotSafe) {
      console.warn(
        "enkii: base moved during artifact preparation; continuing with a full review without checkpoint reuse or publication.",
      );
    }
    const fullPreparedContext = await prepareReviewContext(
      reviewArtifacts,
      workspacePath,
      prBranch.headRefOid,
    );
    const incrementalEnabled =
      checkpointSnapshotSafe &&
      envFlag("INCREMENTAL_REVIEW", true) &&
      !benchmarkMode &&
      !isForkPR;
    const canReuse =
      incrementalEnabled &&
      dispatch.command === "auto" &&
      "action" in context.payload &&
      context.payload.action === "synchronize";
    let previousReviews: PostedReview[] = [];
    let checkpointLookupFailed = false;
    let runtime = "";
    try {
      runtime = await runtimeFingerprint(actionPath);
    } catch {
      console.warn("enkii: runtime fingerprint unavailable.");
    }
    if (incrementalEnabled) {
      try {
        if (canReuse)
          previousReviews = await octokit.rest.paginate(
            octokit.rest.pulls.listReviews,
            {
              owner,
              repo,
              pull_number: context.entityNumber,
              per_page: 100,
            },
          );
      } catch {
        checkpointLookupFailed = true;
        console.warn(
          "enkii: review checkpoints unavailable; using full review.",
        );
      }
    }
    updateDiagnosticsIdentity({
      runtime,
      actionRef: process.env.GITHUB_ACTION_REF,
    });
    const checkpoints = new Map<ReviewKind, ReviewCheckpoint>();

    if (benchmarkMode) {
      console.log(
        "enkii: benchmark mode enabled; existing PR comments are omitted from the review prompt.",
      );
    }

    const buildContext = async (
      skillContent: string,
      includeSuggestions: boolean,
      kind: ReviewKind,
      model: string,
    ): Promise<PreparedContext> => {
      const contextStartedAt = Date.now();
      const expected = {
        repository: `${owner}/${repo}`,
        prNumber: context.entityNumber,
        kind,
        base: prBranch.baseRefOid ?? "",
        config: reviewConfigHash(skillContent, model, enableValidator, runtime),
      };
      const eligibilityReason = reuseEligibilityReason({
        enabled: envFlag("INCREMENTAL_REVIEW", true),
        snapshotSafe: checkpointSnapshotSafe,
        benchmark: benchmarkMode,
        fork: isForkPR,
        command: dispatch.command,
        eventAction:
          "action" in context.payload
            ? String(context.payload.action)
            : undefined,
        runtime,
        actorId: dispatch.postingActorId,
        lookupFailed: checkpointLookupFailed,
      });
      const checkpointDecision = eligibilityReason
        ? {
            reason: eligibilityReason,
            checkpoint: undefined,
            checkpointHead: undefined,
          }
        : inspectCheckpoint(previousReviews, expected, dispatch.postingActorId);
      const scope = await prepareIncrementalScope({
        checkpoint: checkpointDecision.checkpoint,
        fallbackReason: checkpointDecision.reason,
        checkpointHead: checkpointDecision.checkpointHead,
        cwd: workspacePath,
        head: prBranch.headRefOid,
        base: expected.base,
        artifacts: reviewArtifacts,
        kind,
        promptsDir,
      });
      const scopedArtifacts = {
        ...reviewArtifacts,
        fullDiffPath: reviewArtifacts.diffPath,
        diffPath: scope.diffPath ?? reviewArtifacts.diffPath,
      };
      scopedArtifacts.preparedContext = scope.incremental
        ? await prepareReviewContext(
            scopedArtifacts,
            workspacePath,
            prBranch.headRefOid,
          )
        : await fullPreparedContext;
      if (
        incrementalEnabled &&
        runtime &&
        /^[a-f0-9]{40}$/.test(expected.base)
      ) {
        checkpoints.set(kind, {
          version: 1,
          ...expected,
          head: prBranch.headRefOid,
          findings: [],
        });
      }
      console.log(
        `enkii:${kind}: ${scope.incremental ? "incremental" : "full"} review scope; ${scope.priorFindingCount} prior findings to recheck; reason=${scope.reason}; checkpoint=${scope.checkpointHead ?? "none"}`,
      );
      recordDiagnostic({
        kind,
        phase: "preparation",
        status: "completed",
        scope: scope.incremental ? "incremental" : "full",
        model,
        durationMs: Date.now() - contextStartedAt,
        priorFindingCount: scope.priorFindingCount,
        reason: scope.reason,
        checkpointHead: scope.checkpointHead,
        eventName: context.eventName,
        eventAction:
          "action" in context.payload
            ? String(context.payload.action)
            : undefined,
      });
      return {
        repository: `${owner}/${repo}`,
        triggerPhrase: "@enkii",
        githubContext: context,
        prBranchData: {
          headRefName: prBranch.headRefName,
          headRefOid: prBranch.headRefOid,
        },
        reviewArtifacts: scopedArtifacts,
        skillContent,
        includeSuggestions,
        reviewScope: scope.scope,
        priorFindingCount: scope.priorFindingCount,
        eventData: {
          eventName: "pull_request",
          isPR: true,
          prNumber: String(context.entityNumber),
          baseBranch: prBranch.baseRefName,
        },
      };
    };

    const selectedKinds = new Set(selection.kinds);
    const lanes: ReviewLane<RunReviewResult, ReviewKind>[] = [];
    const withLaneDiagnostics = (
      kind: ReviewKind,
      execute: () => Promise<RunReviewResult>,
    ): ReviewLane<RunReviewResult, ReviewKind> => ({
      kind,
      execute: async () => {
        const startedAt = Date.now();
        try {
          const result = await execute();
          recordDiagnostic({
            kind,
            phase: "execute",
            status: "completed",
            durationMs: Date.now() - startedAt,
            coverage: result.validated.coverageComplete
              ? "complete"
              : "incomplete",
          });
          return result;
        } catch (error) {
          recordDiagnostic({
            kind,
            phase: "execute",
            status: "failed",
            coverage: "incomplete",
            durationMs: Date.now() - startedAt,
            error: getErrorMessage(error),
          });
          throw error;
        }
      },
    });

    if (selectedKinds.has("code")) {
      lanes.push(
        withLaneDiagnostics("code", async () => {
          const skill = await loadSkill({
            kind: "review",
            overridePath: reviewSkillPath,
            actionPath,
            workspacePath,
            isForkPR,
          });
          logSkill("review", reviewSkillPath, skill);
          return runCodeReview({
            preparedContext: await buildContext(
              skill.content,
              true,
              "code",
              reviewModel,
            ),
            workingDir: workspacePath,
            reviewModel,
            promptsDir,
            enableValidator,
          });
        }),
      );
    }

    if (selectedKinds.has("security")) {
      lanes.push(
        withLaneDiagnostics("security", async () => {
          const skill = await loadSkill({
            kind: "security-review",
            overridePath: securitySkillPath,
            actionPath,
            workspacePath,
            isForkPR,
          });
          logSkill("security", securitySkillPath, skill);
          return runSecurityReview({
            preparedContext: await buildContext(
              skill.content,
              false,
              "security",
              securityModel,
            ),
            workingDir: workspacePath,
            securityModel,
            promptsDir,
            enableValidator,
          });
        }),
      );
    }

    if (selectedKinds.has("policy")) {
      lanes.push(
        withLaneDiagnostics("policy", async () => {
          const skill = await loadRequiredRepositorySkill({
            skillPath: policySkillPath,
            workspacePath,
            label: "policy review skill",
          });
          console.log(
            `enkii: loaded policy review prompt from PR HEAD at ${skill.source}`,
          );
          return runPolicyReview({
            preparedContext: await buildContext(
              skill.content,
              false,
              "policy",
              policyModel,
            ),
            workingDir: workspacePath,
            policyModel,
            promptsDir,
            enableValidator,
          });
        }),
      );
    }

    console.log(
      `enkii: running ${lanes.length} review(s) in parallel ` +
        `(validator ${enableValidator ? "on" : "off"})`,
    );
    const restOctokit = octokit.rest;
    const settled = await settleReviewLanes(lanes, async (result) => {
      const startedAt = Date.now();
      try {
        const post = await postReviewFromValidated({
          validated: result.validated,
          octokit: restOctokit,
          owner,
          repo,
          prNumber: context.entityNumber,
          marker: markerForKind(result.kind),
          inlineCap: 20,
          checkpoint: checkpoints.get(result.kind),
        });
        console.log(
          `enkii: posted ${result.kind} review #${post.reviewId} immediately after lane completion`,
        );
        core.setOutput(`${result.kind}_review_id`, String(post.reviewId));
        recordDiagnostic({
          kind: result.kind,
          phase: "post",
          status: "completed",
          durationMs: Date.now() - startedAt,
          coverage: result.validated.coverageComplete
            ? "complete"
            : "incomplete",
        });
        return post;
      } catch (error) {
        recordDiagnostic({
          kind: result.kind,
          phase: "post",
          status: "failed",
          durationMs: Date.now() - startedAt,
          error: getErrorMessage(error),
        });
        throw error;
      }
    });

    for (const entry of settled.posted) {
      const { kind, post } = entry;
      console.log(
        `enkii: posted ${kind} review #${post.reviewId} — ` +
          `${post.inlinePosted} inline, ${post.summarized} summarized, ` +
          `${post.totalApproved} approved total.`,
      );
    }

    if (settled.errors.length > 0) {
      throw new Error(
        `enkii: ${settled.errors.length} review lane(s) failed after successful lanes were preserved: ` +
          settled.errors
            .map(
              (failure) =>
                `${failure.kind} ${failure.phase}: ${getErrorMessage(failure.error)}`,
            )
            .join("; "),
      );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordDiagnostic({
      phase: "action",
      status: "failed",
      error: errorMessage,
    });
    if (octokit && parsedContext) {
      await markTrackingCommentFailed({
        octokit,
        context: parsedContext,
        trackingCommentId,
        errorMessage,
      });
    }
    core.setFailed(`enkii failed: ${errorMessage}`);
  } finally {
    await flushDiagnostics();
  }
}

function markerForKind(kind: ReviewKind): string {
  if (kind === "security") return ENKII_SECURITY_MARKER;
  if (kind === "policy") return ENKII_POLICY_MARKER;
  return ENKII_REVIEW_MARKER;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logSkill(
  kind: string,
  overridePath: string,
  skill: { source: string; refusedForkOverride?: boolean },
): void {
  if (skill.refusedForkOverride) {
    console.warn(
      `enkii: ignoring ${kind}_skill_path on fork PR; using bundled skill at ${skill.source}`,
    );
  } else if (overridePath) {
    console.log(`enkii: loaded ${kind} skill from override ${skill.source}`);
  } else {
    console.log(`enkii: loaded bundled ${kind} skill from ${skill.source}`);
  }
}

if (import.meta.main) {
  run();
}
