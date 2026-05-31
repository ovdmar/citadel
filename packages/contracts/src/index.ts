import { z } from "zod";
import { ParentPrSchema, PrCommitSchema, PrMergeStrategySchema } from "./pr-routes.js";
import { IdSchema } from "./primitives.js";
export { IdSchema } from "./primitives.js";

export const ProviderStatusSchema = z.enum(["healthy", "degraded", "unavailable", "unknown"]);
export const WorkspaceLifecycleSchema = z.enum(["creating", "ready", "failed", "removing", "archived", "removed"]);
export const WorkspaceSourceSchema = z.enum(["scratch", "pr", "issue", "imported"]);
export const WorkspaceKindSchema = z.enum(["worktree", "root"]);
export const AgentSessionStatusSchema = z.enum([
  "starting",
  "running",
  "waiting_for_input",
  "rate_limited",
  "usage_limited",
  "idle",
  "stopped",
  "failed",
  "unknown",
]);
export const TransportStatusSchema = z.enum(["disconnected", "connecting", "connected", "degraded"]);
export const OperationStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

export const RepoSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  rootPath: z.string().min(1),
  defaultBranch: z.string().min(1).default("main"),
  defaultRemote: z.string().min(1).default("origin"),
  worktreeParent: z.string().min(1),
  setupHookIds: z.array(z.string()).default([]),
  teardownHookIds: z.array(z.string()).default([]),
  providerIds: z.array(z.string()).default([]),
  deployHookCommand: z.string().max(4000).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const WorkspaceSchema = z.object({
  id: IdSchema,
  repoId: IdSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  source: WorkspaceSourceSchema,
  kind: WorkspaceKindSchema.default("worktree"),
  prUrl: z.string().nullable().default(null),
  issueKey: z.string().nullable().default(null),
  issueTitle: z.string().nullable().default(null),
  issueUrl: z.string().url().nullable().default(null),
  slackThreadUrl: z.string().url().nullable().default(null),
  section: z.string().default("backlog"),
  pinned: z.boolean().default(false),
  lifecycle: WorkspaceLifecycleSchema,
  dirty: z.boolean().default(false),
  namespaceId: IdSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export {
  AssignWorkspaceToNamespaceInputSchema,
  CreateNamespaceInputSchema,
  NamespaceColorSchema,
  NamespaceSchema,
  UpdateNamespaceInputSchema,
} from "./namespaces.js";

export const RuntimeCapabilitySchema = z.object({
  supportsPrompt: z.boolean(),
  supportsResume: z.boolean(),
  supportsModelSelection: z.boolean(),
  supportsTranscript: z.boolean(),
  supportsStatusDetection: z.boolean(),
  supportsNonInteractiveGoal: z.boolean(),
  supportsShell: z.boolean(),
  supportsUsage: z.boolean(),
  // Runtimes whose output is a TUI (Claude Code, Codex, anything ncurses).
  // Background scheduled-agent runs disable themselves for these runtimes
  // because tmux pipe-pane would capture raw ANSI escapes and produce an
  // unreadable log file. Optional + defaults to false to preserve back-compat
  // with shell-only runtimes whose configs do not set it.
  supportsTui: z.boolean().optional().default(false),
});

export const AgentRuntimeSchema = z.object({
  id: IdSchema,
  displayName: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  health: ProviderStatusSchema,
  healthReason: z.string().nullable().default(null),
  capabilities: RuntimeCapabilitySchema,
});

export const AgentSessionSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  runtimeId: IdSchema,
  displayName: z.string(),
  status: AgentSessionStatusSchema,
  // Status-tracking fields written by the DB layer; optional at the TS level
  // so older test fixtures still typecheck.
  statusReason: z.string().nullable().optional(),
  // ISO timestamp of when `statusReason` was last written, independent of
  // `lastStatusAt` (which is reset on every status touch — including benign
  // sub-status flips from the runtime adapter). The status-monitor uses this
  // to drive the 30-minute auto-clear of `idle_after_unexpected_exit`: when
  // the reason persists past the window with no operator Restart, the
  // attention pulse fades naturally.
  statusReasonAt: z.string().nullable().optional(),
  lastStatusAt: z.string().optional(),
  lastOutputAt: z.string().nullable().optional(),
  endedAt: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  transport: TransportStatusSchema,
  tmuxSessionName: z.string().nullable(),
  tmuxSessionId: z.string().nullable(),
  // Tmux socket name that owns this pane. Persisted legacy rows are backfilled
  // to workspace-specific sockets; null/omitted still means the legacy daemon
  // socket from CITADEL_TMUX_SOCKET for in-memory/back-compat callers.
  tmuxSocketName: z.string().nullable().optional(),
  // Stable per-tab identifier that survives across restore-spawn-restore
  // cycles. Generated fresh on first session create in a workspace; inherited
  // by every subsequent row that resumes the same conversation (the restored
  // session takes the original's tabId). The cockpit's tab strip sorts by
  // tabId (time-encoded by createId) so a restored session re-appears in the
  // same slot the original lived in, instead of jumping to the end of the row.
  // Optional in the contract so older test fixtures keep parsing; the DB
  // layer always materializes a value via the migration backfill.
  tabId: z.string().optional(),
  // Runtime-native session UUID (e.g. Claude Code's --session-id). Populated at
  // spawn time so we can resume the same conversation across daemon and machine
  // restarts, and so the Settings restore flow has a stable handle.
  runtimeSessionId: z.string().nullable().optional(),
  // Auto-resume bookkeeping for sessions that hit a global API rate limit.
  // The daemon's auto-resume loop populates these so backoff state survives
  // daemon restarts: `rateLimitResumeAttempts` is the consecutive resume-send
  // count used for exponential backoff, `nextResumeAt` is when the loop is
  // allowed to attempt the next resume (null = unscheduled), and
  // `lastResumeFromRateLimitAt` records the most recent auto-resume submit.
  rateLimitResumeAttempts: z.number().int().nonnegative().optional(),
  nextResumeAt: z.string().nullable().optional(),
  lastResumeFromRateLimitAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProviderHealthSchema = z.object({
  id: IdSchema,
  kind: z.enum(["version-control", "pull-request", "ci", "issue-tracker", "usage", "notification"]),
  displayName: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable().default(null),
  checkedAt: z.string(),
});

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

export const CiProviderSummarySchema = z.object({
  providerId: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  runs: z.array(CiRunSummarySchema),
  checkedAt: z.string(),
});

export const RuntimeUsageCategorySchema = z.object({
  label: z.string().min(1),
  // Normalized "% used" (0-100). Providers that report "% left" must convert
  // before populating this field — see codex fetcher.
  percentUsed: z.number().min(0).max(100),
  reset: z.string().nullable().default(null),
  section: z.string().nullable().default(null),
});

export const RuntimeUsageSummarySchema = z.object({
  runtimeId: IdSchema,
  providerId: z.string(),
  source: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  categories: z.array(RuntimeUsageCategorySchema).default([]),
  checkedAt: z.string(),
});

export const GitHubQuotaResourceSchema = z.object({
  name: z.enum(["core", "graphql", "search"]),
  limit: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  percentUsed: z.number().min(0).max(100),
  resetAt: z.string().nullable(),
});

export const GitHubQuotaSummarySchema = z.object({
  providerId: z.literal("github-gh"),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  checkedAt: z.string(),
  cooldownUntil: z.string().nullable().default(null),
  automationEnabled: z.boolean().default(true),
  resources: z.array(GitHubQuotaResourceSchema).default([]),
});

export const PrReviewerStateSchema = z.enum(["approved", "changes_requested", "commented", "pending", "dismissed"]);

export const PrReviewerSchema = z.object({
  login: z.string().min(1),
  name: z.string().nullable().default(null),
  state: PrReviewerStateSchema,
});

// GitHub's mergeStateStatus enum; affects the workspace-card "conflicting"
// tone (DIRTY → red border) but not the readiness state itself. Lowercase
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
  // gh `pr view --json mergeStateStatus` — affects card tone only.
  mergeStateStatus: PrMergeStateStatusSchema.nullable().default(null),
  // gh `pr view --json headRefOid` — the PR head commit SHA. Used by the
  // CI auto-recovery tick to dedupe per-SHA so we don't re-launch agents
  // on CI re-runs of the same commit.
  headSha: z.string().nullable().default(null),
});

