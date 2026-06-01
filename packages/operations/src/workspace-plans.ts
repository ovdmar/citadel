import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActivityEvent,
  ExecutionTarget,
  PlanDeviationReport,
  RegisterWorkspacePlanInput,
  Workspace,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { resolveExecutionTargetForCwd, workspaceRootPath } from "./workspace-layout.js";

export type WorkspacePlanDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
};

export type WorkspaceScope =
  | { ok: true; workspace: Workspace; checkout: WorktreeCheckout | null; cwd: string | null }
  | { ok: false; error: "workspace_required" | "workspace_not_found" | "cwd_not_registered"; workspaceId?: string };

export type RegisterWorkspacePlanResult =
  | { ok: true; planVersion: WorkspacePlanVersion }
  | {
      ok: false;
      error:
        | "workspace_required"
        | "workspace_not_found"
        | "cwd_not_registered"
        | "plan_path_outside_workspace"
        | "plan_path_missing";
      detail?: string;
    };

export type WorkspacePlanSnapshot =
  | {
      ok: true;
      workspace: Workspace;
      activePlan: WorkspacePlanVersion | null;
      planVersions: WorkspacePlanVersion[];
      deviations: PlanDeviationReport[];
    }
  | { ok: false; error: "workspace_required" | "workspace_not_found" | "cwd_not_registered" };

export type CitadelContextResult =
  | {
      ok: true;
      target: ExecutionTarget;
      workspace: Workspace;
      checkout: WorktreeCheckout | null;
      checkouts: WorktreeCheckout[];
      activePlan: WorkspacePlanVersion | null;
      manager: ReturnType<SqliteStore["getWorkspaceManager"]>;
      deviations: PlanDeviationReport[];
    }
  | { ok: false; error: "workspace_not_found" | "outside_registered_workspace"; cwd: string };

export type ReportPlanDeviationResult =
  | { ok: true; deviation: PlanDeviationReport }
  | { ok: false; error: "workspace_required" | "workspace_not_found" | "cwd_not_registered" | "plan_required" };

