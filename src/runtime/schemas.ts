/**
 * Runtime contracts between Pass 1 (candidates) and Pass 2 (validator) and
 * the post step.
 *
 * The Pi runtime constrains model output through submit_* tool schemas, then
 * these zod schemas parse and type-narrow the submitted arguments before the
 * post step consumes them.
 */

import { z } from "zod";

// -----------------------------------------------------------------------------
// Pass 1 — candidates
// -----------------------------------------------------------------------------

export const SeveritySchema = z.enum(["P0", "P1", "P2", "nit"]);

export const CandidateSchema = z.object({
  path: z.string(),
  line: z.number().int().nonnegative(),
  startLine: z.number().int().nonnegative().nullable().optional(),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
  body: z.string(),
  severity: SeveritySchema.optional(),
});

export const CandidatesPassSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    repo: z.string(),
    prNumber: z.union([z.number(), z.string()]),
    headSha: z.string(),
    baseRef: z.string(),
    generatedAt: z.string().optional(),
    pass1HeadSha: z.string().optional(),
  }),
  comments: z.array(CandidateSchema),
  reviewSummary: z
    .object({
      body: z.string(),
    })
    .optional(),
});

export type Candidate = z.infer<typeof CandidateSchema>;
export type CandidatesPass = z.infer<typeof CandidatesPassSchema>;

// -----------------------------------------------------------------------------
// Pass 2 — validated
// -----------------------------------------------------------------------------

export const ValidatedItemSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("approved"),
    comment: CandidateSchema,
  }),
  z.object({
    status: z.literal("rejected"),
    candidate: CandidateSchema,
    reason: z.string(),
  }),
]);

export const ValidatedPassSchema = z.object({
  version: z.literal(1),
  meta: z.object({
    repo: z.string(),
    prNumber: z.union([z.number(), z.string()]),
    headSha: z.string(),
    baseRef: z.string(),
    validatedAt: z.string().optional(),
  }),
  results: z.array(ValidatedItemSchema),
  reviewSummary: z
    .object({
      status: z.enum(["approved", "rejected"]),
      body: z.string(),
    })
    .optional(),
});

export type ValidatedItem = z.infer<typeof ValidatedItemSchema>;
export type ValidatedPass = z.infer<typeof ValidatedPassSchema>;
