import type { CitadelConfig, HookConfig } from "@citadel/config";
import type { ActivityEvent, HookEvent, HookOutput, Repo, Workspace } from "@citadel/contracts";
import {
  type FileHook,
  type FileHookDiagnostic,
  describeError,
  discoverFileHooks,
  parseHookOutput,
  renderTemplate,
  runCommandHook,
} from "@citadel/hooks";
import { asObject } from "./helpers.js";

type ActivityFn = (
  type: string,
  source: ActivityEvent["source"],
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
  hookOutput?: HookOutput | null,
) => void;

type RunnerConfig = {
  hooks: HookConfig[];
  commandPolicy: CitadelConfig["commandPolicy"];
};

// Injected by operations/index.ts so @citadel/hooks (where discovery lives)
// stays free of @citadel/operations imports — the boundary is enforced by
// scripts/checks/architecture-boundaries.ts. The dispatcher receives the
// firing operationId so launched sessions can link activity events back.
export type DispatchAgentHook = (input: {
  workspace: Workspace;
  repo: Repo;
  runtimeId?: string;
  displayName?: string;
  prompt: string;
  operationId: string | null;
  hookId: string;
  event: HookEvent;
}) => Promise<{ sessionId: string }>;

// Events whose .sh hooks must propagate on failure. Mirrors the default-
// blocking list in @citadel/config's HookConfigSchema.transform.
const SH_BLOCKING_EVENTS = new Set<HookEvent>(["workspace.setup", "workspace.teardown", "pr.merge"]);

type DiscoveredHook =
  | { kind: "command-config"; hook: HookConfig }
  | { kind: "command-file"; id: string; filePath: string }
  | { kind: "agent-file"; id: string; filePath: string; meta: Record<string, string>; body: string };

type CollectHooksResult = {
  hooks: DiscoveredHook[];
  diagnostics: FileHookDiagnostic[];
};

export type RunHooksResult = {
  ran: number;
};

function collectHooks(
  event: HookEvent,
  hookIds: string[] | null,
  configHooks: HookConfig[],
  workspacePath: string,
): CollectHooksResult {
  const collected: DiscoveredHook[] = [];

  for (const hook of configHooks) {
    if (hook.event !== event) continue;
    // hookIds === null means "run every config hook for this event" (used by
    // notification hooks today). Otherwise, filter by repo's opt-in list.
    if (hookIds !== null && !hookIds.includes(hook.id)) continue;
    collected.push({ kind: "command-config", hook });
  }

  const fileResult = discoverFileHooks({ workspacePath, event });
  for (const file of fileResult.hooks) {
    collected.push(toDiscoveredFromFile(file));
  }
  return { hooks: collected, diagnostics: fileResult.diagnostics };
}

function toDiscoveredFromFile(file: FileHook): DiscoveredHook {
  if (file.kind === "command-file") {
    return { kind: "command-file", id: file.id, filePath: file.filePath };
  }
  return {
    kind: "agent-file",
    id: file.id,
    filePath: file.filePath,
    meta: file.meta,
    body: file.body,
  };
}

function commandHook(hook: HookConfig, workspacePath: string, config: RunnerConfig | undefined) {
  return {
    id: hook.id,
    event: hook.event,
    command: hook.command,
    args: hook.args,
    cwd: hook.cwd || workspacePath,
    timeoutMs: config?.commandPolicy.hookTimeoutMs ?? 120_000,
    blocking: hook.blocking,
  };
}

function commandFileHook(
  id: string,
  filePath: string,
  event: HookEvent,
  workspacePath: string,
  config: RunnerConfig | undefined,
) {
  return {
    id,
    event,
    command: filePath,
    args: [],
    cwd: workspacePath,
    timeoutMs: config?.commandPolicy.hookTimeoutMs ?? 120_000,
    // .sh file hooks inherit the event's default blocking policy.
    blocking: SH_BLOCKING_EVENTS.has(event),
  };
}

function emitDiscoveryDiagnostics(
  diagnostics: FileHookDiagnostic[],
  event: HookEvent,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
  activity: ActivityFn,
) {
  for (const diagnostic of diagnostics) {
    activity(
      `hook.${event}.failed`,
      "hook",
      `Hook ${diagnostic.id} skipped: ${diagnostic.error}`,
      repoId,
      workspaceId,
      operationId,
    );
  }
}

