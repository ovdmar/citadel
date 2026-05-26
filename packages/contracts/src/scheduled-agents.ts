import { z } from "zod";
import { IdSchema } from "./id.js";

export const ScheduledAgentWorkspaceStrategySchema = z.enum(["new", "existing"]);
// Status of the denormalized cache on the agent row — includes "never" for
// agents that have not yet fired.
export const ScheduledAgentRunStatusSchema = z.enum(["never", "running", "succeeded", "failed"]);
// Status of a single run row in scheduled_agent_runs — "never" is not valid
// here (every row represents an actual fire).
export const ScheduledAgentRunRowStatusSchema = z.enum(["queued", "running", "succeeded", "failed"]);
export const ScheduledAgentScheduleTypeSchema = z.enum(["recurring", "once"]);
export const ScheduledAgentRunModeSchema = z.enum(["workspace", "background"]);
export const ScheduledAgentOverlapPolicySchema = z.enum(["skip", "queue"]);

export const ScheduledAgentSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(280).nullable().default(null),
  scheduleType: ScheduledAgentScheduleTypeSchema.default("recurring"),
  cron: z.string().min(1).max(120).nullable().default(null),
  runAt: z.string().nullable().default(null),
  repoId: IdSchema,
  runtimeId: IdSchema,
  prompt: z.string().max(8000).nullable().default(null),
  workspaceStrategy: ScheduledAgentWorkspaceStrategySchema,
  workspaceName: z.string().min(1).max(80),
  baseBranch: z.string().min(1).max(120).nullable().default(null),
  runMode: ScheduledAgentRunModeSchema.default("workspace"),
  backgroundCwd: z.string().min(1).max(4000).nullable().default(null),
  overlapPolicy: ScheduledAgentOverlapPolicySchema.default("skip"),
  enabled: z.boolean().default(true),
  lastRunAt: z.string().nullable().default(null),
  lastRunStatus: ScheduledAgentRunStatusSchema.default("never"),
  lastRunMessage: z.string().nullable().default(null),
  lastWorkspaceId: IdSchema.nullable().default(null),
  lastSessionId: IdSchema.nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// One row per fire (cron tick or manual runNow). Lifecycle:
//   queued    → enqueuedAt = fire time, startedAt = null, logFilePath = null
//   running   → startedAt = execution-start time (= enqueuedAt for skip-policy),
//               logFilePath populated, workspace/session ids set per runMode
//   succeeded / failed → endedAt populated, other fields preserved
export const ScheduledAgentRunSchema = z.object({
  id: IdSchema,
  scheduledAgentId: IdSchema,
  status: ScheduledAgentRunRowStatusSchema,
  enqueuedAt: z.string(),
  startedAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  workspaceId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  backgroundSessionId: IdSchema.nullable().default(null),
  logFilePath: z.string().nullable().default(null),
});

// Tmux-backed agent session that is NOT tied to a workspace.
export const BackgroundAgentSessionStatusSchema = z.enum(["running", "stopped", "failed"]);

export const BackgroundAgentSessionSchema = z.object({
  id: IdSchema,
  scheduledAgentId: IdSchema.nullable().default(null),
  cwd: z.string().min(1).max(4000),
  logFilePath: z.string().min(1).max(4000),
  tmuxSessionName: z.string().min(1),
  tmuxSessionId: z.string().min(1),
  status: BackgroundAgentSessionStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

// Recurring needs a cron; one-shot needs a runAt timestamp. The runner stores a
// placeholder cron for one-shots so the DB column can stay NOT NULL.
//
// workspaceStrategy + workspaceName are required for runMode='workspace' (the
// default) and ignored for runMode='background' (still accepted in the input
// so the schema doesn't reject a payload that includes them).
export const CreateScheduledAgentInputSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(280).optional(),
    scheduleType: ScheduledAgentScheduleTypeSchema.optional(),
    cron: z.string().min(1).max(120).optional(),
    runAt: z.string().datetime({ offset: true }).optional(),
    repoId: IdSchema,
    runtimeId: IdSchema,
    prompt: z.string().max(8000).optional(),
    workspaceStrategy: ScheduledAgentWorkspaceStrategySchema.optional(),
    workspaceName: z.string().min(1).max(80).optional(),
    baseBranch: z.string().min(1).max(120).optional(),
    runMode: ScheduledAgentRunModeSchema.optional(),
    backgroundCwd: z.string().min(1).max(4000).optional(),
    overlapPolicy: ScheduledAgentOverlapPolicySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const type = value.scheduleType ?? "recurring";
    const runMode = value.runMode ?? "workspace";
    if (type === "recurring" && !value.cron) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cron is required for recurring schedules",
        path: ["cron"],
      });
    }
    if (type === "once" && !value.runAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runAt is required for one-shot schedules",
        path: ["runAt"],
      });
    }
    if (runMode === "workspace") {
      if (!value.workspaceStrategy) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspaceStrategy is required when runMode='workspace'",
          path: ["workspaceStrategy"],
        });
      }
      if (!value.workspaceName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "workspaceName is required when runMode='workspace'",
          path: ["workspaceName"],
        });
      }
    }
  });

// Partial form for PATCH: build it from the raw object (skip the refinement so a
// PATCH that only touches `enabled` doesn't fail the cron/runAt presence check).
export const UpdateScheduledAgentInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(280).optional(),
  scheduleType: ScheduledAgentScheduleTypeSchema.optional(),
  cron: z.string().min(1).max(120).optional(),
  runAt: z.string().datetime({ offset: true }).optional(),
  repoId: IdSchema.optional(),
  runtimeId: IdSchema.optional(),
  prompt: z.string().max(8000).optional(),
  runMode: ScheduledAgentRunModeSchema.optional(),
  backgroundCwd: z.string().min(1).max(4000).optional(),
  overlapPolicy: ScheduledAgentOverlapPolicySchema.optional(),
  workspaceStrategy: ScheduledAgentWorkspaceStrategySchema.optional(),
  workspaceName: z.string().min(1).max(80).optional(),
  baseBranch: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
});

export type ScheduledAgent = z.infer<typeof ScheduledAgentSchema>;
export type ScheduledAgentWorkspaceStrategy = z.infer<typeof ScheduledAgentWorkspaceStrategySchema>;
export type ScheduledAgentRunStatus = z.infer<typeof ScheduledAgentRunStatusSchema>;
export type ScheduledAgentScheduleType = z.infer<typeof ScheduledAgentScheduleTypeSchema>;
export type ScheduledAgentRunMode = z.infer<typeof ScheduledAgentRunModeSchema>;
export type ScheduledAgentOverlapPolicy = z.infer<typeof ScheduledAgentOverlapPolicySchema>;
export type ScheduledAgentRun = z.infer<typeof ScheduledAgentRunSchema>;
export type BackgroundAgentSession = z.infer<typeof BackgroundAgentSessionSchema>;
export type CreateScheduledAgentInput = z.infer<typeof CreateScheduledAgentInputSchema>;
export type UpdateScheduledAgentInput = z.infer<typeof UpdateScheduledAgentInputSchema>;
