import fs from "node:fs";
import path from "node:path";
import type {
  ActivityEvent,
  AgentSession,
  CreateAgentSessionInput,
  CreateWorkspaceCheckoutInput,
  CreateWorkspaceInput,
  LaunchAgentInput,
  Repo,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { RuntimeLaunchOptionsInput } from "@citadel/runtimes";
import { WorkspaceInUseError } from "./helpers.js";
import type { CreateAgentSessionOperationInput } from "./system-prompt-launch.js";

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
    input: CreateAgentSessionOperationInput,
    runtime: LaunchRuntimeDescriptor,
  ) => Promise<AgentSession>;
  createWorkspaceCheckout: (
    input: CreateWorkspaceCheckoutInput,
  ) => Promise<{ operationId: string; checkoutId: string }>;
  dataDir?: string | undefined;
  activity: (event: {
    type: string;
    source: ActivityEvent["source"];
    message: string;
    repoId: string | null;
    workspaceId: string | null;
    operationId: string | null;
  }) => void;
};

type LaunchRuntimeDescriptor = {
  command: string;
  args: string[];
  displayName: string;
  promptArg?: string | null;
  sessionIdArg?: string | null;
  resumeArg?: string | null;
  launchOptions?: RuntimeLaunchOptionsInput;
};

