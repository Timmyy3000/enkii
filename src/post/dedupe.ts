import type { ValidatedPass } from "../runtime/schemas";

export type PostedAnchor = { kind: string; path: string; line: number };

const NEARBY_LINES = 3;

/**
 * Lanes post as they finish. A later lane drops findings anchored where an
 * earlier lane in the same run already commented, so one defect gets one thread.
 */
export function claimAnchors(
  validated: ValidatedPass,
  kind: string,
  posted: PostedAnchor[],
): ValidatedPass {
  const taken = (path: string, line: number) =>
    posted.some(
      (anchor) =>
        anchor.kind !== kind &&
        anchor.path === path &&
        Math.abs(anchor.line - line) <= NEARBY_LINES,
    );
  const results = validated.results.filter(
    (result) =>
      result.status !== "approved" ||
      !taken(result.comment.path, result.comment.line),
  );
  for (const result of results)
    if (result.status === "approved")
      posted.push({ kind, path: result.comment.path, line: result.comment.line });
  return { ...validated, results };
}
