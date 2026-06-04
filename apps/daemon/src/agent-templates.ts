import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  ActionTemplate,
  ActionTemplateId,
  LaunchSettings,
  RoleId,
  RoleTemplate,
  UpdateActionTemplateInput,
  UpdateRoleTemplateInput,
} from "@citadel/contracts";

const FILENAME = "agent-templates.json";
const DEFAULT_RUNTIME = "claude-code";
const DEFAULT_LAUNCH: LaunchSettings = {
  runtimeId: DEFAULT_RUNTIME,
  model: null,
  effort: null,
  fastMode: null,
  contextMode: null,
};

type StoredAgentTemplates = { roles: RoleTemplate[] };
type RawRole = Partial<RoleTemplate> & { role: RoleId; actions?: RawAction[] };
type RawAction = Partial<ActionTemplate> & { id: ActionTemplateId };

export class AgentTemplateNotFoundError extends Error {
  constructor(public readonly id: string) {
    super("agent_template_not_found");
    this.name = "AgentTemplateNotFoundError";
  }
}

export class StaleAgentTemplateUpdatedAtError extends Error {
  constructor() {
    super("stale_updated_at");
    this.name = "StaleAgentTemplateUpdatedAtError";
  }
}

const queues = new Map<string, Promise<unknown>>();
function withMutex<T>(dataDir: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = queues.get(dataDir) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  queues.set(
    dataDir,
    next.catch(() => undefined),
  );
  return next as Promise<T>;
}

let lastTs = "";
function nowIso(): string {
  let ts = new Date().toISOString();
  if (ts <= lastTs) ts = new Date(Date.parse(lastTs) + 1).toISOString();
  lastTs = ts;
  return ts;
}

function templatesPath(dataDir: string): string {
  return path.join(dataDir, FILENAME);
}

function readRaw(dataDir: string): StoredAgentTemplates {
  const filePath = templatesPath(dataDir);
  if (!existsSync(filePath)) return { roles: [] };
  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) return { roles: [] };
  const parsed = JSON.parse(raw) as Partial<StoredAgentTemplates>;
  return { roles: Array.isArray(parsed.roles) ? (parsed.roles as RoleTemplate[]) : [] };
}

function writeRaw(dataDir: string, store: StoredAgentTemplates): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const filePath = templatesPath(dataDir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function defaultAgentTemplates(): RoleTemplate[] {
  return DEFAULT_ROLES.map((role) => cloneRole(role, nowIso()));
}

export async function listAgentTemplates(dataDir: string): Promise<RoleTemplate[]> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir));
    if (normalized.mutated) writeRaw(dataDir, normalized.store);
    return normalized.store.roles.map((role) => cloneRole(role));
  });
}

export async function updateRoleTemplate(
  dataDir: string,
  roleId: RoleId,
  input: UpdateRoleTemplateInput,
): Promise<RoleTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir));
    const role = normalized.store.roles.find((entry) => entry.role === roleId);
    if (!role) throw new AgentTemplateNotFoundError(roleId);
    if (role.updatedAt !== input.updatedAt) throw new StaleAgentTemplateUpdatedAtError();
    const next: RoleTemplate = {
      ...role,
      systemPrompt: input.systemPrompt ?? role.systemPrompt,
      launchSettings: input.launchSettings ?? role.launchSettings,
      updatedAt: nowIso(),
    };
    normalized.store.roles = normalized.store.roles.map((entry) => (entry.role === roleId ? next : entry));
    writeRaw(dataDir, normalized.store);
    return cloneRole(next);
  });
}

export async function resetRoleTemplate(dataDir: string, roleId: RoleId): Promise<RoleTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir));
    const defaults = defaultRole(roleId);
    if (!defaults) throw new AgentTemplateNotFoundError(roleId);
    const existing = normalized.store.roles.find((entry) => entry.role === roleId);
    if (!existing) throw new AgentTemplateNotFoundError(roleId);
    const next: RoleTemplate = {
      ...existing,
      displayName: defaults.displayName,
      systemPrompt: defaults.systemPrompt,
      launchSettings: { ...defaults.launchSettings },
      updatedAt: nowIso(),
    };
    normalized.store.roles = normalized.store.roles.map((entry) => (entry.role === roleId ? next : entry));
    writeRaw(dataDir, normalized.store);
    return cloneRole(next);
  });
}