export const VersionControlSummarySchema = z.object({
  providerId: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  currentBranch: z.string().nullable(),
  remotes: z.array(z.string()),
  pullRequest: PullRequestSummarySchema.nullable(),
  checkedAt: z.string(),
  // ISO timestamp of when the daemon's global gh rate-limit cooldown clears,
  // present only while a cooldown is active. The pr-routes response builder
  // decorates outgoing payloads with this regardless of whether the body came
  // from a fresh fetch, a scheduler-skip cache fallback, or a stale snapshot,
  // so the FE banner sees the same signal on every code path.
  // Optional (not required) so older daemon ↔ newer FE remains compatible.
  cooldownUntil: z.string().nullable().optional(),
});

export {
  IssueSearchResponseSchema,
  IssueSearchResultSchema,
  IssueTrackerSummarySchema,
  IssueTransitionActionResultSchema,
  IssueTransitionSchema,
  JiraAutoTransitionEventSchema,
  JiraAutoTransitionSchema,
} from "./jira.js";
import { IssueTrackerSummarySchema } from "./jira.js";

export const OperationLogEntrySchema = z.object({
  level: z.enum(["info", "warn", "error"]).default("info"),
  message: z.string(),
  at: z.string(),
});

export const OperationSchema = z.object({
  id: IdSchema,
  type: z.string(),
  status: OperationStatusSchema,
  repoId: IdSchema.nullable().default(null),
  workspaceId: IdSchema.nullable().default(null),
  progress: z.number().min(0).max(100),
  message: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  logs: z.array(OperationLogEntrySchema).default([]),
  retriable: z.boolean().default(false),
  retryInput: z.record(z.unknown()).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const GitStatusSummarySchema = z.object({
  branch: z.string().nullable().default(null),
  upstream: z.string().nullable().default(null),
  ahead: z.number().int().default(0),
  behind: z.number().int().default(0),
  modified: z.number().int().default(0),
  staged: z.number().int().default(0),
  untracked: z.number().int().default(0),
  deleted: z.number().int().default(0),
  renamed: z.number().int().default(0),
  conflicted: z.number().int().default(0),
  clean: z.boolean(),
  lines: z.array(z.string()).max(200).default([]),
  checkedAt: z.string(),
});

export const HookLinkSchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url(),
  kind: z.enum(["preview", "deploy", "docs", "external"]).default("external"),
});