export function registerWorkspacePlan(
  deps: WorkspacePlanDeps,
  input: RegisterWorkspacePlanInput,
): RegisterWorkspacePlanResult {
  const scope = resolveWorkspaceScope(deps.store, input);
  if (!scope.ok) return mapScopeError(scope);
  const resolvedPlan = resolvePlanPath(scope.workspace, input.path);
  if (!resolvedPlan.ok) return resolvedPlan;
  const content = fs.readFileSync(resolvedPlan.path);
  const now = nowIso();
  const existing = deps.store.listWorkspacePlanVersions(scope.workspace.id);
  const planVersion: WorkspacePlanVersion = {
    id: createId("plan"),
    workspaceId: scope.workspace.id,
    version: Math.max(0, ...existing.map((plan) => plan.version)) + 1,
    status: input.status,
    path: resolvedPlan.path,
    hash: createHash("sha256").update(content).digest("hex"),
    active: input.status === "approved",
    approvalMode: input.approvalMode,
    createdBySessionId: input.createdBySessionId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  deps.store.insertWorkspacePlanVersion(planVersion);
  if (planVersion.status === "approved") {
    deps.store.insertWorkspacePlanDecision({
      id: createId("decision"),
      planVersionId: planVersion.id,
      decision: "approve",
      reason: "Registered as approved plan",
      actor: "human",
      createdAt: now,
    });
  }
  deps.activity(
    "workspace.plan.registered",
    input.createdBySessionId ? "agent" : "mcp",
    `Registered workspace plan v${planVersion.version}`,
    scope.workspace.repoId,
    scope.workspace.id,
    null,
  );
  return { ok: true, planVersion };
}

export function getWorkspacePlan(
  deps: Pick<WorkspacePlanDeps, "store">,
  input: { workspaceId?: string | undefined; cwd?: string | undefined },
) {
  const scope = resolveWorkspaceScope(deps.store, input);
  if (!scope.ok) return { ok: false, error: scope.error } satisfies WorkspacePlanSnapshot;
  return {
    ok: true,
    workspace: scope.workspace,
    activePlan: deps.store.findActiveWorkspacePlan(scope.workspace.id),
    planVersions: deps.store.listWorkspacePlanVersions(scope.workspace.id),
    deviations: deps.store.listPlanDeviationReports(scope.workspace.id),
  } satisfies WorkspacePlanSnapshot;
}

export function getCitadelContext(
  deps: Pick<WorkspacePlanDeps, "store">,
  input: { cwd: string },
): CitadelContextResult {
  const workspaces = deps.store.listWorkspaces();
  const checkouts = listAllCheckouts(deps.store, workspaces);
  const target = resolveExecutionTargetForCwd({ cwd: input.cwd, workspaces, checkouts });
  if (!target.ok) return { ok: false, error: target.error, cwd: path.resolve(input.cwd) };
  const resolvedTarget = target.target;
  const workspace = workspaces.find((candidate) => candidate.id === resolvedTarget.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found", cwd: path.resolve(input.cwd) };
  const checkout =
    resolvedTarget.type === "worktree_checkout"
      ? (checkouts.find((candidate) => candidate.id === resolvedTarget.checkoutId) ?? null)
      : null;
  return {
    ok: true,
    target: resolvedTarget,
    workspace,
    checkout,
    checkouts: checkouts.filter((candidate) => candidate.workspaceId === workspace.id),
    activePlan: deps.store.findActiveWorkspacePlan(workspace.id),
    manager: deps.store.getWorkspaceManager(workspace.id),
    deviations: deps.store.listPlanDeviationReports(workspace.id),
  };
}

export function reportPlanDeviation(
  deps: WorkspacePlanDeps,
  input: {
    workspaceId?: string | undefined;
    checkoutId?: string | undefined;
    cwd?: string | undefined;
    planVersionId?: string | undefined;
    severity?: PlanDeviationReport["severity"] | undefined;
    description: string;
    reportedBySessionId?: string | undefined;
  },
): ReportPlanDeviationResult {
  const scope = resolveWorkspaceScope(deps.store, input);
  if (!scope.ok) return { ok: false, error: scope.error };
  const activePlan = input.planVersionId
    ? deps.store.listWorkspacePlanVersions(scope.workspace.id).find((plan) => plan.id === input.planVersionId)
    : deps.store.findActiveWorkspacePlan(scope.workspace.id);
  if (!activePlan) return { ok: false, error: "plan_required" };
  const checkoutId = input.checkoutId ?? scope.checkout?.id ?? null;
  const now = nowIso();
  const deviation: PlanDeviationReport = {
    id: createId("dev"),
    workspaceId: scope.workspace.id,
    checkoutId,
    planVersionId: activePlan.id,
    severity: input.severity ?? "blocking",
    description: input.description,
    status: "open",
    reportedBySessionId: input.reportedBySessionId ?? null,
    createdAt: now,
    resolvedAt: null,
  };
  deps.store.insertPlanDeviationReport(deviation);
  deps.activity(
    "workspace.plan.deviation_reported",
    input.reportedBySessionId ? "agent" : "mcp",
    `Plan deviation reported: ${input.description.slice(0, 120)}`,
    scope.workspace.repoId,
    scope.workspace.id,
    null,
  );
  return { ok: true, deviation };
}

export function resolveWorkspaceScope(
  store: SqliteStore,
  input: { workspaceId?: string | undefined; cwd?: string | undefined },
): WorkspaceScope {
  const workspaces = store.listWorkspaces();
  if (input.workspaceId) {
    const workspace = workspaces.find((candidate) => candidate.id === input.workspaceId);
    return workspace
      ? { ok: true, workspace, checkout: null, cwd: null }
      : { ok: false, error: "workspace_not_found", workspaceId: input.workspaceId };
  }
  if (!input.cwd) return { ok: false, error: "workspace_required" };
  const checkouts = listAllCheckouts(store, workspaces);
  const target = resolveExecutionTargetForCwd({ cwd: input.cwd, workspaces, checkouts });
  if (!target.ok) return { ok: false, error: "cwd_not_registered" };
  const resolvedTarget = target.target;
  const workspace = workspaces.find((candidate) => candidate.id === resolvedTarget.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found", workspaceId: resolvedTarget.workspaceId };
  const checkout =
    resolvedTarget.type === "worktree_checkout"
      ? (checkouts.find((candidate) => candidate.id === resolvedTarget.checkoutId) ?? null)
      : null;
  return { ok: true, workspace, checkout, cwd: resolvedTarget.cwd };
}

function resolvePlanPath(
  workspace: Workspace,
  planPath: string,
):
  | { ok: true; path: string }
  | { ok: false; error: "plan_path_outside_workspace" | "plan_path_missing"; detail?: string } {
  const root = realpathIfExists(workspaceRootPath(workspace));
  const absolute = path.resolve(planPath);
  if (!fs.existsSync(absolute)) return { ok: false, error: "plan_path_missing", detail: absolute };
  const resolved = realpathIfExists(absolute);
  if (!containsPath(root, resolved)) return { ok: false, error: "plan_path_outside_workspace", detail: resolved };
  return { ok: true, path: resolved };
}

function listAllCheckouts(store: SqliteStore, workspaces: Workspace[]): WorktreeCheckout[] {
  return workspaces.flatMap((workspace) => store.listWorkspaceCheckouts(workspace.id));
}

function realpathIfExists(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function containsPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function mapScopeError(
  scope: Exclude<WorkspaceScope, { ok: true }>,
): Extract<RegisterWorkspacePlanResult, { ok: false }> {
  if (scope.error === "cwd_not_registered") return { ok: false, error: "cwd_not_registered" };
  if (scope.error === "workspace_not_found") return { ok: false, error: "workspace_not_found" };
  return { ok: false, error: "workspace_required" };
}
