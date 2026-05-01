/**
 * Extract a JSON object from a Codex CLI final message.
 *
 * Codex returns a markdown response (reasoning prose + a fenced ```json block),
 * even when --output-schema is set. Returns the largest fenced block's contents,
 * or falls back to the whole message if no fenced block was emitted.
 */

export function extractFencedJson(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)];
  if (fences.length === 0) return null;
  let best = "";
  for (const m of fences) {
    if (m[1] && m[1].length > best.length) best = m[1];
  }
  return best || null;
}

export class JsonExtractError extends Error {
  rawMessage: string;
  constructor(message: string, rawMessage: string) {
    super(message);
    this.name = "JsonExtractError";
    this.rawMessage = rawMessage;
  }
}

/**
 * Extract + parse JSON from a Codex final message.
 * Throws JsonExtractError if no parseable JSON is found.
 */
export function extractAndParseJson(rawMessage: string): unknown {
  const text = extractFencedJson(rawMessage) ?? rawMessage;
  try {
    return JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new JsonExtractError(
      `enkii: could not parse JSON from the model's final message. ` +
        `Cause: ${reason}. ` +
        `Fix: this is usually a transient model output issue — retry with @enkii /review. ` +
        `If repeated, the model may not be honoring the output schema.`,
      rawMessage,
    );
  }
}
