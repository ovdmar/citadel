import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type {
  ActivityEvent,
  AgentSession,
  LaunchArchitectAgentInput,
  LaunchImplementationAgentInput,
  LaunchPmAgentInput,
  LaunchPrototypeAgentInput,
  LaunchSettings,
  RoleId,
  RoleTemplate,
  Workspace,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService, RuntimeDescriptor } from "@citadel/operations";
import { listAgentTemplates } from "./agent-templates.js";

type Actor = "human" | "manager" | "agent" | "mcp" | "system";
type RoleLaunchInput =
  | { role: "pm"; input: LaunchPmAgentInput }
  | { role: "architect"; input: LaunchArchitectAgentInput }
  | { role: "implementation"; input: LaunchImplementationAgentInput }
  | { role: "prototype"; input: LaunchPrototypeAgentInput };

type Deps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
};

type RoleLaunchResult =
  | { ok: true; workspaceId: string; checkoutId: string | null; session: AgentSession; warnings: string[] }
  | { ok: false; error: string; detail?: string };

export async function launchStructuredRoleAgent(deps: Deps, launch: RoleLaunchInput): Promise<RoleLaunchResult> {
  const template = await findRoleTemplate(deps.config.dataDir, launch.role);
  if (!template) return { ok: false, error: "role_template_not_found", detail: launch.role };
  const runtime = resolveRuntime(deps.config, template.launchSettings);
  if (!runtime) return { ok: false, error: "runtime_unavailable", detail: template.launchSettings.runtimeId };

  if (launch.role === "pm") return launchPm(deps, launch.input, template, runtime);
  if (launch.role === "architect") return launchArchitect(deps, launch.input, template, runtime);
  if (launch.role === "implementation") return launchImplementation(deps, launch.input, template, runtime);
  return launchPrototype(deps, launch.input, template, runtime);
}

async function launchPm(
  deps: Deps,
  input: LaunchPmAgentInput,
  template: RoleTemplate,
  runtime: ResolvedRuntime,
): Promise<RoleLaunchResult> {
  const workspaceResult =
    input.workspaceId || input.cwd
      ? resolveWorkspace(deps, { workspaceId: input.workspaceId, cwd: input.cwd })
      : await createPmWorkspace(deps, input);
  if (!workspaceResult.ok) return workspaceResult;
  const workspace = workspaceResult.workspace;
  if (workspace.mode !== "structured") return { ok: false, error: "structured_workspace_required" };
  return launchRoleSession(deps, {
    workspace,
    checkout: null,
    role: "pm",
    actor: input.actor,
    template,
    runtime,
    prompt: [
      template.systemPrompt,
      input.idea ? `Idea:\n${input.idea}` : null,
      input.parentIssue ? `Parent issue:\n${input.parentIssue.provider}:${input.parentIssue.key}` : null,
    ],
  });
}

async function launchArchitect(
  deps: Deps,
  input: LaunchArchitectAgentInput,
  template: RoleTemplate,
  runtime: ResolvedRuntime,
): Promise<RoleLaunchResult> {
  const workspaceResult = resolveWorkspace(deps, { workspaceId: input.workspaceId, cwd: input.cwd });
  if (!workspaceResult.ok) return workspaceResult;
  const workspace = workspaceResult.workspace;
  if (workspace.mode !== "structured") return { ok: false, error: "structured_workspace_required" };
  if (workspace.lifecyclePhase === "discovery_inputs") return { ok: false, error: "discovery_not_ready" };
  return launchRoleSession(deps, {
    workspace,
    checkout: null,
    role: "architect",
    actor: input.actor,
    template,
    runtime,
    prompt: [template.systemPrompt, `Plan approval mode: ${input.planApprovalMode}`],
  });
}

async function launchImplementation(
  deps: Deps,
  input: LaunchImplementationAgentInput,
  template: RoleTemplate,
  runtime: ResolvedRuntime,
): Promise<RoleLaunchResult> {
  const target = resolveCheckout(deps, { checkoutId: input.checkoutId, cwd: input.cwd });
  if (!target.ok) return target;
  const { workspace, checkout } = target;
  const activePlan = input.planVersionId
    ? (deps.store.listWorkspacePlanVersions(workspace.id).find((plan) => plan.id === input.planVersionId) ?? null)
    : deps.store.findActiveWorkspacePlan(workspace.id);
  if (workspace.mode === "structured") {
    if (!activePlan || !activePlan.active || activePlan.status !== "approved")
      return { ok: false, error: "approved_plan_required" };
    if (!workspace.parentIssue && !workspace.issueKey) return { ok: false, error: "parent_issue_required" };
    if (!checkout.issue) return { ok: false, error: "child_ticket_required" };
  }
  return launchRoleSession(deps, {
    workspace,
    checkout,
    role: "implementation",
    actor: input.actor,
    template,
    runtime,
    plan: activePlan,
    prompt: [
      template.systemPrompt,
      `Checkout: ${checkout.name}`,
      activePlan ? `Workspace plan version: v${activePlan.version}` : null,
      checkout.issue ? `Child ticket: ${checkout.issue.provider}:${checkout.issue.key}` : null,
    ],
  });
}

async function launchPrototype(
  deps: Deps,
  input: LaunchPrototypeAgentInput,
  template: RoleTemplate,
  runtime: ResolvedRuntime,
): Promise<RoleLaunchResult> {
  const target = resolveCheckout(deps, { checkoutId: input.checkoutId, cwd: input.cwd });
  if (!target.ok) return target;
  return launchRoleSession(deps, {
    workspace: target.workspace,
    checkout: target.checkout,
    role: "prototype",
    actor: input.actor,
    template,
    runtime,
    prompt: [template.systemPrompt, input.prompt ?? null],
  });
}

