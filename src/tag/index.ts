/**
 * Trigger detection + command dispatch.
 *
 * v0.1 trigger surface:
 *   - pull_request (opened/synchronize/reopened) → run code review automatically
 *   - @enkii /review                              → re-run code review
 *   - @enkii /security                            → standalone security review
 *   - @enkii help | @enkii status | @enkii        → mechanical reply (no LLM)
 *
 * This module decides WHAT to run; runtime/ decides HOW. Command handlers
 * here emit Action outputs (`enkii_command`, `enkii_comment_id`) that the
 * workflow branches on.
 */

import * as core from "@actions/core";
import { checkContainsTrigger } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { isEntityContext, type ParsedGitHubContext } from "../github/context";
import { extractCommandFromContext } from "../github/utils/command-parser";
import type { GitHubContext } from "../github/context";
import type { Octokits } from "../github/api/client";

const ENKII_REVIEW_MARKER = "<!-- enkii-review -->";
const ENKII_SECURITY_MARKER = "<!-- enkii-security-review -->";

export function shouldTriggerTag(context: GitHubContext): boolean {
  if (!isEntityContext(context)) {
    return false;
  }
  // Auto-trigger on PR events; explicit-trigger on comments via @enkii.
  if (context.eventName === "pull_request" && context.isPR) {
    return true;
  }
  return checkContainsTrigger(context);
}

/**
 * Has a prior enkii review (code or security) been posted for this PR's HEAD?
 * Used so re-runs of `synchronize` events don't double-post when nothing changed.
 * Lightweight check — Phase 3 may add SHA-aware dedup beyond this.
 */
async function hasExistingEnkiiReview(
  octokit: Octokits,
  context: ParsedGitHubContext,
  marker: string,
): Promise<boolean> {
  const { owner, repo } = context.repository;
  try {
    const comments = await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: context.entityNumber,
      per_page: 100,
    });
    return comments.data.some((comment) => {
      const isOurBot =
        comment.user?.type === "Bot" &&
        comment.user?.login.toLowerCase().includes("enkii");
      return isOurBot && comment.body?.includes(marker);
    });
  } catch (error) {
    console.warn("Failed to check for existing enkii review:", error);
    return false;
  }
}

export type TagDispatchResult = {
  command: "review" | "security" | "help" | "status" | "skip";
  trackingCommentId?: number;
  reason?: string;
};

type PrepareTagOptions = {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
};

export async function prepareTagExecution({
  context,
  octokit,
}: PrepareTagOptions): Promise<TagDispatchResult> {
  if (!isEntityContext(context)) {
    throw new Error("enkii: tag execution requires an entity context (PR or issue)");
  }

  await checkHumanActor(octokit.rest, context);

  const commandContext = extractCommandFromContext(context);

  // PR event with no slash command → automatic code review.
  if (context.eventName === "pull_request" && context.isPR) {
    if (await hasExistingEnkiiReview(octokit, context, ENKII_REVIEW_MARKER)) {
      // For now we still re-run; later phases may add SHA-aware skip.
      console.log("enkii: prior code review found on this PR; running again on the new HEAD.");
    }
    const comment = await createInitialComment(octokit.rest, context, "default");
    core.setOutput("enkii_command", "review");
    core.setOutput("enkii_comment_id", String(comment.id));
    return { command: "review", trackingCommentId: comment.id };
  }

  // Slash-command paths (issue_comment / review_comment / review).
  switch (commandContext?.command) {
    case "review": {
      const comment = await createInitialComment(octokit.rest, context, "default");
      core.setOutput("enkii_command", "review");
      core.setOutput("enkii_comment_id", String(comment.id));
      return { command: "review", trackingCommentId: comment.id };
    }
    case "security": {
      if (await hasExistingEnkiiReview(octokit, context, ENKII_SECURITY_MARKER)) {
        console.log("enkii: prior security review found; running again.");
      }
      const comment = await createInitialComment(octokit.rest, context, "security");
      core.setOutput("enkii_command", "security");
      core.setOutput("enkii_comment_id", String(comment.id));
      return { command: "security", trackingCommentId: comment.id };
    }
    case "help":
    case "default": {
      // @enkii alone or @enkii help → mechanical reply (no LLM, no tracking comment).
      core.setOutput("enkii_command", "help");
      return { command: "help" };
    }
    case "status": {
      core.setOutput("enkii_command", "status");
      return { command: "status" };
    }
    default: {
      core.setOutput("enkii_command", "skip");
      return {
        command: "skip",
        reason: "no recognized @enkii command in event payload",
      };
    }
  }
}
