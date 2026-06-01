import { z } from "zod";
import { IdSchema } from "./primitives.js";

export const WorkspaceModeSchema = z.enum(["freestyle", "structured"]);

export const WorkspaceLifecyclePhaseSchema = z.enum([
  "discovery_inputs",
  "architecture",
  "plan_review",
  "implementation",
  "ready_for_human_review",
  "done",
]);

export const IssueBindingSchema = z.object({
  provider: z.string().min(1),
  key: z.string().min(1),
  url: z.string().url().nullable().default(null),
  title: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  fetchedAt: z.string().nullable().default(null),
});

export const PullRequestBindingSchema = z.object({
  provider: z.string().min(1),
  number: z.number().int().positive().nullable().default(null),
  url: z.string().url().nullable().default(null),
  headSha: z.string().nullable().default(null),
  baseRef: z.string().nullable().default(null),
  fetchedAt: z.string().nullable().default(null),
});

export const ExecutionTargetTypeSchema = z.enum(["workspace_home", "worktree_checkout"]);

export const WorkspaceHomeTargetSchema = z.object({
  type: z.literal("workspace_home"),
  workspaceId: IdSchema,
  cwd: z.string().min(1),
});

export const CheckoutGateStatusSchema = z.enum([
  "not_started",
  "blocked",
  "waiting_for_pr",
  "checks_pending",
  "checks_failing",
  "conflicts",
  "review_required",
  "review_blocked",
  "needs_restack",
  "stale_provider",
  "ready_for_human_review",
  "done",
]);

export const CheckoutPurposeSchema = z.enum(["prototype", "implementation"]);

export const WorktreeCheckoutSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  repoId: IdSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1),
  issue: IssueBindingSchema.nullable().default(null),
  intendedPr: PullRequestBindingSchema.nullable().default(null),
  stackParentCheckoutId: IdSchema.nullable().default(null),
  inferredPurpose: CheckoutPurposeSchema.nullable().default(null),
  gateStatus: CheckoutGateStatusSchema.default("not_started"),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable().default(null),
});

export const WorktreeCheckoutTargetSchema = z.object({
  type: z.literal("worktree_checkout"),
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  cwd: z.string().min(1),
});

export const ExecutionTargetSchema = z.discriminatedUnion("type", [
  WorkspaceHomeTargetSchema,
  WorktreeCheckoutTargetSchema,
]);

export const RoleIdSchema = z.enum(["pm", "architect", "implementation", "prototype", "manager"]);

export const ActionTemplateIdSchema = z.enum([
  "implementation.review_pr",
  "implementation.fix_ci",
  "implementation.fix_conflicts",
  "implementation.poke_idle_without_pr",
  "implementation.restack_checkout",
  "architect.replan_from_deviation",
  "manager.heartbeat_digest",
  "manager.notify_ready_for_human_review",
  "manager.update_ticket_status",
  "prototype.capture_findings",
]);

export const LaunchSettingsSchema = z.object({
  runtimeId: IdSchema,
  model: z.string().min(1).nullable().default(null),
  effort: z.string().min(1).nullable().default(null),
  fastMode: z.boolean().nullable().default(null),
  contextMode: z.string().min(1).nullable().default(null),
});

export const RuntimeModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  default: z.boolean().default(false),
  deprecated: z.boolean().default(false),
});

export const RuntimeLaunchOptionCapabilitiesSchema = z.object({
  runtimeId: IdSchema,
  models: z.array(RuntimeModelSchema).default([]),
  defaultModel: z.string().min(1).nullable().default(null),
  effortValues: z.array(z.string().min(1)).default([]),
  supportsFastMode: z.boolean().default(false),
  contextModes: z.array(z.string().min(1)).default([]),
  checkedAt: z.string().nullable().default(null),
  stale: z.boolean().default(false),
  reason: z.string().nullable().default(null),
});

export const ActionExecutionModeSchema = z.enum(["new_session", "existing_session"]);

