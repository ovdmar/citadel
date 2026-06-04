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

type AgentTemplateDefaults = {
  runtimeId?: string | null | undefined;
};
type StoredAgentTemplates = { roles: StoredRole[] };
type StoredRole = Omit<RoleTemplate, "actions"> & {
  launchSettingsExplicit?: boolean | undefined;
  actions: StoredAction[];
};
type StoredAction = ActionTemplate & {
  launchSettingsExplicit?: boolean | undefined;
};
type RawRole = Partial<StoredRole> & { role: RoleId; actions?: RawAction[] };
type RawAction = Partial<StoredAction> & { id: ActionTemplateId };

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
  return { roles: Array.isArray(parsed.roles) ? (parsed.roles as StoredRole[]) : [] };
}

function writeRaw(dataDir: string, store: StoredAgentTemplates): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const filePath = templatesPath(dataDir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export function agentTemplateDefaultsFromRuntimes(
  runtimes: ReadonlyArray<{ id: string }> | null | undefined,
): AgentTemplateDefaults {
  return { runtimeId: runtimes?.[0]?.id ?? DEFAULT_RUNTIME };
}

export async function listAgentTemplates(dataDir: string, defaults?: AgentTemplateDefaults): Promise<RoleTemplate[]> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir), defaults);
    if (normalized.mutated) writeRaw(dataDir, normalized.store);
    return normalized.store.roles.map((role) => cloneRole(role));
  });
}

export async function updateRoleTemplate(
  dataDir: string,
  roleId: RoleId,
  input: UpdateRoleTemplateInput,
  defaults?: AgentTemplateDefaults,
): Promise<RoleTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir), defaults);
    const role = normalized.store.roles.find((entry) => entry.role === roleId);
    if (!role) throw new AgentTemplateNotFoundError(roleId);
    if (role.updatedAt !== input.updatedAt) throw new StaleAgentTemplateUpdatedAtError();
    const next: StoredRole = {
      ...role,
      systemPrompt: input.systemPrompt ?? role.systemPrompt,
      launchSettings: input.launchSettings ?? role.launchSettings,
      launchSettingsExplicit: input.launchSettings ? true : role.launchSettingsExplicit,
      updatedAt: nowIso(),
    };
    normalized.store.roles = normalized.store.roles.map((entry) => (entry.role === roleId ? next : entry));
    writeRaw(dataDir, normalized.store);
    return cloneRole(next);
  });
}

export async function resetRoleTemplate(
  dataDir: string,
  roleId: RoleId,
  defaults?: AgentTemplateDefaults,
): Promise<RoleTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir), defaults);
    const roleDefaults = defaultRole(roleId, defaults);
    if (!roleDefaults) throw new AgentTemplateNotFoundError(roleId);
    const existing = normalized.store.roles.find((entry) => entry.role === roleId);
    if (!existing) throw new AgentTemplateNotFoundError(roleId);
    const next: StoredRole = {
      ...existing,
      displayName: roleDefaults.displayName,
      systemPrompt: roleDefaults.systemPrompt,
      launchSettings: { ...roleDefaults.launchSettings },
      launchSettingsExplicit: undefined,
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
  defaults?: AgentTemplateDefaults,
): Promise<ActionTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir), defaults);
    const located = findAction(normalized.store.roles, actionId);
    if (!located) throw new AgentTemplateNotFoundError(actionId);
    if (located.action.updatedAt !== input.updatedAt) throw new StaleAgentTemplateUpdatedAtError();
    const next: StoredAction = {
      ...located.action,
      prompt: input.prompt ?? located.action.prompt,
      launchSettings: input.launchSettings ?? located.action.launchSettings,
      launchSettingsExplicit: input.launchSettings ? true : located.action.launchSettingsExplicit,
      executionMode: input.executionMode ?? located.action.executionMode,
      updatedAt: nowIso(),
    };
    located.role.actions = located.role.actions.map((action) => (action.id === actionId ? next : action));
    writeRaw(dataDir, normalized.store);
    return cloneAction(next);
  });
}

