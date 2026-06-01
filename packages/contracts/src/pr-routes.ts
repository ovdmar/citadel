import { z } from "zod";

// PR-specific schemas. Lives in its own file so PullRequestSummarySchema (in
// ./index.ts) can stay near the other workspace contract schemas while keeping
// index.ts under the 800-line file-size gate.
//
// Avoid importing runtime schemas from ./index.ts here: index.ts imports
// from this file to wire PullRequestSummary, so a back-edge would create an
// ESM circular-init hazard (the imported value resolves to `undefined` while
// index.ts is still initializing). The batch + merge endpoint schemas use
// z.unknown() for the cross-referenced WorkspaceCockpitSummary and
// VersionControlSummary slots — Zod's parsed value is `unknown` here but the
// daemon-side handlers know the runtime shape via the daemon's separate
// builder helpers, and consumers narrow via the dedicated schemas in
// ./index.ts when they need a typed cockpit summary.

const CheckSummaryInlineSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

export const PrCommitSchema = z.object({
  sha: z.string().min(7),
  shortSha: z.string().min(4),
  message: z.string(),
  checks: z.array(CheckSummaryInlineSchema).default([]),
});

export const ParentPrSchema = z.object({
  number: z.number(),
  url: z.string(),
  headRefName: z.string(),
  state: z.string(),
});

export const PrMergeStrategySchema = z.enum(["squash", "merge", "rebase"]);

export const WorkspaceCockpitSummaryBatchRequestSchema = z.object({
  ids: z.array(z.string()).min(1).max(50),
});

export const WorkspaceCockpitSummaryBatchEntrySchema = z.discriminatedUnion("ok", [
  z.object({ workspaceId: z.string(), ok: z.literal(true), summary: z.unknown() }),
  z.object({ workspaceId: z.string(), ok: z.literal(false), reason: z.string() }),
]);

export const WorkspaceCockpitSummaryBatchResponseSchema = z.object({
  summaries: z.array(WorkspaceCockpitSummaryBatchEntrySchema),
});

export const PrRefreshResponseSchema = z.object({
  versionControl: z.unknown(),
});

export const PrMergeRequestSchema = z.object({
  strategy: PrMergeStrategySchema,
});

export const PrMergeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), reason: z.string(), detail: z.string() }),
]);

export type PrCommit = z.infer<typeof PrCommitSchema>;
export type ParentPr = z.infer<typeof ParentPrSchema>;
export type PrMergeStrategy = z.infer<typeof PrMergeStrategySchema>;
export type WorkspaceCockpitSummaryBatchRequest = z.infer<typeof WorkspaceCockpitSummaryBatchRequestSchema>;
export type WorkspaceCockpitSummaryBatchEntry = z.infer<typeof WorkspaceCockpitSummaryBatchEntrySchema>;
export type WorkspaceCockpitSummaryBatchResponse = z.infer<typeof WorkspaceCockpitSummaryBatchResponseSchema>;
export type PrRefreshResponse = z.infer<typeof PrRefreshResponseSchema>;
export type PrMergeRequest = z.infer<typeof PrMergeRequestSchema>;
export type PrMergeResponse = z.infer<typeof PrMergeResponseSchema>;
