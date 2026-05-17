import type { z } from "zod";
export declare const IdSchema: z.ZodString;
export declare const ProviderStatusSchema: z.ZodEnum<["healthy", "degraded", "unavailable", "unknown"]>;
export declare const WorkspaceLifecycleSchema: z.ZodEnum<
  ["creating", "ready", "failed", "removing", "archived", "removed"]
>;
export declare const WorkspaceSourceSchema: z.ZodEnum<["scratch", "pr", "issue", "imported"]>;
export declare const AgentSessionStatusSchema: z.ZodEnum<
  ["starting", "running", "waiting", "idle", "failed", "stopped", "orphaned"]
>;
export declare const TransportStatusSchema: z.ZodEnum<["disconnected", "connecting", "connected", "degraded"]>;
export declare const OperationStatusSchema: z.ZodEnum<["queued", "running", "succeeded", "failed", "cancelled"]>;
export declare const RepoSchema: z.ZodObject<
  {
    id: z.ZodString;
    name: z.ZodString;
    rootPath: z.ZodString;
    defaultBranch: z.ZodDefault<z.ZodString>;
    defaultRemote: z.ZodDefault<z.ZodString>;
    worktreeParent: z.ZodString;
    setupHookIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    teardownHookIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    providerIds: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    archivedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    name: string;
    rootPath: string;
    defaultBranch: string;
    defaultRemote: string;
    worktreeParent: string;
    setupHookIds: string[];
    teardownHookIds: string[];
    providerIds: string[];
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  },
  {
    id: string;
    name: string;
    rootPath: string;
    worktreeParent: string;
    createdAt: string;
    updatedAt: string;
    defaultBranch?: string | undefined;
    defaultRemote?: string | undefined;
    setupHookIds?: string[] | undefined;
    teardownHookIds?: string[] | undefined;
    providerIds?: string[] | undefined;
    archivedAt?: string | null | undefined;
  }
>;
export declare const WorkspaceSchema: z.ZodObject<
  {
    id: z.ZodString;
    repoId: z.ZodString;
    name: z.ZodString;
    path: z.ZodString;
    branch: z.ZodString;
    baseBranch: z.ZodString;
    source: z.ZodEnum<["scratch", "pr", "issue", "imported"]>;
    prUrl: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    issueKey: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    issueTitle: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    section: z.ZodDefault<z.ZodString>;
    pinned: z.ZodDefault<z.ZodBoolean>;
    lifecycle: z.ZodEnum<["creating", "ready", "failed", "removing", "archived", "removed"]>;
    dirty: z.ZodDefault<z.ZodBoolean>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
    archivedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    name: string;
    dirty: boolean;
    path: string;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
    repoId: string;
    branch: string;
    baseBranch: string;
    source: "scratch" | "pr" | "issue" | "imported";
    prUrl: string | null;
    issueKey: string | null;
    issueTitle: string | null;
    section: string;
    pinned: boolean;
    lifecycle: "creating" | "ready" | "failed" | "removing" | "archived" | "removed";
  },
  {
    id: string;
    name: string;
    path: string;
    createdAt: string;
    updatedAt: string;
    repoId: string;
    branch: string;
    baseBranch: string;
    source: "scratch" | "pr" | "issue" | "imported";
    lifecycle: "creating" | "ready" | "failed" | "removing" | "archived" | "removed";
    dirty?: boolean | undefined;
    archivedAt?: string | null | undefined;
    prUrl?: string | null | undefined;
    issueKey?: string | null | undefined;
    issueTitle?: string | null | undefined;
    section?: string | undefined;
    pinned?: boolean | undefined;
  }
>;
export declare const RuntimeCapabilitySchema: z.ZodObject<
  {
    supportsPrompt: z.ZodBoolean;
    supportsResume: z.ZodBoolean;
    supportsModelSelection: z.ZodBoolean;
    supportsTranscript: z.ZodBoolean;
    supportsStatusDetection: z.ZodBoolean;
    supportsNonInteractiveGoal: z.ZodBoolean;
    supportsShell: z.ZodBoolean;
    supportsUsage: z.ZodBoolean;
  },
  "strip",
  z.ZodTypeAny,
  {
    supportsPrompt: boolean;
    supportsResume: boolean;
    supportsModelSelection: boolean;
    supportsTranscript: boolean;
    supportsStatusDetection: boolean;
    supportsNonInteractiveGoal: boolean;
    supportsShell: boolean;
    supportsUsage: boolean;
  },
  {
    supportsPrompt: boolean;
    supportsResume: boolean;
    supportsModelSelection: boolean;
    supportsTranscript: boolean;
    supportsStatusDetection: boolean;
    supportsNonInteractiveGoal: boolean;
    supportsShell: boolean;
    supportsUsage: boolean;
  }