export async function resetActionTemplate(
  dataDir: string,
  actionId: ActionTemplateId,
  defaults?: AgentTemplateDefaults,
): Promise<ActionTemplate> {
  return withMutex(dataDir, () => {
    const normalized = normalizeStore(readRaw(dataDir), defaults);
    const actionDefaults = defaultAction(actionId, defaults);
    if (!actionDefaults) throw new AgentTemplateNotFoundError(actionId);
    const located = findAction(normalized.store.roles, actionId);
    if (!located) throw new AgentTemplateNotFoundError(actionId);
    const next: StoredAction = {
      ...actionDefaults,
      launchSettings: { ...actionDefaults.launchSettings },
      launchSettingsExplicit: undefined,
      updatedAt: nowIso(),
    };
    located.role.actions = located.role.actions.map((action) => (action.id === actionId ? next : action));
    writeRaw(dataDir, normalized.store);
    return cloneAction(next);
  });
}

function normalizeStore(
  raw: StoredAgentTemplates,
  defaults?: AgentTemplateDefaults,
): { store: StoredAgentTemplates; mutated: boolean } {
  let mutated = false;
  const byRole = new Map((raw.roles as RawRole[]).map((role) => [role.role, role] as const));
  const roles = DEFAULT_ROLES.map((roleDefaults) => {
    const normalized = normalizeRole(roleDefaults, byRole.get(roleDefaults.role), defaults);
    if (normalized.mutated) mutated = true;
    return normalized.role;
  });
  if (raw.roles.length !== roles.length) mutated = true;
  return { store: { roles }, mutated };
}

function normalizeRole(
  defaults: RoleTemplate,
  raw: RawRole | undefined,
  templateDefaults?: AgentTemplateDefaults,
): { role: StoredRole; mutated: boolean } {
  const rawActions = new Map((raw?.actions ?? []).map((action) => [action.id, action] as const));
  let mutated = !raw;
  const roleDefaults = withDefaultLaunchSettings(defaults, templateDefaults);
  const actions = roleDefaults.actions.map((actionDefaults) => {
    const normalized = normalizeAction(actionDefaults, rawActions.get(actionDefaults.id), templateDefaults);
    if (normalized.mutated) mutated = true;
    return normalized.action;
  });
  const launch = normalizeLaunchSettings(
    raw?.launchSettings,
    roleDefaults.launchSettings,
    raw?.launchSettingsExplicit === true,
  );
  if (launch.mutated) mutated = true;
  const role: StoredRole = {
    role: roleDefaults.role,
    displayName: roleDefaults.displayName,
    systemPrompt: raw?.systemPrompt ?? roleDefaults.systemPrompt,
    launchSettings: launch.settings,
    launchSettingsExplicit: launch.explicit ? true : undefined,
    actions,
    builtIn: true,
    resettable: true,
    updatedAt: raw?.updatedAt ?? nowIso(),
  };
  if (raw && raw.actions?.length !== actions.length) mutated = true;
  if (raw && raw.launchSettingsExplicit !== role.launchSettingsExplicit) mutated = true;
  return { role, mutated };
}

function normalizeAction(
  defaults: ActionTemplate,
  raw: RawAction | undefined,
  templateDefaults?: AgentTemplateDefaults,
): { action: StoredAction; mutated: boolean } {
  const actionDefaults = withDefaultActionLaunchSettings(defaults, templateDefaults);
  const launch = normalizeLaunchSettings(
    raw?.launchSettings,
    actionDefaults.launchSettings,
    raw?.launchSettingsExplicit === true,
  );
  const action: StoredAction = {
    id: actionDefaults.id,
    role: actionDefaults.role,
    displayName: actionDefaults.displayName,
    prompt: raw?.prompt ?? actionDefaults.prompt,
    launchSettings: launch.settings,
    launchSettingsExplicit: launch.explicit ? true : undefined,
    executionMode: raw?.executionMode ?? actionDefaults.executionMode,
    builtIn: true,
    resettable: true,
    updatedAt: raw?.updatedAt ?? nowIso(),
  };
  return {
    action: { ...action, launchSettings: { ...action.launchSettings } },
    mutated: !raw || launch.mutated || raw.launchSettingsExplicit !== action.launchSettingsExplicit,
  };
}

function findAction(roles: StoredRole[], actionId: ActionTemplateId) {
  for (const role of roles) {
    const action = role.actions.find((entry) => entry.id === actionId);
    if (action) return { role, action };
  }
  return null;
}

