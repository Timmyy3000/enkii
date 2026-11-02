import type { Candidate, ValidatedPass } from "../runtime/schemas";
import { getSeverity } from ".";

export type PostedAnchor = Pick<Candidate, "path" | "line" | "side"> & {
  kind: string;
  rank: number;
};

const NEARBY_LINES = 3;
const RANK = { P0: 3, P1: 2, P2: 1, nit: 0 } as const;

const rank = (c: Candidate) => RANK[getSeverity(c)];

/**
 * Lanes post as they finish. A later lane drops a finding when another lane
 * already posted one at least as severe on the same nearby lines.
 */
export function withoutPostedDuplicates(
  validated: ValidatedPass,
  kind: string,
  posted: PostedAnchor[],
): ValidatedPass {
  const covered = (c: Candidate) =>
    posted.some(
      (anchor) =>
        anchor.kind !== kind &&
        anchor.path === c.path &&
        anchor.side === c.side &&
        Math.abs(anchor.line - c.line) <= NEARBY_LINES &&
        anchor.rank >= rank(c),
    );
  return {
    ...validated,
    results: validated.results.filter(
      (result) => result.status !== "approved" || !covered(result.comment),
    ),
  };
}

export function recordPosted(
  validated: ValidatedPass,
  kind: string,
  posted: PostedAnchor[],
): void {
  for (const result of validated.results)
    if (result.status === "approved")
      posted.push({
        kind,
        path: result.comment.path,
        line: result.comment.line,
        side: result.comment.side,
        rank: rank(result.comment),
      });
}

/** Runs calls one at a time, in call order. A rejected call does not block later ones. */
export function serialized<A, R>(
  fn: (arg: A) => Promise<R>,
): (arg: A) => Promise<R> {
  let tail: Promise<unknown> = Promise.resolve();
  return (arg) => {
    const run = tail.then(() => fn(arg));
    tail = run.catch(() => undefined);
    return run;
  };
}