>;
export declare const AgentRuntimeSchema: z.ZodObject<
  {
    id: z.ZodString;
    displayName: z.ZodString;
    command: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    health: z.ZodEnum<["healthy", "degraded", "unavailable", "unknown"]>;
    healthReason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    capabilities: z.ZodObject<
      {
        supportsPrompt: z.ZodBoolean;
        supportsResume: z.ZodBoolean;
        supportsModelSelection: z.ZodBoolean;
        supportsTranscript: z.ZodBoolean;
        supportsStatusDetection: z.ZodBoolean;
        supportsNonInteractiveGoal: z.ZodBoolean;
        supportsShell: z.ZodBoolean;
        supportsUsage: z.ZodBoolean;
      },
      "strip",
      z.ZodTypeAny,
      {
        supportsPrompt: boolean;
        supportsResume: boolean;
        supportsModelSelection: boolean;
        supportsTranscript: boolean;
        supportsStatusDetection: boolean;
        supportsNonInteractiveGoal: boolean;
        supportsShell: boolean;
        supportsUsage: boolean;
      },
      {
        supportsPrompt: boolean;
        supportsResume: boolean;
        supportsModelSelection: boolean;
        supportsTranscript: boolean;
        supportsStatusDetection: boolean;
        supportsNonInteractiveGoal: boolean;
        supportsShell: boolean;
        supportsUsage: boolean;
      }
    >;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    displayName: string;
    command: string;
    args: string[];
    health: "healthy" | "degraded" | "unavailable" | "unknown";
    healthReason: string | null;
    capabilities: {
      supportsPrompt: boolean;
      supportsResume: boolean;
      supportsModelSelection: boolean;
      supportsTranscript: boolean;
      supportsStatusDetection: boolean;
      supportsNonInteractiveGoal: boolean;
      supportsShell: boolean;
      supportsUsage: boolean;
    };
  },
  {
    id: string;
    displayName: string;
    command: string;
    health: "healthy" | "degraded" | "unavailable" | "unknown";
    capabilities: {
      supportsPrompt: boolean;
      supportsResume: boolean;
      supportsModelSelection: boolean;
      supportsTranscript: boolean;
      supportsStatusDetection: boolean;
      supportsNonInteractiveGoal: boolean;
      supportsShell: boolean;
      supportsUsage: boolean;
    };
    args?: string[] | undefined;
    healthReason?: string | null | undefined;
  }
>;
export declare const AgentSessionSchema: z.ZodObject<
  {
    id: z.ZodString;
    workspaceId: z.ZodString;
    runtimeId: z.ZodString;
    displayName: z.ZodString;
    status: z.ZodEnum<["starting", "running", "waiting", "idle", "failed", "stopped", "orphaned"]>;
    transport: z.ZodEnum<["disconnected", "connecting", "connected", "degraded"]>;
    tmuxSessionName: z.ZodNullable<z.ZodString>;
    tmuxSessionId: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    status: "failed" | "starting" | "running" | "waiting" | "idle" | "stopped" | "orphaned";
    createdAt: string;
    updatedAt: string;
    displayName: string;
    workspaceId: string;
    runtimeId: string;
    transport: "degraded" | "disconnected" | "connecting" | "connected";
    tmuxSessionName: string | null;
    tmuxSessionId: string | null;
  },
  {
    id: string;
    status: "failed" | "starting" | "running" | "waiting" | "idle" | "stopped" | "orphaned";
    createdAt: string;
    updatedAt: string;
    displayName: string;
    workspaceId: string;
    runtimeId: string;
    transport: "degraded" | "disconnected" | "connecting" | "connected";
    tmuxSessionName: string | null;
    tmuxSessionId: string | null;
  }
>;
export declare const ProviderHealthSchema: z.ZodObject<
  {
    id: z.ZodString;
    kind: z.ZodEnum<["version-control", "pull-request", "ci", "issue-tracker", "usage", "notification"]>;
    displayName: z.ZodString;
    status: z.ZodEnum<["healthy", "degraded", "unavailable", "unknown"]>;
    reason: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    checkedAt: z.ZodString;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    status: "healthy" | "degraded" | "unavailable" | "unknown";
    displayName: string;
    kind: "version-control" | "pull-request" | "ci" | "issue-tracker" | "usage" | "notification";
    reason: string | null;
    checkedAt: string;
  },
  {
    id: string;
    status: "healthy" | "degraded" | "unavailable" | "unknown";
    displayName: string;
    kind: "version-control" | "pull-request" | "ci" | "issue-tracker" | "usage" | "notification";
    checkedAt: string;
    reason?: string | null | undefined;
  }
