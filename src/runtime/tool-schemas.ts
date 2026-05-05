import { Type } from "@mariozechner/pi-ai";

const CandidateSchema = Type.Object({
  path: Type.String(),
  line: Type.Integer({ minimum: 0 }),
  startLine: Type.Optional(
    Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  ),
  side: Type.Optional(
    Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
  ),
  body: Type.String(),
  severity: Type.Optional(
    Type.Union([
      Type.Literal("P0"),
      Type.Literal("P1"),
      Type.Literal("P2"),
      Type.Literal("nit"),
    ]),
  ),
});

export const SubmitCandidatesParameters = Type.Object({
  version: Type.Literal(1),
  meta: Type.Object({
    repo: Type.String(),
    prNumber: Type.Union([Type.Number(), Type.String()]),
    headSha: Type.String(),
    baseRef: Type.String(),
    generatedAt: Type.Optional(Type.String()),
    pass1HeadSha: Type.Optional(Type.String()),
  }),
  comments: Type.Array(CandidateSchema),
  reviewSummary: Type.Optional(
    Type.Object({
      body: Type.String(),
    }),
  ),
});

const ApprovedValidatedItemSchema = Type.Object({
  status: Type.Literal("approved"),
  comment: CandidateSchema,
});

const RejectedValidatedItemSchema = Type.Object({
  status: Type.Literal("rejected"),
  candidate: CandidateSchema,
  reason: Type.String(),
});

export const SubmitValidatedParameters = Type.Object({
  version: Type.Literal(1),
  meta: Type.Object({
    repo: Type.String(),
    prNumber: Type.Union([Type.Number(), Type.String()]),
    headSha: Type.String(),
    baseRef: Type.String(),
    validatedAt: Type.Optional(Type.String()),
  }),
  results: Type.Array(
    Type.Union([ApprovedValidatedItemSchema, RejectedValidatedItemSchema]),
  ),
  reviewSummary: Type.Optional(
    Type.Object({
      status: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
      body: Type.String(),
    }),
  ),
});