export const HookApplicationSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  kind: z.enum(["preview", "deployment", "service", "docs", "external"]).default("service"),
  url: z.string().url().nullable().default(null),
  environment: z.string().max(80).nullable().default(null),
  status: z.enum(["healthy", "degraded", "unavailable", "unknown"]).default("unknown"),
  version: z.string().max(120).nullable().default(null),
  commit: z.string().max(80).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const HookActionSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(200).nullable().default(null),
  url: z.string().url().nullable().default(null),
  kind: z.enum(["redeploy", "restart", "logs", "open", "custom"]).optional(),
  safety: z.enum(["safe", "confirm", "destructive"]).optional(),
  executable: z.boolean().optional(),
  hookId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const HookOutputSchema = z
  .object({
    applications: z.array(HookApplicationSchema).max(30).optional(),
    links: z.array(HookLinkSchema).max(20).default([]),
    actions: z.array(HookActionSchema).max(20).default([]),
    metadata: z.record(z.unknown()).default({}),
  })
  .default({ links: [], actions: [], metadata: {} });

export const HookDiagnosticSchema = z.object({
  hookId: z.string(),
  event: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  blocking: z.boolean(),
  enabled: z.boolean(),
  validationStatus: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.string()).default([]),
  lastRunAt: z.string().nullable().default(null),
  durationMs: z.number().int().nullable().default(null),
  exitStatus: z.number().int().nullable().default(null),
  outputSummary: z.string().nullable().default(null),
  structuredPayload: HookOutputSchema.nullable().default(null),
});