export async function updateActionTemplate(
  dataDir: string,
  actionId: ActionTemplateId,
  input: UpdateActionTemplateInput,
): Promise<ActionTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir));
    const located = findAction(normalized.store.roles, actionId);
    if (!located) throw new AgentTemplateNotFoundError(actionId);
    if (located.action.updatedAt !== input.updatedAt) throw new StaleAgentTemplateUpdatedAtError();
    const next: ActionTemplate = {
      ...located.action,
      prompt: input.prompt ?? located.action.prompt,
      launchSettings: input.launchSettings ?? located.action.launchSettings,
      executionMode: input.executionMode ?? located.action.executionMode,
      updatedAt: nowIso(),
    };
    located.role.actions = located.role.actions.map((action) => (action.id === actionId ? next : action));
    writeRaw(dataDir, normalized.store);
    return { ...next, launchSettings: { ...next.launchSettings } };
  });
}

export async function resetActionTemplate(dataDir: string, actionId: ActionTemplateId): Promise<ActionTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir));
    const defaults = defaultAction(actionId);
    if (!defaults) throw new AgentTemplateNotFoundError(actionId);
    const located = findAction(normalized.store.roles, actionId);
    if (!located) throw new AgentTemplateNotFoundError(actionId);
    const next: ActionTemplate = { ...defaults, launchSettings: { ...defaults.launchSettings }, updatedAt: nowIso() };
    located.role.actions = located.role.actions.map((action) => (action.id === actionId ? next : action));
    writeRaw(dataDir, normalized.store);
    return { ...next, launchSettings: { ...next.launchSettings } };
  });
}

function normalizeStore(raw: StoredAgentTemplates): { store: StoredAgentTemplates; mutated: boolean } {
  let mutated = false;
  const byRole = new Map((raw.roles as RawRole[]).map((role) => [role.role, role] as const));
  const roles = DEFAULT_ROLES.map((defaults) => {
    const normalized = normalizeRole(defaults, byRole.get(defaults.role));
    if (normalized.mutated) mutated = true;
    return normalized.role;
  });
  if (raw.roles.length !== roles.length) mutated = true;
  return { store: { roles }, mutated };
}

function normalizeRole(defaults: RoleTemplate, raw: RawRole | undefined): { role: RoleTemplate; mutated: boolean } {
  const rawActions = new Map((raw?.actions ?? []).map((action) => [action.id, action] as const));
  let mutated = !raw;
  const actions = defaults.actions.map((actionDefaults) => {
    const normalized = normalizeAction(actionDefaults, rawActions.get(actionDefaults.id));
    if (normalized.mutated) mutated = true;
    return normalized.action;
  });
  const role: RoleTemplate = {
    role: defaults.role,
    displayName: defaults.displayName,
    systemPrompt: raw?.systemPrompt ?? defaults.systemPrompt,
    launchSettings: raw?.launchSettings ?? defaults.launchSettings,
    actions,
    builtIn: true,
    resettable: true,
    updatedAt: raw?.updatedAt ?? nowIso(),
  };
  if (raw && raw.actions?.length !== actions.length) mutated = true;
  return { role: cloneRole(role), mutated };
}

function normalizeAction(
  defaults: ActionTemplate,
  raw: RawAction | undefined,
): { action: ActionTemplate; mutated: boolean } {
  const action: ActionTemplate = {
    id: defaults.id,
    role: defaults.role,
    displayName: defaults.displayName,
    prompt: raw?.prompt ?? defaults.prompt,
    launchSettings: raw?.launchSettings ?? defaults.launchSettings,
    executionMode: raw?.executionMode ?? defaults.executionMode,
    builtIn: true,
    resettable: true,
    updatedAt: raw?.updatedAt ?? nowIso(),
  };
  return { action: { ...action, launchSettings: { ...action.launchSettings } }, mutated: !raw };
}

function findAction(roles: RoleTemplate[], actionId: ActionTemplateId) {
  for (const role of roles) {
    const action = role.actions.find((entry) => entry.id === actionId);
    if (action) return { role, action };
  }
  return null;
}

function defaultRole(roleId: RoleId): RoleTemplate | null {
  const role = DEFAULT_ROLES.find((entry) => entry.role === roleId);
  return role ? cloneRole(role) : null;
}

function defaultAction(actionId: ActionTemplateId): ActionTemplate | null {
  for (const role of DEFAULT_ROLES) {
    const action = role.actions.find((entry) => entry.id === actionId);
    if (action) return { ...action, launchSettings: { ...action.launchSettings } };
  }
  return null;
}

