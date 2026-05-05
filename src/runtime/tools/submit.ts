import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Static } from "@mariozechner/pi-ai";
import {
  SubmitCandidatesParameters,
  SubmitValidatedParameters,
} from "../tool-schemas";

export function createSubmitCandidatesTool(
  onSubmit: (args: Static<typeof SubmitCandidatesParameters>) => void,
): AgentTool<typeof SubmitCandidatesParameters> {
  return {
    name: "submit_review",
    label: "Submit Review",
    description:
      "Call this exactly once with the final candidate review output.",
    parameters: SubmitCandidatesParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      onSubmit(params);
      return {
        content: [{ type: "text", text: "Review submitted." }],
        details: { commentCount: params.comments.length },
        terminate: true,
      };
    },
  };
}

export function createSubmitValidatedTool(
  onSubmit: (args: Static<typeof SubmitValidatedParameters>) => void,
): AgentTool<typeof SubmitValidatedParameters> {
  return {
    name: "submit_validation",
    label: "Submit Validation",
    description:
      "Call this exactly once with the final validated review output.",
    parameters: SubmitValidatedParameters,
    executionMode: "sequential",
    execute: async (_toolCallId, params) => {
      onSubmit(params);
      return {
        content: [{ type: "text", text: "Validation submitted." }],
        details: { resultCount: params.results.length },
        terminate: true,
      };
    },
  };
}
