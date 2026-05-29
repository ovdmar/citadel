import type { CitadelConfig, HookConfig } from "@citadel/config";
import type {
  ActivityEvent,
  HookAction,
  HookDiagnostic,
  HookOutput,
  Operation,
  Repo,
  Workspace,
  WorkspaceAppsSummary,
} from "@citadel/contracts";
import { nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { hookDiagnostic, parseHookOutput, runCommandHook, runCommandHookForDiagnostics } from "@citadel/hooks";
import { asObject, withActionHookIds } from "./helpers.js";

// Dependencies the workspace-apps surface needs from OperationService. Pulled
// out as a struct so this file doesn't depend on the OperationService class —
// keeps the main index.ts under the 800-line file-size budget.
export type WorkspaceAppsConfig = {
  hooks: HookConfig[];
  repoDefaults: {
    setupHookIds: string[];
    teardownHookIds: string[];
    appHookIds?: string[];
    actionHookIds?: string[];
  };
  commandPolicy: CitadelConfig["commandPolicy"];
};

export type WorkspaceAppsDeps = {
  store: SqliteStore;
  config: WorkspaceAppsConfig | undefined;
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
    hookOutput?: HookOutput | null,
  ) => void;
  newOperation: (
    type: string,
    status: Operation["status"],
    repoId: string | null,
    workspaceId: string | null,
    progress: number,
    message: string,
  ) => Operation;
};

function configuredHooks(deps: WorkspaceAppsDeps, event: HookConfig["event"], hookIds: string[]) {
  const hooks = (deps.config?.hooks ?? []).filter((hook) => hook.event === event);
  return hookIds.length ? hooks.filter((hook) => hookIds.includes(hook.id)) : hooks;
}

export async function discoverWorkspaceApps(
  deps: WorkspaceAppsDeps,
  input: { repo: Repo; workspace: Workspace; providerContext?: unknown },
): Promise<WorkspaceAppsSummary> {
  const checkedAt = nowIso();
  const hookIds = deps.config?.repoDefaults.appHookIds ?? [];
  const hooks = configuredHooks(deps, "workspace.apps", hookIds);
  const diagnostics: HookDiagnostic[] = [];
  const outputs: HookOutput[] = [];

  for (const hook of hooks) {
    const commandHook = {
      id: hook.id,
      event: hook.event,
      command: hook.command,
      args: hook.args,
      cwd: hook.cwd || input.workspace.path,
      timeoutMs: deps.config?.commandPolicy.hookTimeoutMs ?? 120000,
      blocking: hook.blocking,
    };
    try {
      const result = await runCommandHookForDiagnostics(commandHook, {
        event: "workspace.apps",
        repo: input.repo,
        workspace: input.workspace,
        providerContext: input.providerContext ?? {},
        environment: process.env.NODE_ENV ?? "development",
      });
      const diagnostic = hookDiagnostic({ hook: commandHook, enabled: true, result, lastRunAt: checkedAt });
      diagnostics.push(diagnostic);
      if (diagnostic.structuredPayload) {
        outputs.push(withActionHookIds(diagnostic.structuredPayload, hook.id));
        deps.activity(
          "hook.workspace.apps",
          "hook",
          `Hook ${hook.id} discovered workspace apps/actions`,
          input.repo.id,
          input.workspace.id,
          null,
          diagnostic.structuredPayload,
        );
      } else if (diagnostic.validationErrors.length) {
        deps.activity(
          "hook.workspace.apps.invalid",
          "hook",
          `Hook ${hook.id} returned invalid app/action output`,
          input.repo.id,
          input.workspace.id,
          null,
        );
      }
    } catch (error) {
      diagnostics.push(hookDiagnostic({ hook: commandHook, enabled: true, error, lastRunAt: checkedAt }));
      deps.activity(
        "hook.workspace.apps.failed",
        "hook",
        `Hook ${hook.id} failed: ${error instanceof Error ? error.message : "hook_failed"}`,
        input.repo.id,
        input.workspace.id,
        null,
      );
    }
  }

  return {
    workspaceId: input.workspace.id,
    status: diagnostics.some((diagnostic) => diagnostic.validationStatus === "invalid") ? "degraded" : "healthy",
    reason: diagnostics.length ? null : "No workspace application discovery hooks configured",
    hooks: diagnostics,
    applications: outputs.flatMap((output) => output.applications ?? []),
    links: outputs.flatMap((output) => output.links),
    actions: outputs.flatMap((output) => output.actions),
    checkedAt,
  } satisfies WorkspaceAppsSummary;
}

export async function runWorkspaceAction(
  deps: WorkspaceAppsDeps,
  input: { repo: Repo; workspace: Workspace; action: HookAction },
): Promise<{ operationId: string; status: "succeeded" | "failed" }> {
  const operation = deps.newOperation(
    `workspace.action.${input.action.kind ?? "custom"}`,
    "running",
    input.repo.id,
    input.workspace.id,
    10,
    `Running ${input.action.label}`,
  );
  const hookIds = input.action.hookId ? [input.action.hookId] : (deps.config?.repoDefaults.actionHookIds ?? []);
  const hooks = configuredHooks(deps, "workspace.action", hookIds);
  if (!hooks.length) {
    deps.store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: "No workspace action hooks are configured",
      updatedAt: nowIso(),
    });
    return { operationId: operation.id, status: "failed" };
  }
  try {
    for (const hook of hooks) {
      const result = await runCommandHook(
        {
          id: hook.id,
          event: hook.event,
          command: hook.command,
          args: hook.args,
          cwd: hook.cwd || input.workspace.path,
          timeoutMs: deps.config?.commandPolicy.hookTimeoutMs ?? 120000,
          blocking: hook.blocking,
        },
        {
          event: "workspace.action",
          repo: input.repo,
          workspace: input.workspace,
          action: input.action,
          operationId: operation.id,
        },
      );
      deps.activity(
        "hook.workspace.action",
        "hook",
        `${input.action.label} completed via hook ${hook.id}${result.stderr ? " with stderr" : ""}`,
        input.repo.id,
        input.workspace.id,
        operation.id,
        parseHookOutput(result.stdout),
      );
    }
    deps.store.upsertOperation({
      ...operation,
      status: "succeeded",
      progress: 100,
      message: `${input.action.label} completed`,
      updatedAt: nowIso(),
    });
    return { operationId: operation.id, status: "succeeded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace_action_failed";
    deps.store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: message,
      retriable: true,
      retryInput: { kind: "workspace.action", workspaceId: input.workspace.id, action: input.action },
      updatedAt: nowIso(),
    });
    deps.activity(
      "hook.workspace.action.failed",
      "hook",
      `${input.action.label} failed: ${message}`,
      input.repo.id,
      input.workspace.id,
      operation.id,
    );
    return { operationId: operation.id, status: "failed" };
  }
}