function cloneRole(role: RoleTemplate, updatedAt = role.updatedAt): RoleTemplate {
  return {
    ...role,
    launchSettings: { ...role.launchSettings },
    actions: role.actions.map((action) => ({
      ...action,
      launchSettings: { ...action.launchSettings },
      updatedAt: action.updatedAt ?? updatedAt,
    })),
    updatedAt,
  };
}

function action(
  id: ActionTemplateId,
  role: RoleId,
  displayName: string,
  prompt: string,
  executionMode: ActionTemplate["executionMode"] = "new_session",
): ActionTemplate {
  return {
    id,
    role,
    displayName,
    prompt,
    launchSettings: { ...DEFAULT_LAUNCH },
    executionMode,
    builtIn: true,
    resettable: true,
    updatedAt: null,
  };
}

const DEFAULT_ROLES: RoleTemplate[] = [
  {
    role: "pm",
    displayName: "PM",
    systemPrompt:
      "Clarify the product goal, collect discovery inputs, identify the parent issue and likely child issues, and prepare a concise handoff for architecture. Call out expected repos, delivery slices, dependency constraints, and any missing inputs the architect must resolve before an approved plan can be registered.",
    launchSettings: { ...DEFAULT_LAUNCH },
    actions: [],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  },
  {
    role: "architect",
    displayName: "Architect",
    systemPrompt:
      "Produce /do-tech-plan based architecture plans with Delivery Units, Dependencies / Timeline, Manager Handoff, and Plan Version Notes. Include exactly one fenced ```json citadel.delivery_units.v1 block with deliveryUnits[]. Each unit needs key, repoId or repoName or providerRepoUrl, checkoutName, branch, exactly one childIssue, and dependencies using fromUnitKey plus type parallel, stacked_on_pr, wait_for_merge_or_release, or manual. Repair parser errors directly in the plan before requesting approval.",
    launchSettings: { ...DEFAULT_LAUNCH },
    actions: [
      action(
        "architect.replan_from_deviation",
        "architect",
        "Replan from deviation",
        "Review the reported plan deviation, update the active workspace plan, and register the new plan version.",
      ),
    ],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  },
  {
    role: "implementation",
    displayName: "Implementation",
    systemPrompt:
      "Implement the assigned delivery unit in the checkout, keep the plan current, open a PR, and report completion through Citadel tools.",
    launchSettings: { ...DEFAULT_LAUNCH },
    actions: [
      action(
        "implementation.review_pr",
        "implementation",
        "Review PR",
        "Run /review-pr for this checkout and register the review artifact.",
      ),
      action(
        "implementation.fix_ci",
        "implementation",
        "Fix CI",
        "Inspect failing checks, implement the smallest fix, and update the PR.",
      ),
      action(
        "implementation.fix_conflicts",
        "implementation",
        "Fix conflicts",
        "Resolve merge conflicts for this checkout without discarding user changes.",
      ),
      action(
        "implementation.poke_idle_without_pr",
        "implementation",
        "Poke idle implementation",
        "Check why the implementation agent is idle before opening a PR and move it forward.",
        "existing_session",
      ),
      action(
        "implementation.restack_checkout",
        "implementation",
        "Restack checkout",
        "Rebase or merge the checkout on top of its current stack parent and report conflicts or success.",
      ),
    ],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  },
  {
    role: "prototype",
    displayName: "Prototype",
    systemPrompt: "Build focused discovery prototypes in a checkout and capture evidence for PM and architecture.",
    launchSettings: { ...DEFAULT_LAUNCH },
    actions: [
      action(
        "prototype.capture_findings",
        "prototype",
        "Capture findings",
        "Summarize prototype findings, risks, and repository evidence for the workspace Home context.",
      ),
    ],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  },
  {
    role: "manager",
    displayName: "Manager",
    systemPrompt:
      "Supervise structured workspace delivery through Citadel MCP tools, enforcing gates, idempotency, pause state, and local notifications.",
    launchSettings: { ...DEFAULT_LAUNCH },
    actions: [
      action(
        "manager.heartbeat_digest",
        "manager",
        "Heartbeat digest",
        "Summarize manager state and pending actions for this workspace.",
        "existing_session",
      ),
      action(
        "manager.notify_ready_for_human_review",
        "manager",
        "Notify ready for review",
        "Create a local readiness notification for checkouts that passed review gates.",
        "existing_session",
      ),
      action(
        "manager.update_ticket_status",
        "manager",
        "Update ticket status",
        "Move the bound external ticket toward the requested internal delivery state best-effort.",
      ),
    ],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  },
];