// One-shot bundle: resolve repo, create workspace, start agent session.
// The granular createWorkspace + createAgentSession paths still exist for
// callers that need them — this is the high-level convenience used by MCP
// orchestrators that previously had to chain three+ calls (and poll the
// workspace operation) just to get an agent running in a fresh worktree.
export async function launchAgent(
  deps: LaunchAgentDeps,
  input: LaunchAgentInput,
  runtime: LaunchRuntimeDescriptor,
): Promise<LaunchAgentResult> {
  const repo = resolveRepo(deps.store, input);
  const workspaceName = input.workspaceName ?? `agent-${createId("ws").slice(-8)}`;
  const branchOverride = input.branchName?.trim();
  const branchName =
    !branchOverride || branchOverride === repo.defaultBranch ? deriveAgentBranchName(workspaceName) : branchOverride;
  // Idempotent resume: if a ready workspace with this name already exists,
  // skip creation and either return its running session or start a new one.
  const existing = findActiveStructuredHomeByName(deps.store, workspaceName);
  if (existing) {
    if (existing.lifecycle !== "ready") {
      throw new WorkspaceInUseError(existing.id, existing.lifecycle);
    }
    const checkout = await ensureLaunchCheckout(deps, existing, repo, workspaceName, branchName, branchOverride);
    const running = deps.store
      .listSessions(existing.id)
      .find((s) => s.status === "running" && s.checkoutId === checkout.id);
    if (running) {
      return {
        workspaceId: existing.id,
        sessionId: running.id,
        branchName: checkout.branch,
        workspacePath: checkout.path,
        operationId: createId("op"),
        resumed: true,
      };
    }
    const sessionInput: CreateAgentSessionInput = {
      workspaceId: existing.id,
      runtimeId: input.runtimeId,
      displayName: input.displayName ?? deriveAgentDisplayName(input.prompt),
      prompt: input.prompt,
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      targetType: "worktree_checkout",
      checkoutId: checkout.id,
    };
    try {
      const session = await deps.createAgentSession(sessionInput, runtime);
      return {
        workspaceId: existing.id,
        sessionId: session.id,
        branchName: checkout.branch,
        workspacePath: checkout.path,
        operationId: createId("op"),
        resumed: true,
      };
    } catch (error) {
      return {
        workspaceId: existing.id,
        sessionId: null,
        branchName: checkout.branch,
        workspacePath: checkout.path,
        operationId: createId("op"),
        resumed: true,
        error: error instanceof Error ? error.message : "agent_session_start_failed",
      };
    }
  }
  const workspaceInput: CreateWorkspaceInput = {
    mode: "structured",
    rootPath: uniqueStructuredWorkspaceRoot(deps, workspaceName),
    name: workspaceName,
    source: "scratch",
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
  const checkout = await ensureLaunchCheckout(deps, created, repo, workspaceName, branchName, branchOverride);
  const sessionInput: CreateAgentSessionInput = {
    workspaceId,
    runtimeId: input.runtimeId,
    displayName: input.displayName ?? deriveAgentDisplayName(input.prompt),
    prompt: input.prompt,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    targetType: "worktree_checkout",
    checkoutId: checkout.id,
    ...(input.namespaceId ? { namespaceId: input.namespaceId } : {}),
  };
  try {
    const session = await deps.createAgentSession(sessionInput, runtime);
    return {
      workspaceId,
      sessionId: session.id,
      branchName: checkout.branch,
      workspacePath: checkout.path,
      operationId,
    };
  } catch (error) {
    return {
      workspaceId,
      sessionId: null,
      branchName: checkout.branch,
      workspacePath: checkout.path,
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

function findActiveStructuredHomeByName(store: SqliteStore, name: string): Workspace | undefined {
  return store
    .listWorkspaces()
    .find(
      (candidate) =>
        candidate.name === name &&
        candidate.kind === "root" &&
        candidate.mode === "structured" &&
        !candidate.archivedAt,
    );
}

async function ensureLaunchCheckout(
  deps: LaunchAgentDeps,
  workspace: Workspace,
  repo: Repo,
  workspaceName: string,
  branchName: string,
  branchOverride: string | undefined,
): Promise<WorktreeCheckout> {
  const repoCheckouts = deps.store
    .listWorkspaceCheckouts(workspace.id)
    .filter((checkout) => checkout.repoId === repo.id && !checkout.archivedAt);
  const existing = repoCheckouts.find((checkout) => checkout.branch === branchName);
  if (existing) return existing;
  if (!branchOverride || branchOverride === repo.defaultBranch) {
    const defaultLaunchCheckout = repoCheckouts[0];
    if (defaultLaunchCheckout) return defaultLaunchCheckout;
  }

  const checkoutName = uniqueCheckoutName(deps.store, workspace, repo.name || workspaceName);
  const source = branchOverride && branchOverride !== repo.defaultBranch ? "existing_branch" : "default_branch";
  const { checkoutId } = await deps.createWorkspaceCheckout({
    workspaceId: workspace.id,
    repoId: repo.id,
    name: checkoutName,
    branch: branchName,
    source,
  });
  const checkout = deps.store.findWorkspaceCheckout(checkoutId);
  if (!checkout) throw new Error(`checkout_create_missing: ${checkoutId}`);
  return checkout;
}

function uniqueCheckoutName(store: SqliteStore, workspace: Workspace, rawName: string): string {
  const existingNames = new Set(store.listWorkspaceCheckouts(workspace.id).map((checkout) => checkout.name));
  const rootPath = workspace.rootPath ?? workspace.path;
  const base = slug(rawName);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!existingNames.has(candidate) && !fs.existsSync(path.join(rootPath, candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function uniqueStructuredWorkspaceRoot(deps: LaunchAgentDeps, name: string): string {
  const dataDir = deps.dataDir ?? path.dirname(path.resolve(deps.store.databasePath));
  const parent = path.join(dataDir, "structured-workspaces");
  const base = slug(name);
  const existingPaths = new Set(
    deps.store.listWorkspaces().map((workspace) => path.resolve(workspace.rootPath ?? workspace.path)),
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = path.join(parent, attempt === 0 ? base : `${base}-${attempt + 1}`);
    if (!fs.existsSync(candidate) && !existingPaths.has(path.resolve(candidate))) return candidate;
  }
  return path.join(parent, `${base}-${Date.now().toString(36)}`);
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

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `workspace-${Date.now().toString(36)}`;
}
