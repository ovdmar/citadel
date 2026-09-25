// Jira-specific contract schemas, extracted from index.ts to keep that
// file under the 800-line file-size gate. Re-exported from index.ts so
// consumers continue to import everything from `@citadel/contracts`.

import { z } from "zod";

// Mirrors ProviderStatusSchema in index.ts. Defined locally to avoid a
// circular import (index.ts re-exports from this file).
const ProviderStatusSchema = z.enum(["healthy", "degraded", "unavailable", "unknown"]);

export const IssueTransitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  toStatus: z.string(),
});

export const IssueTrackerSummarySchema = z.object({
  providerId: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  key: z.string(),
  summary: z.string().nullable(),
  issueStatus: z.string().nullable(),
  assignee: z.string().nullable(),
  updated: z.string().nullable(),
  url: z.string().nullable(),
  transitions: z.array(IssueTransitionSchema),
  checkedAt: z.string(),
});

export const IssueTransitionActionResultSchema = z.object({
  providerId: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  key: z.string(),
  transition: z.string(),
  checkedAt: z.string(),
});

// Picker-result row from a Jira search (`jtk issues search --jql ...`).
// Only `key` is guaranteed; the rest may be missing depending on `jtk`'s
// output (older versions occasionally omit `updated`, statuses can be
// empty during transitions).
export const IssueSearchResultSchema = z.object({
  key: z.string().min(1),
  summary: z.string().nullable(),
  status: z.string().nullable(),
  url: z.string().nullable(),
  updated: z.string().nullable(),
});

export const IssueSearchResponseSchema = z.object({
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  results: z.array(IssueSearchResultSchema),
});

// Events the Jira auto-transition wiring may listen to. Deliberately
// excludes `workspace.created` (fires before any issue can be attached) and
// `workspace.updated` (multi-fire — would burst the provider).
export const JiraAutoTransitionEventSchema = z.enum([
  "agent.started",
  "workspace.issue_attached",
  "workspace.archived",
  "workspace.removed",
]);

// Config entry: when {event} fires for a workspace with an attached issue,
// transition the issue toward {transition}. `transition` names the target
// status the issue should end up in (e.g., "In Progress", "Done"); the
// runtime picks the available transition whose `toStatus` matches
// case-insensitively. Idempotent: if the issue is already in the target
// status, the call is skipped.
export const JiraAutoTransitionSchema = z.object({
  event: JiraAutoTransitionEventSchema,
  transition: z.string().min(1),
});

export type IssueTransition = z.infer<typeof IssueTransitionSchema>;
export type IssueTrackerSummary = z.infer<typeof IssueTrackerSummarySchema>;
export type IssueTransitionActionResult = z.infer<typeof IssueTransitionActionResultSchema>;
export type IssueSearchResult = z.infer<typeof IssueSearchResultSchema>;
export type IssueSearchResponse = z.infer<typeof IssueSearchResponseSchema>;
export type JiraAutoTransitionEvent = z.infer<typeof JiraAutoTransitionEventSchema>;
export type JiraAutoTransition = z.infer<typeof JiraAutoTransitionSchema>;
