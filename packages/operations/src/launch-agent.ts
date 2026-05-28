import type {
  ActivityEvent,
  AgentSession,
  CreateAgentSessionInput,
  CreateWorkspaceInput,
  LaunchAgentInput,
  Repo,
  Workspace,
} from "@citadel/contracts";
import { createId } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { WorkspaceInUseError } from "./helpers.js";

export type LaunchAgentResult = {
  workspaceId: string;
  sessionId: string | null;
  branchName: string;
  workspacePath: string;
  operationId: string;
  error?: string;
  resumed?: boolean;
};

export type LaunchAgentDeps = {
  store: SqliteStore;
  createWorkspace: (input: CreateWorkspaceInput) => Promise<{ operationId: string; workspaceId: string }>;
  createAgentSession: (
    input: CreateAgentSessionInput,
    runtime: {
      command: string;
      args: string[];
      displayName: string;
      promptArg?: string | null;
      sessionIdArg?: string | null;
      resumeArg?: string | null;
    },
  ) => Promise<AgentSession>;
  activity: (event: {
    type: string;
    source: ActivityEvent["source"];
    message: string;
    repoId: string | null;
    workspaceId: string | null;
    operationId: string | null;
  }) => void;
};

// One-shot bundle: resolve repo, create workspace, start agent session.
// The granular createWorkspace + createAgentSession paths still exist for
// callers that need them — this is the high-level convenience used by MCP
// orchestrators that previously had to chain three+ calls (and poll the
// workspace operation) just to get an agent running in a fresh worktree.
export async function launchAgent(
  deps: LaunchAgentDeps,
  input: LaunchAgentInput,
  runtime: { command: string; args: string[]; displayName: string; promptArg?: string | null },
): Promise<LaunchAgentResult> {
  const repo = resolveRepo(deps.store, input);
  const workspaceName = input.workspaceName ?? `agent-${createId("ws").slice(-8)}`;
  const branchOverride = input.branchName?.trim();
  // Idempotent resume: if a ready workspace with this name already exists,
  // skip creation and either return its running session or start a new one.
  const existing = findActiveWorkspaceByName(deps.store, repo.id, workspaceName);
  if (existing) {
    if (existing.lifecycle !== "ready") {
      throw new WorkspaceInUseError(existing.id, existing.lifecycle);
    }
    const running = deps.store.listSessions(existing.id).find((s) => s.status === "running");
    if (running) {
      return {
        workspaceId: existing.id,
        sessionId: running.id,
        branchName: existing.branch,
        workspacePath: existing.path,
        operationId: createId("op"),
        resumed: true,
      };
    }
    const sessionInput: CreateAgentSessionInput = {
      workspaceId: existing.id,
      runtimeId: input.runtimeId,
      displayName: input.displayName ?? deriveAgentDisplayName(input.prompt),
      prompt: input.prompt,
    };
    try {
      const session = await deps.createAgentSession(sessionInput, runtime);
      return {
        workspaceId: existing.id,
        sessionId: session.id,
        branchName: existing.branch,
        workspacePath: existing.path,
        operationId: createId("op"),
        resumed: true,
      };
    } catch (error) {
      return {
        workspaceId: existing.id,
        sessionId: null,
        branchName: existing.branch,
        workspacePath: existing.path,
        operationId: createId("op"),
        resumed: true,
        error: error instanceof Error ? error.message : "agent_session_start_failed",
      };
    }
  }
  // No explicit override (or caller passed default branch): derive a unique
  // new branch so we don't collide with the primary worktree's checkout.
  const isDefaultBranch = !branchOverride || branchOverride === repo.defaultBranch;
  const workspaceInput: CreateWorkspaceInput = {
    repoId: repo.id,
    name: workspaceName,
    source: "scratch",
    ...(isDefaultBranch ? { newBranch: deriveAgentBranchName(workspaceName) } : { existingBranch: branchOverride }),
    ...(input.namespaceId ? { namespaceId: input.namespaceId } : {}),
  };
  const { operationId, workspaceId } = await deps.createWorkspace(workspaceInput);
  const created = findWorkspace(deps.store, workspaceId);
  if (!created || created.lifecycle !== "ready") {
    const failedOp = deps.store.findOperation(operationId);
    return {
      workspaceId,
      sessionId: null,
      branchName: created?.branch ?? branchOverride ?? "",
      workspacePath: created?.path ?? "",
      operationId,
      error: failedOp?.error ?? "workspace_create_failed",
    };
  }
  const sessionInput: CreateAgentSessionInput = {
    workspaceId,
    runtimeId: input.runtimeId,
    displayName: input.displayName ?? deriveAgentDisplayName(input.prompt),
    prompt: input.prompt,
    ...(input.namespaceId ? { namespaceId: input.namespaceId } : {}),
  };
  try {
    const session = await deps.createAgentSession(sessionInput, runtime);
    return {
      workspaceId,
      sessionId: session.id,
      branchName: created.branch,
      workspacePath: created.path,
      operationId,
    };
  } catch (error) {
    return {
      workspaceId,
      sessionId: null,
      branchName: created.branch,
      workspacePath: created.path,
      operationId,
      error: error instanceof Error ? error.message : "agent_session_start_failed",
    };
  }
}

function resolveRepo(store: SqliteStore, input: LaunchAgentInput): Repo {
  const repos = store.listRepos().filter((candidate) => !candidate.archivedAt);
  const repo = input.repoId
    ? repos.find((candidate) => candidate.id === input.repoId)
    : repos.find((candidate) => candidate.name === input.repoName);
  if (!repo) {
    throw new Error(input.repoId ? `Unknown repo: ${input.repoId}` : `Unknown repo by name: ${input.repoName ?? ""}`);
  }
  return repo;
}

function findWorkspace(store: SqliteStore, workspaceId: string): Workspace | undefined {
  return store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
}

function findActiveWorkspaceByName(store: SqliteStore, repoId: string, name: string): Workspace | undefined {
  return store
    .listWorkspaces(repoId)
    .find((candidate) => candidate.name === name && candidate.kind !== "root" && !candidate.archivedAt);
}

function deriveAgentBranchName(workspaceName: string) {
  const slug =
    workspaceName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "agent";
  const suffix = createId("ws").slice(-6);
  return `agent/${slug}-${suffix}`;
}

function deriveAgentDisplayName(prompt: string) {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "Agent";
  return firstLine.length <= 40 ? firstLine : `${firstLine.slice(0, 37)}...`;
}