function parseOptionalHookOutput(stdout: string): HookOutput | null {
  try {
    return parseHookOutput(stdout);
  } catch {
    return null;
  }
}

export async function runWorkspaceHooks(input: {
  config: RunnerConfig | undefined;
  activity: ActivityFn;
  event: HookEvent;
  hookIds: string[] | null;
  repo: Repo;
  workspace: Workspace;
  operationId: string | null;
  payload?: unknown;
  dispatchAgentHook: DispatchAgentHook;
}): Promise<RunHooksResult> {
  const { hooks, diagnostics } = collectHooks(
    input.event,
    input.hookIds,
    input.config?.hooks ?? [],
    input.workspace.path,
  );
  emitDiscoveryDiagnostics(
    diagnostics,
    input.event,
    input.repo.id,
    input.workspace.id,
    input.operationId,
    input.activity,
  );

  let ran = 0;
  for (const hook of hooks) {
    if (await runOne(hook, input)) ran += 1;
  }
  return { ran };
}

export async function runNotificationHooks(input: {
  config: RunnerConfig | undefined;
  activity: ActivityFn;
  event: HookEvent;
  repo: Repo;
  workspace: Workspace;
  operationId: string | null;
  payload: unknown;
  dispatchAgentHook: DispatchAgentHook;
}): Promise<RunHooksResult> {
  // null hookIds = "run every config hook for this event" (today's notification
  // semantics). File hooks are unconditionally discovered.
  const { hooks, diagnostics } = collectHooks(input.event, null, input.config?.hooks ?? [], input.workspace.path);
  emitDiscoveryDiagnostics(
    diagnostics,
    input.event,
    input.repo.id,
    input.workspace.id,
    input.operationId,
    input.activity,
  );

  let ran = 0;
  for (const hook of hooks) {
    try {
      if (await runOneNotification(hook, input)) ran += 1;
    } catch (error) {
      // Notification hooks have always been best-effort (errors logged, never
      // propagated). Keep that behavior — distinct from runWorkspaceHooks
      // where workspace.setup/teardown/pr.merge surface failures.
      input.activity(
        `hook.${input.event}.failed`,
        "hook",
        `Hook ${describeHookId(hook)} failed: ${describeError(error)}`,
        input.repo.id,
        input.workspace.id,
        input.operationId,
      );
    }
  }
  return { ran };
}

