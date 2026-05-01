/**
 * Runtime contracts between Pass 1 (candidates) and Pass 2 (validator) and
 * the post step.
 *
 * Two formats:
 *   - zod schemas — for parsing + type-narrowing on the TypeScript side.
 *   - JSON Schema (plain JS objects) — written to disk and passed to Codex
 *     via `--output-schema` so the model is constrained to the same shape.
 *
 * Keep the two in sync manually. v1 may swap to a single source of truth
 * (e.g. zod-to-json-schema), but for v0.1 hand-written keeps the surface
 * small and easy to read.
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

// -----------------------------------------------------------------------------
// JSON Schema variants (passed to Codex via --output-schema)
// -----------------------------------------------------------------------------

export const CANDIDATES_OUTPUT_SCHEMA = {
  type: "object",
  required: ["version", "meta", "comments"],
  properties: {
    version: { type: "integer", const: 1 },
    meta: {
      type: "object",
      required: ["repo", "prNumber", "headSha", "baseRef"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: ["number", "string"] },
        headSha: { type: "string" },
        baseRef: { type: "string" },
        generatedAt: { type: "string" },
        pass1HeadSha: { type: "string" },
      },
    },
    comments: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "line", "body"],
        properties: {
          path: { type: "string" },
          line: { type: "integer", minimum: 0 },
          startLine: { type: ["integer", "null"], minimum: 0 },
          side: { type: "string", enum: ["LEFT", "RIGHT"] },
          body: { type: "string" },
          severity: { type: "string", enum: ["P0", "P1", "P2", "nit"] },
        },
      },
    },
    reviewSummary: {
      type: "object",
      properties: { body: { type: "string" } },
    },
  },
} as const;

export const VALIDATED_OUTPUT_SCHEMA = {
  type: "object",
  required: ["version", "meta", "results"],
  properties: {
    version: { type: "integer", const: 1 },
    meta: {
      type: "object",
      required: ["repo", "prNumber", "headSha", "baseRef"],
      properties: {
        repo: { type: "string" },
        prNumber: { type: ["number", "string"] },
        headSha: { type: "string" },
        baseRef: { type: "string" },
        validatedAt: { type: "string" },
      },
    },
    results: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["status", "comment"],
            properties: {
              status: { type: "string", const: "approved" },
              comment: { $ref: "#/definitions/Candidate" },
            },
          },
          {
            type: "object",
            required: ["status", "candidate", "reason"],
            properties: {
              status: { type: "string", const: "rejected" },
              candidate: { $ref: "#/definitions/Candidate" },
              reason: { type: "string" },
            },
          },
        ],
      },
    },
    reviewSummary: {
      type: "object",
      required: ["status", "body"],
      properties: {
        status: { type: "string", enum: ["approved", "rejected"] },
        body: { type: "string" },
      },
    },
  },
  definitions: {
    Candidate: {
      type: "object",
      required: ["path", "line", "body"],
      properties: {
        path: { type: "string" },
        line: { type: "integer", minimum: 0 },
        startLine: { type: ["integer", "null"], minimum: 0 },
        side: { type: "string", enum: ["LEFT", "RIGHT"] },
        body: { type: "string" },
        severity: { type: "string", enum: ["P0", "P1", "P2", "nit"] },
      },
    },
  },
} as const;
