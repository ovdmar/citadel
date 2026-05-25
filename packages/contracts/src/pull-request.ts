import { z } from "zod";
import { CheckSummarySchema } from "./index.js";

export const PrReviewerStateSchema = z.enum(["approved", "changes_requested", "commented", "pending", "dismissed"]);

export const PrReviewerSchema = z.object({
  login: z.string().min(1),
  name: z.string().nullable().default(null),
  state: PrReviewerStateSchema,
});

// GitHub's mergeable + mergeStateStatus enums. Strict schemas with `.catch()`
// so unknown values from `gh pr view --json` (new GitHub states, version
// drift) land in a defined fallback rather than failing validation — the
// contracts layer stays strict, but the consumer code only compares against
// the documented literals.
export const PrMergeableSchema = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).catch("UNKNOWN");
export const PrMergeStateStatusSchema = z
  .enum(["CLEAN", "BEHIND", "BLOCKED", "DIRTY", "HAS_HOOKS", "UNKNOWN", "UNSTABLE", "DRAFT"])
  .catch("UNKNOWN");

export const PullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  reviewDecision: z.string().nullable(),
  checks: z.array(CheckSummarySchema),
  additions: z.number().nullable().default(null),
  deletions: z.number().nullable().default(null),
  reviewers: z.array(PrReviewerSchema).default([]),
  mergeable: PrMergeableSchema.nullable().default(null),
  mergeStateStatus: PrMergeStateStatusSchema.nullable().default(null),
});