async function launchRoleSession(
  deps: Deps,
  input: {
    workspace: Workspace;
    checkout: WorktreeCheckout | null;
    role: RoleId;
    actor: Actor;
    template: RoleTemplate;
    runtime: ResolvedRuntime;
    plan?: WorkspacePlanVersion | null;
    prompt: Array<string | null>;
  },
): Promise<RoleLaunchResult> {
  const manager = deps.store.getWorkspaceManager(input.workspace.id);
  if (input.actor !== "human" && manager?.pauseState === "paused") return { ok: false, error: "automation_paused" };
  const session = await deps.operations.createAgentSession(
    {
      workspaceId: input.workspace.id,
      runtimeId: input.runtime.id,
      displayName: input.template.displayName,
      prompt: input.prompt.filter(Boolean).join("\n\n"),
      targetType: input.checkout ? "worktree_checkout" : "workspace_home",
      ...(input.checkout ? { checkoutId: input.checkout.id } : {}),
      role: input.role,
      managed: true,
      ...(input.plan ? { planVersionId: input.plan.id } : {}),
      launchSettings: input.runtime.launchSettings,
    },
    input.runtime.descriptor,
    { activitySource: activitySource(input.actor) },
  );
  return {
    ok: true,
    workspaceId: input.workspace.id,
    checkoutId: input.checkout?.id ?? null,
    session,
    warnings: session.launchWarnings ?? [],
  };
}

async function createPmWorkspace(
  deps: Deps,
  input: LaunchPmAgentInput,
): Promise<{ ok: true; workspace: Workspace } | { ok: false; error: string; detail?: string }> {
  const name = input.workspaceName?.trim() || slug(input.idea ?? "workspace");
  const rootPath = uniqueWorkspaceRoot(deps.config.dataDir, name);
  const created = await deps.operations.createWorkspace({
    mode: "structured",
    rootPath,
    name,
    source: "scratch",
    ...(input.parentIssue ? { parentIssue: input.parentIssue } : {}),
  });
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
  return workspace ? { ok: true, workspace } : { ok: false, error: "workspace_not_found", detail: created.workspaceId };
}

function resolveWorkspace(
  deps: Deps,
  input: { workspaceId?: string | undefined; cwd?: string | undefined },
): { ok: true; workspace: Workspace } | { ok: false; error: string; detail?: string } {
  if (input.workspaceId) {
    const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
    return workspace ? { ok: true, workspace } : { ok: false, error: "workspace_not_found", detail: input.workspaceId };
  }
  if (!input.cwd) return { ok: false, error: "workspace_required" };
  const context = deps.operations.getCitadelContext({ cwd: input.cwd });
  if (!context.ok) return { ok: false, error: context.error, detail: input.cwd };
  return { ok: true, workspace: context.workspace };
}

function resolveCheckout(
  deps: Deps,
  input: { checkoutId?: string | undefined; cwd?: string | undefined },
): { ok: true; workspace: Workspace; checkout: WorktreeCheckout } | { ok: false; error: string; detail?: string } {
  const checkout = input.checkoutId ? deps.store.findWorkspaceCheckout(input.checkoutId) : null;
  if (checkout) {
    const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === checkout.workspaceId);
    return workspace
      ? { ok: true, workspace, checkout }
      : { ok: false, error: "workspace_not_found", detail: checkout.workspaceId };
  }
  if (input.checkoutId) return { ok: false, error: "checkout_not_found", detail: input.checkoutId };
  if (!input.cwd) return { ok: false, error: "checkout_required" };
  const context = deps.operations.getCitadelContext({ cwd: input.cwd });
  if (!context.ok) return { ok: false, error: context.error, detail: input.cwd };
  if (!context.checkout) return { ok: false, error: "checkout_required", detail: input.cwd };
  return { ok: true, workspace: context.workspace, checkout: context.checkout };
}

async function findRoleTemplate(dataDir: string, role: RoleId): Promise<RoleTemplate | null> {
  const templates = await listAgentTemplates(dataDir);
  return templates.find((template) => template.role === role) ?? null;
}

type ResolvedRuntime = {
  id: string;
  launchSettings: LaunchSettings;
  descriptor: RuntimeDescriptor;
};

function resolveRuntime(config: CitadelConfig, settings: LaunchSettings): ResolvedRuntime | null {
  const runtime =
    config.agentRuntimes.find((candidate) => candidate.id === settings.runtimeId) ?? config.agentRuntimes[0];
  if (!runtime) return null;
  return {
    id: runtime.id,
    launchSettings: { ...settings, runtimeId: runtime.id },
    descriptor: {
      id: runtime.id,
      command: runtime.command,
      args: runtime.args,
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? null,
      sessionIdArg: runtime.sessionIdArg ?? null,
      resumeArg: runtime.resumeArg ?? null,
      ...(runtime.launchOptions ? { launchOptions: runtime.launchOptions } : {}),
    },
  };
}

function uniqueWorkspaceRoot(dataDir: string, name: string): string {
  const parent = path.join(dataDir, "structured-workspaces");
  const base = slug(name);
  let candidate = path.join(parent, base);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(parent, `${base}-${index}`);
  }
  return candidate;
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || `workspace-${Date.now().toString(36)}`;
}

function activitySource(actor: Actor): ActivityEvent["source"] {
  if (actor === "human") return "user";
  if (actor === "manager") return "automatic-rule";
  return actor;
}
