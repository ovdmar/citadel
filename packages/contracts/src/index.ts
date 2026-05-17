import { z } from "zod";

export const IdSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const ProviderStatusSchema = z.enum(["healthy", "degraded", "unavailable", "unknown"]);
export const WorkspaceLifecycleSchema = z.enum(["creating", "ready", "failed", "removing", "archived", "removed"]);
export const WorkspaceSourceSchema = z.enum(["scratch", "pr", "issue", "imported"]);
export const AgentSessionStatusSchema = z.enum([
  "starting",
  "running",
  "waiting",
  "idle",
  "failed",
  "stopped",
  "orphaned",
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
  prUrl: z.string().nullable().default(null),
  issueKey: z.string().nullable().default(null),
  issueTitle: z.string().nullable().default(null),
  section: z.string().default("backlog"),
  pinned: z.boolean().default(false),
  lifecycle: WorkspaceLifecycleSchema,
  dirty: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const RuntimeCapabilitySchema = z.object({
  supportsPrompt: z.boolean(),
  supportsResume: z.boolean(),
  supportsModelSelection: z.boolean(),
  supportsTranscript: z.boolean(),
  supportsStatusDetection: z.boolean(),
  supportsNonInteractiveGoal: z.boolean(),
  supportsShell: z.boolean(),
  supportsUsage: z.boolean(),
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
  transport: TransportStatusSchema,
  tmuxSessionName: z.string().nullable(),
  tmuxSessionId: z.string().nullable(),
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

export const RuntimeUsageSummarySchema = z.object({
  runtimeId: IdSchema,
  providerId: z.string(),
  source: z.string(),
  status: ProviderStatusSchema,
  reason: z.string().nullable(),
  model: z.string().nullable(),
  remaining: z.string().nullable(),
  spend: z.string().nullable(),
  resetAt: z.string().nullable(),
  checkedAt: z.string(),
});

export const PullRequestSummarySchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  draft: z.boolean(),
  reviewDecision: z.string().nullable(),
  checks: z.array(CheckSummarySchema),
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
});

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

export const OperationSchema = z.object({
  id: IdSchema,
  type: z.string(),
  status: OperationStatusSchema,
  repoId: IdSchema.nullable().default(null),
  workspaceId: IdSchema.nullable().default(null),
  progress: z.number().min(0).max(100),
  message: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const HookLinkSchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url(),
  kind: z.enum(["preview", "deploy", "docs", "external"]).default("external"),
});

export const HookActionSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(200).nullable().default(null),
  url: z.string().url().nullable().default(null),
});

export const HookOutputSchema = z
  .object({
    links: z.array(HookLinkSchema).max(20).default([]),
    actions: z.array(HookActionSchema).max(20).default([]),
    metadata: z.record(z.unknown()).default({}),
  })
  .default({ links: [], actions: [], metadata: {} });

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
  name: z.string().min(1),
  source: WorkspaceSourceSchema.default("scratch"),
  issueKey: z.string().min(2).optional(),
  issueTitle: z.string().min(1).optional(),
  prUrl: z.string().url().optional(),
});

export const CreateAgentSessionInputSchema = z.object({
  workspaceId: IdSchema,
  runtimeId: IdSchema,
  displayName: z.string().min(1).optional(),
  prompt: z.string().optional(),
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
});

export type Repo = z.infer<typeof RepoSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type CheckSummary = z.infer<typeof CheckSummarySchema>;
export type CiRunSummary = z.infer<typeof CiRunSummarySchema>;
export type CiProviderSummary = z.infer<typeof CiProviderSummarySchema>;
export type RuntimeUsageSummary = z.infer<typeof RuntimeUsageSummarySchema>;
export type PullRequestSummary = z.infer<typeof PullRequestSummarySchema>;
export type VersionControlSummary = z.infer<typeof VersionControlSummarySchema>;
export type IssueTransition = z.infer<typeof IssueTransitionSchema>;
export type IssueTrackerSummary = z.infer<typeof IssueTrackerSummarySchema>;
export type IssueTransitionActionResult = z.infer<typeof IssueTransitionActionResultSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type HookLink = z.infer<typeof HookLinkSchema>;
export type HookAction = z.infer<typeof HookActionSchema>;
export type HookOutput = z.infer<typeof HookOutputSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type AppEvent = z.infer<typeof AppEventSchema>;
export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type CreateAgentSessionInput = z.infer<typeof CreateAgentSessionInputSchema>;
export type TransitionIssueInput = z.infer<typeof TransitionIssueInputSchema>;
export type DiffFile = z.infer<typeof DiffFileSchema>;
export type WorkspaceDiff = z.infer<typeof WorkspaceDiffSchema>;

export type ApiError = {
  error: string;
  detail?: string;
  fieldErrors?: Record<string, string[]>;
};
