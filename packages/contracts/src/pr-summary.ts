import { z } from "zod";
import { ParentPrSchema, PrCommitSchema, PrMergeStrategySchema } from "./pr-routes.js";

export const CheckSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

export const CiRunSummarySchema = z.object({
  providerId: z.string(),
  id: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  branch: z.string().nullable(),
  event: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string().nullable(),
});

export const PrReviewerStateSchema = z.enum(["approved", "changes_requested", "commented", "pending", "dismissed"]);

export const PrReviewerSchema = z.object({
  login: z.string().min(1),
  name: z.string().nullable().default(null),
  state: PrReviewerStateSchema,
});

// GitHub's mergeStateStatus enum; affects the workspace-card "conflicting"
// tone (DIRTY -> red border) but not the readiness state itself. Lowercase
// "mergeable" enum on PullRequestSummarySchema is the source of truth for
// the pr-conflicts readiness gate.
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
  commits: z.array(PrCommitSchema).default([]),
  headRefName: z.string().nullable().default(null),
  parentPr: ParentPrSchema.nullable().default(null),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]).default("unknown"),
  allowedMergeStrategies: z.array(PrMergeStrategySchema).default([]),
  // gh `pr view --json mergeStateStatus` - affects card tone only.
  mergeStateStatus: PrMergeStateStatusSchema.nullable().default(null),
  // gh `pr view --json headRefOid` - the PR head commit SHA. Used by the
  // CI auto-recovery tick to dedupe per-SHA so we don't re-launch agents
  // on CI re-runs of the same commit.
  headSha: z.string().nullable().default(null),
});

export type CheckSummary = z.infer<typeof CheckSummarySchema>;
export type CiRunSummary = z.infer<typeof CiRunSummarySchema>;
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;
export type PrReviewer = z.infer<typeof PrReviewerSchema>;
export type PrReviewerState = z.infer<typeof PrReviewerStateSchema>;
