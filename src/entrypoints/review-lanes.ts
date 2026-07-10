export type ReviewLaneKind = "code" | "security" | "policy";

export type ReviewDispatchCommand =
  | "auto"
  | "review"
  | "benchmark"
  | "security"
  | "help"
  | "status"
  | "skip";

export function selectReviewKinds(args: {
  command: ReviewDispatchCommand;
  runSecurity: boolean;
  policySkillPath: string;
  isForkPR: boolean;
}): { kinds: ReviewLaneKind[]; policySkippedReason?: "fork_prompt" } {
  const { command, runSecurity, policySkillPath, isForkPR } = args;
  const kinds: ReviewLaneKind[] = [];

  if (command === "auto" || command === "review" || command === "benchmark") {
    kinds.push("code");
  }
  if (command === "security" || (command === "auto" && runSecurity)) {
    kinds.push("security");
  }

  if (command === "auto" && policySkillPath.trim()) {
    if (isForkPR) return { kinds, policySkippedReason: "fork_prompt" };
    kinds.push("policy");
  }

  return { kinds };
}

export type ReviewLane<T, K extends string = ReviewLaneKind> = {
  kind: K;
  execute: () => Promise<T>;
};

export type ReviewLaneError<K extends string = ReviewLaneKind> = {
  kind: K;
  phase: "execute" | "post";
  error: unknown;
};

export async function settleReviewLanes<
  K extends string,
  T extends { kind: K },
  P,
>(
  lanes: ReviewLane<T, K>[],
  post: (review: T) => Promise<P>,
): Promise<{
  posted: Array<{ kind: K; review: T; post: P }>;
  errors: ReviewLaneError<K>[];
}> {
  const executionSettled = await Promise.allSettled(
    lanes.map((lane) => lane.execute()),
  );
  const errors: ReviewLaneError<K>[] = [];
  const completed: T[] = [];

  executionSettled.forEach((result, index) => {
    const lane = lanes[index]!;
    if (result.status === "fulfilled") completed.push(result.value);
    else
      errors.push({ kind: lane.kind, phase: "execute", error: result.reason });
  });

  const postSettled = await Promise.allSettled(
    completed.map(async (review) => ({ review, post: await post(review) })),
  );
  const posted: Array<{ kind: K; review: T; post: P }> = [];

  postSettled.forEach((result, index) => {
    const review = completed[index]!;
    if (result.status === "fulfilled") {
      posted.push({ kind: review.kind, ...result.value });
    } else {
      errors.push({ kind: review.kind, phase: "post", error: result.reason });
    }
  });

  return { posted, errors };
}
