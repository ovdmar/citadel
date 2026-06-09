import { z } from "zod";
import {
  CheckoutGateStatusSchema,
  DeliveryUnitKeySchema,
  ExecutionTargetTypeSchema,
  GitBranchNameSchema,
  IssueBindingSchema,
  PlanDeviationReportSchema,
  ReviewArtifactSchema,
  RoleIdSchema,
} from "./agents-system.js";
import { IdSchema } from "./primitives.js";

export const ManagerActionStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "superseded",
  "abandoned",
]);

export const ManagerActionNameSchema = z.enum([
  "sync_issue",
  "create_checkout",
  "launch_implementation",
  "run_review_pr",
  "restack_checkout",
  "notify_ready_for_human_review",
  "notify_human_input_needed",
  "update_ticket_status",
]);

export const ManagerActionLedgerEntrySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema.nullable().default(null),
  managerId: IdSchema.nullable().default(null),
  actionName: ManagerActionNameSchema,
  status: ManagerActionStatusSchema,
  scopeKey: z.string().min(1),
  actionKey: z.string().min(1),
  factKey: z.string().min(1).nullable().default(null),
  idempotencyKey: z.string().min(1),
  leaseOwnerId: z.string().min(1).nullable().default(null),
  leaseGeneration: z.number().int().nonnegative().default(0),
  leaseExpiresAt: z.string().nullable().default(null),
  attemptCount: z.number().int().nonnegative().default(0),
  maxAttempts: z.number().int().positive().default(3),
  operationId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  artifactId: IdSchema.nullable().default(null),
  prHeadSha: z.string().min(1).nullable().default(null),
  planVersionId: IdSchema.nullable().default(null),
  claimedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastReconciledAt: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const CheckoutGateReasonSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["info", "warning", "blocking"]).default("blocking"),
  stale: z.boolean().default(false),
  targetId: z.string().min(1).nullable().default(null),
});

export const CheckoutGateSnapshotSchema = z.object({
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  planVersionId: IdSchema.nullable().default(null),
  status: CheckoutGateStatusSchema,
  reasons: z.array(CheckoutGateReasonSchema).default([]),
  refreshedAt: z.string(),
  providerFreshness: z
    .object({
      stale: z.boolean().default(false),
      fetchedAt: z.string().nullable().default(null),
      staleAt: z.string().nullable().default(null),
      degradedReason: z.string().nullable().default(null),
    })
    .default({}),
  currentReviewArtifact: ReviewArtifactSchema.nullable().default(null),
  staleReviewArtifacts: z.array(ReviewArtifactSchema).default([]),
  deviations: z.array(PlanDeviationReportSchema).default([]),
  stackParentCheckoutId: IdSchema.nullable().default(null),
});

export const StructuredLaunchOptionSeveritySchema = z.enum(["info", "warning", "blocking"]);

export const StructuredLaunchOptionSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  reason: z.string().min(1).nullable().default(null),
  severity: StructuredLaunchOptionSeveritySchema.default("info"),
  role: RoleIdSchema.nullable().default(null),
  targetType: ExecutionTargetTypeSchema,
  actionName: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const LocalNotificationEventTypeSchema = z.enum(["ready_for_human_review", "human_input_needed"]);
export const LocalNotificationEventStatusSchema = z.enum(["active", "resolved", "rearmed"]);

export const LocalNotificationEventSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema.nullable().default(null),
  type: LocalNotificationEventTypeSchema,
  status: LocalNotificationEventStatusSchema.default("active"),
  title: z.string().min(1),
  message: z.string().min(1),
  dedupeKey: z.string().min(1),
  triggeringFactFingerprint: z.string().min(1),
  managerActionId: IdSchema.nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
  rearmedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ProviderFactIdentitySchema = z.object({
  providerType: z.string().min(1),
  providerInstanceId: z.string().min(1),
  accountId: z.string().min(1).nullable().default(null),
  hostUrl: z.string().url().nullable().default(null),
  externalUrl: z.string().url().nullable().default(null),
  workspaceBindingId: z.string().min(1).nullable().default(null),
  sourceBindingType: z.enum(["workspace_parent_issue", "checkout_child_issue", "plan_delivery_unit", "checkout_pr"]),
  sourceBindingId: z.string().min(1),
});