export const ActionTemplateSchema = z
  .object({
    id: ActionTemplateIdSchema,
    role: RoleIdSchema,
    displayName: z.string().min(1),
    prompt: z.string().min(1),
    launchSettings: LaunchSettingsSchema,
    executionMode: ActionExecutionModeSchema.default("new_session"),
    builtIn: z.literal(true).default(true),
    resettable: z.literal(true).default(true),
    updatedAt: z.string().nullable().default(null),
  })
  .refine((value) => value.id.startsWith(`${value.role}.`), {
    message: "Action template id must belong to its role",
    path: ["id"],
  });

export const RoleTemplateSchema = z.object({
  role: RoleIdSchema,
  displayName: z.string().min(1),
  systemPrompt: z.string().min(1),
  launchSettings: LaunchSettingsSchema,
  actions: z.array(ActionTemplateSchema).default([]),
  builtIn: z.literal(true).default(true),
  resettable: z.literal(true).default(true),
  updatedAt: z.string().nullable().default(null),
});

export const UpdateRoleTemplateInputSchema = z.object({
  systemPrompt: z.string().min(1).optional(),
  launchSettings: LaunchSettingsSchema.optional(),
  updatedAt: z.string(),
});

export const UpdateActionTemplateInputSchema = z.object({
  prompt: z.string().min(1).optional(),
  launchSettings: LaunchSettingsSchema.optional(),
  executionMode: ActionExecutionModeSchema.optional(),
  updatedAt: z.string(),
});

export const WorkspacePlanStatusSchema = z.enum([
  "draft",
  "under_review",
  "changes_requested",
  "approved",
  "superseded",
]);

export const PlanApprovalModeSchema = z.enum(["manual", "auto"]);

export const WorkspacePlanVersionSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  version: z.number().int().positive(),
  status: WorkspacePlanStatusSchema,
  path: z.string().min(1).nullable().default(null),
  hash: z.string().min(1),
  active: z.boolean().default(false),
  approvalMode: PlanApprovalModeSchema.default("manual"),
  createdBySessionId: IdSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const WorkspacePlanReviewSchema = z.object({
  id: IdSchema,
  planVersionId: IdSchema,
  reviewer: z.string().min(1),
  result: z.enum(["approve", "nit", "request_changes", "failed"]),
  artifactPath: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const WorkspacePlanDecisionSchema = z.object({
  id: IdSchema,
  planVersionId: IdSchema,
  decision: z.enum(["approve", "request_changes", "supersede"]),
  reason: z.string().nullable().default(null),
  actor: z.enum(["human", "manager", "system"]),
  createdAt: z.string(),
});

export const PlanDeviationReportSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema.nullable().default(null),
  planVersionId: IdSchema,
  severity: z.enum(["info", "blocking"]),
  description: z.string().min(1),
  status: z.enum(["open", "resolved", "superseded"]).default("open"),
  reportedBySessionId: IdSchema.nullable().default(null),
  createdAt: z.string(),
  resolvedAt: z.string().nullable().default(null),
});

export const ReviewArtifactSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  planVersionId: IdSchema,
  prProvider: z.string().min(1),
  prNumber: z.number().int().positive().nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  headSha: z.string().min(1),
  result: z.enum(["approve", "nit", "request_changes", "failed"]),
  findingsStatus: z.enum(["none", "open_blocking", "resolved", "waived"]),
  blockingFindings: z.array(z.string().min(1)).default([]),
  artifactPath: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const ManagerPauseStateSchema = z.enum(["running", "paused"]);

export const WorkspaceManagerSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  pauseState: ManagerPauseStateSchema.default("running"),
  heartbeatIntervalSeconds: z.number().int().positive().default(300),
  lastHeartbeatAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ManagerEventSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  managerId: IdSchema,
  type: z.string().min(1),
  scopeKey: z.string().min(1),
  actionKey: z.string().min(1).nullable().default(null),
  idempotencyKey: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
  message: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const RegisterWorkspacePlanInputSchema = z.object({
  workspaceId: IdSchema.optional(),
  cwd: z.string().min(1).optional(),
  path: z.string().min(1),
  status: WorkspacePlanStatusSchema.default("draft"),
  approvalMode: PlanApprovalModeSchema.default("manual"),
  createdBySessionId: IdSchema.optional(),
});

export const CwdContextInputSchema = z.object({
  cwd: z.string().min(1),
});

