import type { CitadelConfig, HookConfig } from "@citadel/config";
import type { ActivityEvent, HookOutput, Repo, Workspace } from "@citadel/contracts";
import { parseHookOutput, runCommandHook } from "@citadel/hooks";
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
  event: HookConfig["event"];
  hookIds: string[];
  repo: Repo;
  workspace: Workspace;
  operationId: string;
}): Promise<void> {
  const hooks = (input.config?.hooks ?? []).filter(
    (hook) => hook.event === input.event && input.hookIds.includes(hook.id),
  );
  for (const hook of hooks) {
    const result = await runCommandHook(commandHook(hook, input.workspace.path, input.config), {
      event: input.event,
      repo: input.repo,
      workspace: input.workspace,
      operationId: input.operationId,
    });
    input.activity(
      `hook.${input.event}`,
      "hook",
      `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
      input.repo.id,
      input.workspace.id,
      input.operationId,
      parseOptionalHookOutput(result.stdout),
    );
  }
}

export async function runNotificationHooks(input: {
  config: RunnerConfig | undefined;
  activity: ActivityFn;
  event: HookConfig["event"];
  repo: Repo;
  workspace: Workspace;
  operationId: string | null;
  payload: unknown;
}): Promise<void> {
  const hooks = (input.config?.hooks ?? []).filter((hook) => hook.event === input.event);
  for (const hook of hooks) {
    try {
      const result = await runCommandHook(commandHook(hook, input.workspace.path, input.config), {
        event: input.event,
        ...asObject(input.payload),
        operationId: input.operationId,
      });
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
        `Hook ${hook.id} failed: ${error instanceof Error ? error.message : "hook_failed"}`,
        input.repo.id,
        input.workspace.id,
        input.operationId,
      );
    }
  }
}
