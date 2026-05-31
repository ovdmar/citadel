import { z } from "zod";
import { CiRunSummarySchema, PullRequestSummarySchema } from "./index.js";

// Lightweight per-workspace PR/CI snapshot served by GET /api/workspaces/pr-state.
// Built from cache only; entries with no cached value are omitted (the
// background refresh job is the freshness driver, not the request path).
// cachedAt is an ISO-8601 string at the API boundary even though the cache
// stores it as ms internally.
export const WorkspacePrStateEntrySchema = z.object({
  pullRequest: PullRequestSummarySchema.nullable(),
  ciRuns: z.array(CiRunSummarySchema),
  checkedAt: z.string().nullable(),
  cachedAt: z.string().nullable(),
});

export const WorkspacesPrStateResponseSchema = z.object({
  workspacePrState: z.record(z.string(), WorkspacePrStateEntrySchema),
});

export type WorkspacePrStateEntry = z.infer<typeof WorkspacePrStateEntrySchema>;
export type WorkspacesPrStateResponse = z.infer<typeof WorkspacesPrStateResponseSchema>;