function defaultRole(roleId: RoleId, defaults?: AgentTemplateDefaults): RoleTemplate | null {
  const role = DEFAULT_ROLES.find((entry) => entry.role === roleId);
  return role ? cloneRole(withDefaultLaunchSettings(role, defaults)) : null;
}

function defaultAction(actionId: ActionTemplateId, defaults?: AgentTemplateDefaults): ActionTemplate | null {
  for (const role of DEFAULT_ROLES) {
    const action = role.actions.find((entry) => entry.id === actionId);
    if (action) {
      const withDefaults = withDefaultActionLaunchSettings(action, defaults);
      return { ...withDefaults, launchSettings: { ...withDefaults.launchSettings } };
    }
  }
  return null;
}

function cloneRole(role: RoleTemplate, updatedAt = role.updatedAt): RoleTemplate {
  return {
    role: role.role,
    displayName: role.displayName,
    systemPrompt: role.systemPrompt,
    launchSettings: { ...role.launchSettings },
    actions: role.actions.map((action) => ({
      ...cloneAction(action, action.updatedAt ?? updatedAt),
    })),
    builtIn: role.builtIn,
    resettable: role.resettable,
    updatedAt,
  };
}

function cloneAction(action: ActionTemplate, updatedAt = action.updatedAt): ActionTemplate {
  return {
    id: action.id,
    role: action.role,
    displayName: action.displayName,
    prompt: action.prompt,
    launchSettings: { ...action.launchSettings },
    executionMode: action.executionMode,
    builtIn: action.builtIn,
    resettable: action.resettable,
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

function defaultLaunchSettings(defaults?: AgentTemplateDefaults): LaunchSettings {
  const runtimeId = defaults?.runtimeId?.trim() || DEFAULT_RUNTIME;
  return { ...DEFAULT_LAUNCH, runtimeId };
}

function withDefaultLaunchSettings(role: RoleTemplate, defaults?: AgentTemplateDefaults): RoleTemplate {
  const launchSettings = defaultLaunchSettings(defaults);
  return {
    ...role,
    launchSettings,
    actions: role.actions.map((entry) => withDefaultActionLaunchSettings(entry, defaults)),
  };
}

function withDefaultActionLaunchSettings(action: ActionTemplate, defaults?: AgentTemplateDefaults): ActionTemplate {
  return { ...action, launchSettings: defaultLaunchSettings(defaults) };
}

function normalizeLaunchSettings(
  raw: LaunchSettings | Partial<LaunchSettings> | null | undefined,
  defaults: LaunchSettings,
  explicit: boolean,
): { settings: LaunchSettings; explicit: boolean; mutated: boolean } {
  if (!raw) return { settings: { ...defaults }, explicit: false, mutated: true };
  const normalized: LaunchSettings = {
    runtimeId: raw.runtimeId?.trim() || defaults.runtimeId,
    model: raw.model ?? null,
    effort: raw.effort ?? null,
    fastMode: raw.fastMode ?? null,
    contextMode: raw.contextMode ?? null,
  };
  if (!explicit && isMigratableLegacyDefault(normalized, defaults)) {
    return { settings: { ...defaults }, explicit: false, mutated: true };
  }
  return {
    settings: normalized,
    explicit,
    mutated:
      normalized.runtimeId !== raw.runtimeId ||
      normalized.model !== (raw.model ?? null) ||
      normalized.effort !== (raw.effort ?? null) ||
      normalized.fastMode !== (raw.fastMode ?? null) ||
      normalized.contextMode !== (raw.contextMode ?? null),
  };
}

function isMigratableLegacyDefault(settings: LaunchSettings, defaults: LaunchSettings): boolean {
  const legacyDefault =
    settings.runtimeId === DEFAULT_LAUNCH.runtimeId &&
    settings.model === DEFAULT_LAUNCH.model &&
    settings.effort === DEFAULT_LAUNCH.effort &&
    settings.fastMode === DEFAULT_LAUNCH.fastMode &&
    settings.contextMode === DEFAULT_LAUNCH.contextMode;
  return legacyDefault && defaults.runtimeId !== DEFAULT_RUNTIME;
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