export const ProviderIssueFactSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema.nullable().default(null),
  deliveryUnitKey: DeliveryUnitKeySchema.nullable().default(null),
  identity: ProviderFactIdentitySchema,
  issueId: z.string().min(1).nullable().default(null),
  issueKey: z.string().min(1),
  title: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  acceptanceSnapshot: z.string().nullable().default(null),
  fetchedAt: z.string(),
  staleAt: z.string().nullable().default(null),
  degradedReason: z.string().nullable().default(null),
  cooldownUntil: z.string().nullable().default(null),
});

export const IssueTransitionAttemptSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema.nullable().default(null),
  managerActionId: IdSchema.nullable().default(null),
  identity: ProviderFactIdentitySchema,
  issueId: z.string().min(1).nullable().default(null),
  issueKey: z.string().min(1),
  requestedInternalState: z.enum(["todo", "in_progress", "in_qa", "in_review", "done"]),
  currentExternalStatus: z.string().nullable().default(null),
  selectedTransition: z.string().nullable().default(null),
  resultingExternalStatus: z.string().nullable().default(null),
  success: z.boolean(),
  degradedReason: z.string().nullable().default(null),
  createdAt: z.string(),
});

export const CheckoutPrFactSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  identity: ProviderFactIdentitySchema.extend({
    repositoryId: IdSchema.nullable().default(null),
    providerRepositoryKey: z.string().min(1).nullable().default(null),
  }),
  prId: z.string().min(1).nullable().default(null),
  prNumber: z.number().int().positive().nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  headSha: z.string().min(1).nullable().default(null),
  baseRef: GitBranchNameSchema.nullable().default(null),
  mergeStateStatus: z.string().nullable().default(null),
  hasConflicts: z.boolean().nullable().default(null),
  fetchedAt: z.string(),
  staleAt: z.string().nullable().default(null),
  degradedReason: z.string().nullable().default(null),
  cooldownUntil: z.string().nullable().default(null),
});

export const CheckoutCheckFactSchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  prFactId: IdSchema.nullable().default(null),
  identity: ProviderFactIdentitySchema.extend({
    repositoryId: IdSchema.nullable().default(null),
    providerRepositoryKey: z.string().min(1).nullable().default(null),
  }),
  headSha: z.string().min(1),
  checkId: z.string().min(1).nullable().default(null),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().default(null),
  detailsUrl: z.string().url().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  fetchedAt: z.string(),
  staleAt: z.string().nullable().default(null),
  degradedReason: z.string().nullable().default(null),
});

export const AgentToolAuthoritySchema = z.object({
  id: IdSchema,
  tokenHash: z.string().min(32),
  sessionId: IdSchema,
  role: RoleIdSchema.nullable().default(null),
  actionId: z.string().min(1).nullable().default(null),
  checkoutId: IdSchema.nullable().default(null),
  planVersionId: IdSchema.nullable().default(null),
  managerActionId: IdSchema.nullable().default(null),
  allowedToolNames: z.array(z.string().min(1)).min(1),
  issuedAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable().default(null),
  revocationReason: z.string().min(1).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ManagerActionStatus = z.infer<typeof ManagerActionStatusSchema>;
export type ManagerActionName = z.infer<typeof ManagerActionNameSchema>;
export type ManagerActionLedgerEntry = z.infer<typeof ManagerActionLedgerEntrySchema>;
export type CheckoutGateReason = z.infer<typeof CheckoutGateReasonSchema>;
export type CheckoutGateSnapshotContract = z.infer<typeof CheckoutGateSnapshotSchema>;
export type StructuredLaunchOptionSeverity = z.infer<typeof StructuredLaunchOptionSeveritySchema>;
export type StructuredLaunchOption = z.infer<typeof StructuredLaunchOptionSchema>;
export type LocalNotificationEventType = z.infer<typeof LocalNotificationEventTypeSchema>;
export type LocalNotificationEventStatus = z.infer<typeof LocalNotificationEventStatusSchema>;
export type LocalNotificationEvent = z.infer<typeof LocalNotificationEventSchema>;
export type ProviderFactIdentity = z.infer<typeof ProviderFactIdentitySchema>;
export type ProviderIssueFact = z.infer<typeof ProviderIssueFactSchema>;
export type IssueTransitionAttempt = z.infer<typeof IssueTransitionAttemptSchema>;
export type CheckoutPrFact = z.infer<typeof CheckoutPrFactSchema>;
export type CheckoutCheckFact = z.infer<typeof CheckoutCheckFactSchema>;
export type AgentToolAuthority = z.infer<typeof AgentToolAuthoritySchema>;
