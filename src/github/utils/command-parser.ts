/**
 * Command parser for @enkii mentions in GitHub comments and PR bodies.
 *
 * Recognized commands:
 *   - @enkii /review        re-run code review
 *   - @enkii /security      run security review
 *   - @enkii (alone)        respond with help
 *   - @enkii help           respond with help
 *   - @enkii status         respond with most recent run status
 */

import type { GitHubContext } from "../context";

export type EnkiiCommand =
  | "review"
  | "security"
  | "help"
  | "status"
  | "default";

export interface ParsedCommand {
  command: EnkiiCommand;
  raw: string;
  location: "body" | "comment";
  timestamp?: string | null;
}

/**
 * Parses text to detect @enkii commands.
 * @param text Comment body or PR description.
 * @returns ParsedCommand if found, null otherwise.
 */
export function parseEnkiiCommand(text: string): ParsedCommand | null {
  if (!text) {
    return null;
  }

  const reviewMatch = text.match(/@enkii\s+\/review\b/i);
  if (reviewMatch) {
    return {
      command: "review",
      raw: reviewMatch[0],
      location: "body",
    };
  }

  const securityMatch = text.match(/@enkii\s+\/security\b/i);
  if (securityMatch) {
    return {
      command: "security",
      raw: securityMatch[0],
      location: "body",
    };
  }

  const helpMatch = text.match(/@enkii\s+help\b/i);
  if (helpMatch) {
    return {
      command: "help",
      raw: helpMatch[0],
      location: "body",
    };
  }

  const statusMatch = text.match(/@enkii\s+status\b/i);
  if (statusMatch) {
    return {
      command: "status",
      raw: statusMatch[0],
      location: "body",
    };
  }

  // Bare @enkii mention with no recognized subcommand → default to help.
  const enkiiMatch = text.match(/@enkii\b/i);
  if (enkiiMatch) {
    return {
      command: "default",
      raw: enkiiMatch[0],
      location: "body",
    };
  }

  return null;
}

/**
 * Extracts an enkii command from the GitHub event context.
 * Checks PR body, issue body, comment body, and review comment body in turn.
 */
export function extractCommandFromContext(
  context: GitHubContext,
): ParsedCommand | null {
  if (!context.payload) {
    return null;
  }

  if (
    context.eventName === "pull_request" &&
    "pull_request" in context.payload
  ) {
    const body = context.payload.pull_request.body;
    if (body) {
      const command = parseEnkiiCommand(body);
      if (command) {
        return { ...command, location: "body" };
      }
    }
  }

  if (context.eventName === "issues" && "issue" in context.payload) {
    const body = context.payload.issue.body;
    if (body) {
      const command = parseEnkiiCommand(body);
      if (command) {
        return { ...command, location: "body" };
      }
    }
  }

  if (context.eventName === "issue_comment" && "comment" in context.payload) {
    const comment = context.payload.comment;
    if (comment.body) {
      const command = parseEnkiiCommand(comment.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: comment.created_at,
        };
      }
    }
  }

  if (
    context.eventName === "pull_request_review_comment" &&
    "comment" in context.payload
  ) {
    const comment = context.payload.comment;
    if (comment.body) {
      const command = parseEnkiiCommand(comment.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: comment.created_at,
        };
      }
    }
  }

  if (
    context.eventName === "pull_request_review" &&
    "review" in context.payload
  ) {
    const review = context.payload.review;
    if (review.body) {
      const command = parseEnkiiCommand(review.body);
      if (command) {
        return {
          ...command,
          location: "comment",
          timestamp: review.submitted_at,
        };
      }
    }
  }

  return null;
}
