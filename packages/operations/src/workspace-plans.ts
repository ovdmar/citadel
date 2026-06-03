import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActivityEvent,
  ExecutionTarget,
  PlanDeviationReport,
  RegisterWorkspacePlanInput,
  Repo,
  Workspace,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDeliveryUnitsBlock,
  WorkspacePlanDependencyEdge,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import {
  type PlanDeliveryUnitsValidationIssue,
  materializePlanDeliveryUnits,
  parsePlanDeliveryUnitsBlock,
} from "./plan-delivery-units.js";
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

export type TrustedToolActor = "human" | "manager" | "agent" | "mcp" | "system";

export type WorkspaceScope =
  | { ok: true; workspace: Workspace; checkout: WorktreeCheckout | null; cwd: string | null }
  | { ok: false; error: "workspace_required" | "workspace_not_found" | "cwd_not_registered"; workspaceId?: string };

export type RegisterWorkspacePlanResult =
  | {
      ok: true;
      planVersion: WorkspacePlanVersion;
      deliveryUnits: WorkspacePlanDeliveryUnit[];
      dependencyEdges: WorkspacePlanDependencyEdge[];
    }
  | {
      ok: false;
      error:
        | "workspace_required"
        | "workspace_not_found"
        | "cwd_not_registered"
        | "plan_path_outside_workspace"
        | "plan_path_missing"
        | "plan_structure_invalid"
        | "plan_approval_required"
        | "plan_delivery_units_required"
        | "plan_delivery_units_invalid";
      detail?: string;
    };

export type WorkspacePlanSnapshot =
  | {
      ok: true;
      workspace: Workspace;
      activePlan: WorkspacePlanVersion | null;
      planVersions: WorkspacePlanVersion[];
      deliveryUnits: WorkspacePlanDeliveryUnit[];
      dependencyEdges: WorkspacePlanDependencyEdge[];
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
      deliveryUnits: WorkspacePlanDeliveryUnit[];
      dependencyEdges: WorkspacePlanDependencyEdge[];
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
  options: { actor?: TrustedToolActor } = {},
): RegisterWorkspacePlanResult {
  const actor = options.actor ?? "human";
  const scope = resolveWorkspaceScope(deps.store, input);
  if (!scope.ok) return mapScopeError(scope);
  const resolvedPlan = resolvePlanPath(scope.workspace, input.path, scope.cwd);
  if (!resolvedPlan.ok) return resolvedPlan;
  const content = fs.readFileSync(resolvedPlan.path);
  let parsedDeliveryUnitsBlock: WorkspacePlanDeliveryUnitsBlock | null = null;
  if (input.status === "approved") {
    if (input.createdBySessionId && input.approvalMode !== "auto")
      return { ok: false, error: "plan_approval_required" };
    if (actor !== "human" && input.approvalMode !== "auto") return { ok: false, error: "plan_approval_required" };
    const structure = validateApprovedPlanStructure(content.toString("utf8"));
    if (!structure.ok) return structure;
    const parsed = validateApprovedPlanDeliveryUnits(content.toString("utf8"), deps.store.listRepos());
    if (!parsed.ok) return parsed;
    parsedDeliveryUnitsBlock = parsed.block;
  }
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
  const materializedUnits = parsedDeliveryUnitsBlock
    ? materializePlanDeliveryUnits(parsedDeliveryUnitsBlock, {
        workspaceId: scope.workspace.id,
        planVersionId: planVersion.id,
        timestamp: now,
      })
    : null;
  deps.store.insertWorkspacePlanVersion(planVersion);
  if (materializedUnits) {
    deps.store.insertWorkspacePlanDeliveryUnits(materializedUnits.deliveryUnits);
    deps.store.insertWorkspacePlanDependencyEdges(materializedUnits.dependencyEdges);
  }
  if (planVersion.status === "approved") {
    deps.store.insertWorkspacePlanDecision({
      id: createId("decision"),
      planVersionId: planVersion.id,
      decision: "approve",
      reason: "Registered as approved plan",
      actor: actor === "human" ? "human" : actor === "manager" ? "manager" : "system",
      createdAt: now,
    });
  }
  deps.activity(
    "workspace.plan.registered",
    activitySource(actor),
    `Registered workspace plan v${planVersion.version}`,
    scope.workspace.repoId,
    scope.workspace.id,
    null,
  );
  return {
    ok: true,
    planVersion,
    deliveryUnits: materializedUnits?.deliveryUnits ?? [],
    dependencyEdges: materializedUnits?.dependencyEdges ?? [],
  };
}

function activitySource(actor: TrustedToolActor): ActivityEvent["source"] {
  if (actor === "human") return "user";
  if (actor === "manager") return "automatic-rule";
  return actor;
}