const ActorSourceSchema = z.enum(["human", "manager", "agent", "mcp", "system"]);

export const LaunchPmAgentInputSchema = z.object({
  workspaceId: IdSchema.optional(),
  cwd: z.string().min(1).optional(),
  idea: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  parentIssue: IssueBindingSchema.optional(),
  actor: ActorSourceSchema.default("mcp"),
});

export const LaunchArchitectAgentInputSchema = z.object({
  workspaceId: IdSchema.optional(),
  cwd: z.string().min(1).optional(),
  planApprovalMode: PlanApprovalModeSchema,
  actor: ActorSourceSchema.default("mcp"),
});

export const LaunchImplementationAgentInputSchema = z.object({
  checkoutId: IdSchema.optional(),
  cwd: z.string().min(1).optional(),
  planVersionId: IdSchema.optional(),
  actor: ActorSourceSchema.default("mcp"),
});

export const LaunchPrototypeAgentInputSchema = z.object({
  checkoutId: IdSchema.optional(),
  cwd: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  actor: ActorSourceSchema.default("mcp"),
});

export const CreateWorkspaceCheckoutInputSchema = z.object({
  workspaceId: IdSchema,
  repoId: IdSchema,
  name: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  source: z.enum(["default_branch", "existing_branch", "pr", "upstream_checkout"]).default("default_branch"),
  upstreamCheckoutId: IdSchema.optional(),
  issue: IssueBindingSchema.optional(),
});

export const MarkCheckoutReadyForReviewInputSchema = z.object({
  checkoutId: IdSchema,
  sessionId: IdSchema.optional(),
  pr: PullRequestBindingSchema.optional(),
  notes: z.string().optional(),
});

export const UpdateTicketStatusInputSchema = z.object({
  workspaceId: IdSchema,
  checkoutId: IdSchema.optional(),
  issue: IssueBindingSchema,
  targetState: z.enum(["todo", "in_progress", "in_qa", "in_review", "done"]),
});

export type WorkspaceMode = z.infer<typeof WorkspaceModeSchema>;
export type WorkspaceLifecyclePhase = z.infer<typeof WorkspaceLifecyclePhaseSchema>;
export type IssueBinding = z.infer<typeof IssueBindingSchema>;
export type PullRequestBinding = z.infer<typeof PullRequestBindingSchema>;
export type ExecutionTargetType = z.infer<typeof ExecutionTargetTypeSchema>;
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>;
export type WorktreeCheckout = z.infer<typeof WorktreeCheckoutSchema>;
export type CheckoutGateStatus = z.infer<typeof CheckoutGateStatusSchema>;
export type RoleId = z.infer<typeof RoleIdSchema>;
export type ActionTemplateId = z.infer<typeof ActionTemplateIdSchema>;
export type LaunchSettings = z.infer<typeof LaunchSettingsSchema>;
export type RuntimeLaunchOptionCapabilities = z.infer<typeof RuntimeLaunchOptionCapabilitiesSchema>;
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;
export type ActionTemplate = z.infer<typeof ActionTemplateSchema>;
export type UpdateRoleTemplateInput = z.infer<typeof UpdateRoleTemplateInputSchema>;
export type UpdateActionTemplateInput = z.infer<typeof UpdateActionTemplateInputSchema>;
export type WorkspacePlanVersion = z.infer<typeof WorkspacePlanVersionSchema>;
export type WorkspacePlanReview = z.infer<typeof WorkspacePlanReviewSchema>;
export type WorkspacePlanDecision = z.infer<typeof WorkspacePlanDecisionSchema>;
export type PlanDeviationReport = z.infer<typeof PlanDeviationReportSchema>;
export type ReviewArtifact = z.infer<typeof ReviewArtifactSchema>;
export type WorkspaceManager = z.infer<typeof WorkspaceManagerSchema>;
export type ManagerEvent = z.infer<typeof ManagerEventSchema>;
export type RegisterWorkspacePlanInput = z.infer<typeof RegisterWorkspacePlanInputSchema>;
export type CreateWorkspaceCheckoutInput = z.infer<typeof CreateWorkspaceCheckoutInputSchema>;
