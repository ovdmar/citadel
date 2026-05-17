import { z } from "zod";
export const IdSchema = z
  .string()
  .min(6)
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
export const ActivityEventSchema = z.object({
  id: IdSchema,
  type: z.string(),
  source: z.enum(["user", "system", "mcp", "hook", "provider", "agent", "automatic-rule", "cli"]),
  repoId: IdSchema.nullable().default(null),
  workspaceId: IdSchema.nullable().default(null),
  operationId: IdSchema.nullable().default(null),
  message: z.string(),
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
//# sourceMappingURL=index.js.map
