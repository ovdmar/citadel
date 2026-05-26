import { z } from "zod";

// Co-located with PullRequestSummary because it's the only consumer in
// practice. Lives here (not in index.ts) so pull-request.ts has no import
// dependency on its own parent barrel — ESM evaluates pull-request.ts during
// index.ts's import, and a back-reference would hit the TDZ.
export const CheckSummarySchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});

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
  // gh `pr view --json headRefOid` — the SHA of the PR's head commit. Used
  // by the CI auto-recovery tick to dedupe per-SHA so we don't re-launch on
  // CI re-runs of the same commit.
  headSha: z.string().nullable().default(null),
});