export const DeployedAppStatusSchema = z.enum(["deployed", "stopped", "unknown"]);

export const DeployedAppSchema = z.object({
  workspaceId: IdSchema,
  name: z.string().min(1).max(80),
  url: z.string().url(),
  status: DeployedAppStatusSchema,
  lastChecked: z.string(),
});

// The structured payload the `<hook> list` subcommand must emit on stdout.
// The 50-app cap is a sanity guard — real repos surface a handful of apps; a
// runaway hook spewing thousands of entries indicates a bug we'd rather reject
// than render. Tighten/widen with care.
export const DeployHookListOutputSchema = z.object({
  apps: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        url: z.string().url(),
      }),
    )
    .max(50),
});

export const DeployHookSourceSchema = z.enum(["repo-file", "repo-config", "none"]);

export const DeployHookResolutionSchema = z.object({
  source: DeployHookSourceSchema,
  filePath: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  // Diagnostic breadcrumb when resolution had to fall back or skip a candidate —
  // e.g. "<path> exists but is not executable; using repo-config fallback".
  note: z.string().nullable().default(null),
});

export const DeployedAppsSummarySchema = z.object({
  workspaceId: IdSchema,
  resolution: DeployHookResolutionSchema,
  apps: z.array(DeployedAppSchema),
  error: z.string().nullable().default(null),
  checkedAt: z.string(),
});

export const WorkspaceReadinessSchema = z.object({
  state: z.enum([
    "working",
    "needs-review",
    "checks-failing",
    "conflicts",
    "pr-conflicts",
    "dirty",
    "waiting-provider",
    "action-failed",
    "ready-to-merge",
    "idle",
    "blocked",
  ]),
  tone: z.enum(["neutral", "info", "success", "warning", "danger"]),
  nextAction: z.string(),
  reasons: z.array(z.string()).default([]),
  freshness: z.object({
    checkedAt: z.string(),
    stale: z.boolean(),
    degraded: z.boolean(),
  }),
});

export const WorkspaceAppsSummarySchema = z.object({
  workspaceId: IdSchema,
  status: ProviderStatusSchema,
  reason: z.string().nullable().default(null),
  hooks: z.array(HookDiagnosticSchema).default([]),
  applications: z.array(HookApplicationSchema).default([]),
  links: z.array(HookLinkSchema).default([]),
  actions: z.array(HookActionSchema).default([]),
  checkedAt: z.string(),
});

export const WorkspaceCockpitSummarySchema = z.object({
  workspaceId: IdSchema,
  readiness: WorkspaceReadinessSchema,
  git: GitStatusSummarySchema,
  versionControl: VersionControlSummarySchema,
  ci: CiProviderSummarySchema,
  issueTracker: IssueTrackerSummarySchema.nullable().default(null),
  apps: WorkspaceAppsSummarySchema,
});

export const ActivityEventSchema = z.object({
  id: IdSchema,
  type: z.string(),
  source: z.enum(["user", "system", "mcp", "hook", "provider", "agent", "automatic-rule", "cli"]),
  repoId: IdSchema.nullable().default(null),
  workspaceId: IdSchema.nullable().default(null),
  operationId: IdSchema.nullable().default(null),
  message: z.string(),
  hookOutput: HookOutputSchema.nullable().default(null),
  createdAt: z.string(),
});

export const AppEventSchema = z.object({
  id: IdSchema,
  type: z.string(),
  timestamp: z.string(),
  source: z.string(),
  repoId: IdSchema.nullable().optional(),
  workspaceId: IdSchema.nullable().optional(),
  operationId: IdSchema.nullable().optional(),
  payload: z.unknown(),
});

