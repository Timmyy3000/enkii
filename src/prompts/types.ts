/**
 * Shared types for prompt scaffolding and artifact metadata.
 *
 * Adapted from Factory-AI/droid-action (MIT). Renamed from `create-prompt/`
 * to `prompts/` for enkii. Full `PreparedContext` + event-discriminator types
 * land in C7 with the prompt template port.
 */

export type ReviewArtifacts = {
  diffPath: string;
  commentsPath: string;
  descriptionPath: string;
};