async function runOne(
  hook: DiscoveredHook,
  input: {
    config: RunnerConfig | undefined;
    activity: ActivityFn;
    event: HookEvent;
    repo: Repo;
    workspace: Workspace;
    operationId: string | null;
    payload?: unknown;
    dispatchAgentHook: DispatchAgentHook;
  },
): Promise<boolean> {
  const payload = workspaceHookPayload(input);
  if (hook.kind === "command-config") {
    const result = await runCommandHook(commandHook(hook.hook, input.workspace.path, input.config), {
      ...payload,
    });
    input.activity(
      `hook.${input.event}`,
      "hook",
      `Hook ${hook.hook.id} completed${result.stderr ? " with stderr" : ""}`,
      input.repo.id,
      input.workspace.id,
      input.operationId,
      parseOptionalHookOutput(result.stdout),
    );
    return true;
  }

  if (hook.kind === "command-file") {
    try {
      const result = await runCommandHook(
        commandFileHook(hook.id, hook.filePath, input.event, input.workspace.path, input.config),
        payload,
      );
      input.activity(
        `hook.${input.event}`,
        "hook",
        `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
        input.repo.id,
        input.workspace.id,
        input.operationId,
        parseOptionalHookOutput(result.stdout),
      );
    } catch (error) {
      input.activity(
        `hook.${input.event}.failed`,
        "hook",
        `Hook ${hook.id} failed: ${describeError(error)}`,
        input.repo.id,
        input.workspace.id,
        input.operationId,
      );
      if (SH_BLOCKING_EVENTS.has(input.event)) throw error;
    }
    return true;
  }

  // agent-file — fire-and-forget after launch (createAgentSession resolves
  // after the initial prompt has been delivered, so a synchronous launch
  // failure surfaces here as a rejection). `.agent` hooks are never blocking
  // (frontmatter `blocking` is reserved); dispatcher rejections log
  // hook.<event>.failed and the runner continues.
  try {
    await dispatchAgentFileHook(hook, payload, input);
  } catch (error) {
    input.activity(
      `hook.${input.event}.failed`,
      "hook",
      `Hook ${hook.id} failed: ${describeError(error)}`,
      input.repo.id,
      input.workspace.id,
      input.operationId,
    );
  }
  return true;
}

async function runOneNotification(
  hook: DiscoveredHook,
  input: {
    config: RunnerConfig | undefined;
    activity: ActivityFn;
    event: HookEvent;
    repo: Repo;
    workspace: Workspace;
    operationId: string | null;
    payload: unknown;
    dispatchAgentHook: DispatchAgentHook;
  },
): Promise<boolean> {
  if (hook.kind === "command-config") {
    const result = await runCommandHook(commandHook(hook.hook, input.workspace.path, input.config), {
      event: input.event,
      ...asObject(input.payload),
      operationId: input.operationId,
    });
    input.activity(
      `hook.${input.event}`,
      "hook",
      `Hook ${hook.hook.id} completed${result.stderr ? " with stderr" : ""}`,
      input.repo.id,
      input.workspace.id,
      input.operationId,
      parseOptionalHookOutput(result.stdout),
    );
    return true;
  }

  if (hook.kind === "command-file") {
    const result = await runCommandHook(
      commandFileHook(hook.id, hook.filePath, input.event, input.workspace.path, input.config),
      { event: input.event, ...asObject(input.payload), operationId: input.operationId },
    );
    input.activity(
      `hook.${input.event}`,
      "hook",
      `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
      input.repo.id,
      input.workspace.id,
      input.operationId,
      parseOptionalHookOutput(result.stdout),
    );
    return true;
  }

  // agent-file dispatch path (note: discovery rejects .agent under
  // agent.started/, so this only fires for other notification events). The
  // outer runNotificationHooks try/catch handles any dispatcher rejection.
  await dispatchAgentFileHook(
    hook,
    { event: input.event, ...asObject(input.payload), operationId: input.operationId },
    input,
  );
  return true;
}

function describeHookId(hook: DiscoveredHook): string {
  return hook.kind === "command-config" ? hook.hook.id : hook.id;
}

// Shared agent-file dispatch path used by both runOne (workspace hooks) and
// runOneNotification. The two paths differ only in templateContext shape and
// in whether the caller wraps in a try/catch (workspace hooks log a failed
// activity on dispatcher rejection; notification hooks let the outer
// runNotificationHooks try/catch handle it).
async function dispatchAgentFileHook(
  hook: Extract<DiscoveredHook, { kind: "agent-file" }>,
  templateContext: Record<string, unknown>,
  input: {
    activity: ActivityFn;
    event: HookEvent;
    repo: Repo;
    workspace: Workspace;
    operationId: string | null;
    dispatchAgentHook: DispatchAgentHook;
  },
): Promise<void> {
  const renderedPrompt = renderTemplate(hook.body, templateContext);
  const launched = await input.dispatchAgentHook({
    workspace: input.workspace,
    repo: input.repo,
    ...(hook.meta.runtime !== undefined ? { runtimeId: hook.meta.runtime } : {}),
    ...(hook.meta.displayName !== undefined ? { displayName: hook.meta.displayName } : {}),
    prompt: renderedPrompt,
    operationId: input.operationId,
    hookId: hook.id,
    event: input.event,
  });
  input.activity(
    `hook.${input.event}`,
    "hook",
    `Hook ${hook.id} launched agent session ${launched.sessionId}${hook.meta.runtime ? ` (runtime=${hook.meta.runtime})` : ""}`,
    input.repo.id,
    input.workspace.id,
    input.operationId,
  );
}

function workspaceHookPayload(input: {
  event: HookEvent;
  repo: Repo;
  workspace: Workspace;
  operationId: string | null;
  payload?: unknown;
}): Record<string, unknown> {
  return {
    ...asObject(input.payload),
    event: input.event,
    repo: input.repo,
    workspace: input.workspace,
    operationId: input.operationId,
  };
}