export const CreateRepoInputSchema = z.object({
  rootPath: z.string().min(1),
  name: z.string().min(1).optional(),
  worktreeParent: z.string().min(1).optional(),
});

export const CreateWorkspaceInputSchema = z.object({
  repoId: IdSchema,
  // Empty `name` → daemon generates a funny-name (e.g. funny-cat).
  name: z.string().default(""),
  source: WorkspaceSourceSchema.default("scratch"),
  issueKey: z.string().min(2).optional(),
  issueTitle: z.string().min(1).optional(),
  issueUrl: z.string().url().optional(),
  slackThreadUrl: z.string().url().optional(),
  prUrl: z.string().url().optional(),
  baseBranch: z.string().min(1).optional(),
  existingBranch: z.string().min(1).optional(),
  newBranch: z.string().min(1).optional(),
  namespaceId: IdSchema.optional(),
});

export const CreateAgentSessionInputSchema = z.object({
  workspaceId: IdSchema,
  runtimeId: IdSchema,
  displayName: z.string().min(1).optional(),
  prompt: z.string().optional(),
  namespaceId: IdSchema.optional(),
  // When set, the spawn uses `--resume <uuid>` (via the runtime's resumeArg)
  // instead of generating a fresh UUID via `--session-id`. The runtime
  // session's transcript on disk must exist; the caller is responsible for
  // validating that (see the Settings restore flow / backfill).
  resumeRuntimeSessionId: z.string().uuid().optional(),
  // When set, the new session is bound to an existing tab slot (instead of
  // generating a fresh tabId). Restore paths pass the source row's tabId so
  // the restored session reuses the original tab position in the cockpit's
  // tab strip. Non-restore callers leave this unset and get a fresh tabId.
  tabId: z.string().optional(),
});

// High-level one-shot launcher used by MCP orchestrators: create a workspace
// and start an agent session in it in a single call. Either `repoId` (an
// internal id) or `repoName` (the configured repo display name) must be
// provided; everything else is optional with sensible defaults.
export const LaunchAgentInputSchema = z
  .object({
    repoId: IdSchema.optional(),
    repoName: z.string().min(1).optional(),
    prompt: z.string().min(1),
    runtimeId: IdSchema.default("claude-code"),
    displayName: z.string().min(1).max(80).optional(),
    workspaceName: z.string().min(1).max(80).optional(),
    namespaceId: z.string().min(1).max(80).optional(),
    branchName: z.string().min(1).max(120).optional(),
  })
  .refine((data) => Boolean(data.repoId) !== Boolean(data.repoName), {
    message: "Provide exactly one of repoId or repoName",
    path: ["repoId"],
  });

/**
 * A user-authored prompt as recorded by the runtime's own transcript. Citadel
 * does not persist prompts — they are extracted on demand from per-runtime
 * adapters (claude-code .jsonl, codex rollout files, etc.) so UI typing,
 * MCP follow-ups, and CLI-flag initial prompts all surface the same way.
 */
export const AgentPromptSchema = z.object({
  externalId: z.string(),
  text: z.string(),
  sentAt: z.string(),
});

export const TransitionIssueInputSchema = z.object({
  transition: z.string().min(1),
  fields: z.record(z.string()).default({}),
});

export const DiffFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  binary: z.boolean(),
  truncated: z.boolean(),
  diff: z.string(),
});

export const WorkspaceDiffSchema = z.object({
  workspaceId: IdSchema,
  clean: z.boolean(),
  files: z.array(DiffFileSchema),
  truncated: z.boolean(),
  addedLines: z.number().int().default(0),
  deletedLines: z.number().int().default(0),
});

export const RecentCommitSchema = z.object({
  sha: z.string().min(7),
  shortSha: z.string().min(4),
  message: z.string(),
  author: z.string(),
  relativeTime: z.string(),
  isoTime: z.string(),
});

export const WorkspaceRecentCommitsSchema = z.object({
  workspaceId: IdSchema,
  commits: z.array(RecentCommitSchema),
});