export function getWorkspacePlan(
  deps: Pick<WorkspacePlanDeps, "store">,
  input: { workspaceId?: string | undefined; cwd?: string | undefined },
) {
  const scope = resolveWorkspaceScope(deps.store, input);
  if (!scope.ok) return { ok: false, error: scope.error } satisfies WorkspacePlanSnapshot;
  const activePlan = deps.store.findActiveWorkspacePlan(scope.workspace.id);
  return {
    ok: true,
    workspace: scope.workspace,
    activePlan,
    planVersions: deps.store.listWorkspacePlanVersions(scope.workspace.id),
    deliveryUnits: activePlan ? deps.store.listWorkspacePlanDeliveryUnits(activePlan.id) : [],
    dependencyEdges: activePlan ? deps.store.listWorkspacePlanDependencyEdges(activePlan.id) : [],
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
  const activePlan = deps.store.findActiveWorkspacePlan(workspace.id);
  return {
    ok: true,
    target: resolvedTarget,
    workspace,
    checkout,
    checkouts: checkouts.filter((candidate) => candidate.workspaceId === workspace.id),
    activePlan,
    deliveryUnits: activePlan ? deps.store.listWorkspacePlanDeliveryUnits(activePlan.id) : [],
    dependencyEdges: activePlan ? deps.store.listWorkspacePlanDependencyEdges(activePlan.id) : [],
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
    if (!workspace) return { ok: false, error: "workspace_not_found", workspaceId: input.workspaceId };
    if (!input.cwd) return { ok: true, workspace, checkout: null, cwd: null };
    const checkouts = listAllCheckouts(store, workspaces);
    const target = resolveExecutionTargetForCwd({ cwd: input.cwd, workspaces, checkouts });
    if (!target.ok || target.target.workspaceId !== workspace.id) return { ok: false, error: "cwd_not_registered" };
    const resolvedTarget = target.target;
    const checkout =
      resolvedTarget.type === "worktree_checkout"
        ? (checkouts.find((candidate) => candidate.id === resolvedTarget.checkoutId) ?? null)
        : null;
    return { ok: true, workspace, checkout, cwd: resolvedTarget.cwd };
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
  cwd: string | null,
):
  | { ok: true; path: string }
  | { ok: false; error: "plan_path_outside_workspace" | "plan_path_missing"; detail?: string } {
  const root = realpathIfExists(workspaceRootPath(workspace));
  const absolute = path.isAbsolute(planPath) ? path.resolve(planPath) : path.resolve(cwd ?? root, planPath);
  if (!fs.existsSync(absolute)) return { ok: false, error: "plan_path_missing", detail: absolute };
  const resolved = realpathIfExists(absolute);
  if (!containsPath(root, resolved)) return { ok: false, error: "plan_path_outside_workspace", detail: resolved };
  return { ok: true, path: resolved };
}

function validateApprovedPlanStructure(
  content: string,
): { ok: true } | { ok: false; error: "plan_structure_invalid"; detail: string } {
  const required = ["Delivery Units", "Dependencies / Timeline", "Manager Handoff", "Plan Version Notes"];
  const missing = required.filter((heading) => !new RegExp(`^## ${escapeRegExp(heading)}\\b`, "im").test(content));
  return missing.length ? { ok: false, error: "plan_structure_invalid", detail: missing.join(", ") } : { ok: true };
}

function validateApprovedPlanDeliveryUnits(
  content: string,
  repos: Repo[],
):
  | { ok: true; block: WorkspacePlanDeliveryUnitsBlock }
  | { ok: false; error: "plan_delivery_units_required" | "plan_delivery_units_invalid"; detail: string } {
  const parsed = parsePlanDeliveryUnitsBlock(content);
  if (!parsed.ok) {
    const required = parsed.issues.every((entry) => entry.code === "plan_delivery_units_required");
    return {
      ok: false,
      error: required ? "plan_delivery_units_required" : "plan_delivery_units_invalid",
      detail: formatDeliveryUnitIssues(parsed.issues),
    };
  }
  const semanticIssues = validateDeliveryUnitSemantics(parsed.block.deliveryUnits, repos);
  if (semanticIssues.length) {
    return { ok: false, error: "plan_delivery_units_invalid", detail: formatDeliveryUnitIssues(semanticIssues) };
  }
  return { ok: true, block: parsed.block };
}

function validateDeliveryUnitSemantics(
  deliveryUnits: WorkspacePlanDeliveryUnit[],
  repos: Repo[],
): PlanDeliveryUnitsValidationIssue[] {
  const issues: PlanDeliveryUnitsValidationIssue[] = [];
  const childIssues = new Set<string>();
  for (const [index, unit] of deliveryUnits.entries()) {
    const pathPrefix = `deliveryUnits.${index}`;
    if (!unit.childIssue) {
      issues.push({
        code: "delivery_unit_child_issue_required",
        message: "Approved delivery units must bind exactly one child issue",
        path: `${pathPrefix}.childIssue`,
      });
    } else {
      const childIssueKey = `${unit.childIssue.provider}:${unit.childIssue.key}`;
      if (childIssues.has(childIssueKey)) {
        issues.push({
          code: "delivery_unit_child_issue_duplicate",
          message: `Duplicate child issue ${childIssueKey}`,
          path: `${pathPrefix}.childIssue`,
        });
      }
      childIssues.add(childIssueKey);
    }
    if (unit.repoId) {
      if (!repos.some((repo) => repo.id === unit.repoId)) {
        issues.push({
          code: "delivery_unit_repo_not_found",
          message: `Unknown repo id ${unit.repoId}`,
          path: `${pathPrefix}.repoId`,
        });
      }
      continue;
    }
    if (unit.repoName) {
      const matches = repos.filter((repo) => repo.name === unit.repoName);
      if (matches.length === 0) {
        issues.push({
          code: "delivery_unit_repo_not_found",
          message: `Unknown repo name ${unit.repoName}`,
          path: `${pathPrefix}.repoName`,
        });
      } else if (matches.length > 1) {
        issues.push({
          code: "delivery_unit_repo_ambiguous",
          message: `Ambiguous repo name ${unit.repoName}`,
          path: `${pathPrefix}.repoName`,
        });
      }
      continue;
    }
    if (!unit.providerRepoUrl) {
      issues.push({
        code: "delivery_unit_repo_required",
        message: "Delivery unit must specify repoId, repoName, or providerRepoUrl",
        path: `${pathPrefix}.repoName`,
      });
    }
  }
  return issues;
}

function formatDeliveryUnitIssues(issues: PlanDeliveryUnitsValidationIssue[]): string {
  return issues.map((entry) => `${entry.path ? `${entry.path}: ` : ""}${entry.code}: ${entry.message}`).join("; ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