>;
export declare const OperationSchema: z.ZodObject<
  {
    id: z.ZodString;
    type: z.ZodString;
    status: z.ZodEnum<["queued", "running", "succeeded", "failed", "cancelled"]>;
    repoId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    workspaceId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    progress: z.ZodNumber;
    message: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    error: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    message: string | null;
    type: string;
    status: "failed" | "running" | "queued" | "succeeded" | "cancelled";
    createdAt: string;
    updatedAt: string;
    repoId: string | null;
    workspaceId: string | null;
    progress: number;
    error: string | null;
  },
  {
    id: string;
    type: string;
    status: "failed" | "running" | "queued" | "succeeded" | "cancelled";
    createdAt: string;
    updatedAt: string;
    progress: number;
    message?: string | null | undefined;
    repoId?: string | null | undefined;
    workspaceId?: string | null | undefined;
    error?: string | null | undefined;
  }
>;
export declare const ActivityEventSchema: z.ZodObject<
  {
    id: z.ZodString;
    type: z.ZodString;
    source: z.ZodEnum<["user", "system", "mcp", "hook", "provider", "agent", "automatic-rule", "cli"]>;
    repoId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    workspaceId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    operationId: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    message: z.ZodString;
    createdAt: z.ZodString;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    message: string;
    type: string;
    createdAt: string;
    repoId: string | null;
    source: "user" | "system" | "mcp" | "hook" | "provider" | "agent" | "automatic-rule" | "cli";
    workspaceId: string | null;
    operationId: string | null;
  },
  {
    id: string;
    message: string;
    type: string;
    createdAt: string;
    source: "user" | "system" | "mcp" | "hook" | "provider" | "agent" | "automatic-rule" | "cli";
    repoId?: string | null | undefined;
    workspaceId?: string | null | undefined;
    operationId?: string | null | undefined;
  }
>;
export declare const AppEventSchema: z.ZodObject<
  {
    id: z.ZodString;
    type: z.ZodString;
    timestamp: z.ZodString;
    source: z.ZodString;
    repoId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    workspaceId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    operationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    payload: z.ZodUnknown;
  },
  "strip",
  z.ZodTypeAny,
  {
    id: string;
    type: string;
    source: string;
    timestamp: string;
    repoId?: string | null | undefined;
    workspaceId?: string | null | undefined;
    operationId?: string | null | undefined;
    payload?: unknown;
  },
  {
    id: string;
    type: string;
    source: string;
    timestamp: string;
    repoId?: string | null | undefined;
    workspaceId?: string | null | undefined;
    operationId?: string | null | undefined;
    payload?: unknown;
  }
>;
export declare const CreateRepoInputSchema: z.ZodObject<
  {
    rootPath: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    worktreeParent: z.ZodOptional<z.ZodString>;
  },
  "strip",
  z.ZodTypeAny,
  {
    rootPath: string;
    name?: string | undefined;
    worktreeParent?: string | undefined;
  },
  {
    rootPath: string;
    name?: string | undefined;
    worktreeParent?: string | undefined;
  }
>;
export declare const CreateWorkspaceInputSchema: z.ZodObject<
  {
    repoId: z.ZodString;
    name: z.ZodString;
    source: z.ZodDefault<z.ZodEnum<["scratch", "pr", "issue", "imported"]>>;
    issueKey: z.ZodOptional<z.ZodString>;
    issueTitle: z.ZodOptional<z.ZodString>;
    prUrl: z.ZodOptional<z.ZodString>;
  },
  "strip",
  z.ZodTypeAny,
  {
    name: string;
    repoId: string;
    source: "scratch" | "pr" | "issue" | "imported";
    prUrl?: string | undefined;
    issueKey?: string | undefined;
    issueTitle?: string | undefined;
  },
  {
    name: string;
    repoId: string;
    source?: "scratch" | "pr" | "issue" | "imported" | undefined;
    prUrl?: string | undefined;
    issueKey?: string | undefined;
    issueTitle?: string | undefined;
  }
>;
export declare const CreateAgentSessionInputSchema: z.ZodObject<
  {
    workspaceId: z.ZodString;
    runtimeId: z.ZodString;
    displayName: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
  },
  "strip",
  z.ZodTypeAny,
  {
    workspaceId: string;
    runtimeId: string;
    displayName?: string | undefined;
    prompt?: string | undefined;
  },
  {
    workspaceId: string;
    runtimeId: string;
    displayName?: string | undefined;
    prompt?: string | undefined;
  }
>;
export type Repo = z.infer<typeof RepoSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;
export type Operation = z.infer<typeof OperationSchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;
export type AppEvent = z.infer<typeof AppEventSchema>;
export type CreateRepoInput = z.infer<typeof CreateRepoInputSchema>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>;
export type CreateAgentSessionInput = z.infer<typeof CreateAgentSessionInputSchema>;
export type ApiError = {
  error: string;
  detail?: string;
  fieldErrors?: Record<string, string[]>;
};
//# sourceMappingURL=index.d.ts.map