export type Repo = z.infer<typeof RepoSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type AgentPrompt = z.infer<typeof AgentPromptSchema>;
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type CheckSummary = z.infer<typeof CheckSummarySchema>;
export type CiRunSummary = z.infer<typeof CiRunSummarySchema>;
export type CiProviderSummary = z.infer<typeof CiProviderSummarySchema>;
export type RuntimeUsageCategory = z.infer<typeof RuntimeUsageCategorySchema>;
export type RuntimeUsageSummary = z.infer<typeof RuntimeUsageSummarySchema>;
export type GitHubQuotaResource = z.infer<typeof GitHubQuotaResourceSchema>;
export type GitHubQuotaSummary = z.infer<typeof GitHubQuotaSummarySchema>;
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;
export type PrReviewer = z.infer<typeof PrReviewerSchema>;
export type PrReviewerState = z.infer<typeof PrReviewerStateSchema>;
export type VersionControlSummary = z.infer<typeof VersionControlSummarySchema>;
export type {
  IssueSearchResponse,
  IssueSearchResult,
  IssueTrackerSummary,
  IssueTransition,
  IssueTransitionActionResult,
  JiraAutoTransition,
  JiraAutoTransitionEvent,
} from "./jira.js";
export type Operation = z.infer<typeof OperationSchema>;
export type OperationLogEntry = z.infer<typeof OperationLogEntrySchema>;
export type GitStatusSummary = z.infer<typeof GitStatusSummarySchema>;
export type HookApplication = z.infer<typeof HookApplicationSchema>;
export type HookLink = z.infer<typeof HookLinkSchema>;
export type HookAction = z.infer<typeof HookActionSchema>;
export type HookOutput = z.infer<typeof HookOutputSchema>;
export type HookDiagnostic = z.infer<typeof HookDiagnosticSchema>;
export type WorkspaceReadiness = z.infer<typeof WorkspaceReadinessSchema>;
export type WorkspaceAppsSummary = z.infer<typeof WorkspaceAppsSummarySchema>;
export type WorkspaceCockpitSummary = z.infer<typeof WorkspaceCockpitSummarySchema>;
export type DeployedApp = z.infer<typeof DeployedAppSchema>;
export type DeployedAppStatus = z.infer<typeof DeployedAppStatusSchema>;
export type DeployHookListOutput = z.infer<typeof DeployHookListOutputSchema>;
export type DeployHookResolution = z.infer<typeof DeployHookResolutionSchema>;
export type DeployHookSource = z.infer<typeof DeployHookSourceSchema>;
export type DeployedAppsSummary = z.infer<typeof DeployedAppsSummarySchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type AppEvent = z.infer<typeof AppEventSchema>;
export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;
export type { WorkspaceDirtySummary } from "./workspace-dirty.js";
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type CreateAgentSessionInput = z.infer<typeof CreateAgentSessionInputSchema>;
export type LaunchAgentInput = z.infer<typeof LaunchAgentInputSchema>;
export type TransitionIssueInput = z.infer<typeof TransitionIssueInputSchema>;
export type {
  AssignWorkspaceToNamespaceInput,
  CreateNamespaceInput,
  Namespace,
  UpdateNamespaceInput,
} from "./namespaces.js";
export type DiffFile = z.infer<typeof DiffFileSchema>;
export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;
export type RecentCommit = z.infer<typeof RecentCommitSchema>;
export type WorkspaceRecentCommits = z.infer<typeof WorkspaceRecentCommitsSchema>;

// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export type { ScratchpadSnapshot, ReadScratchpadResult, ScratchpadHistorySource, ScratchpadHistoryEntry, ScratchpadHistorySummary, ScratchpadBlock, ScratchpadBlockSummary, ScratchpadBlockPosition } from "./scratchpad.js";

export * from "./citadel-actions.js";

export type ApiError = { error: string; detail?: string; fieldErrors?: Record<string, string[]> };
export * from "./scheduled-agents.js";
