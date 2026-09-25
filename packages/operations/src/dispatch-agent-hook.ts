// Free-function form of the .agent hook dispatcher. Pulled out of
// OperationService so it can be unit-tested in isolation — the closure shape
// inside the class threaded createAgentSession + the runtime list together,
// which is hard to exercise without spinning real tmux. The free function
// takes both as plain deps.
//
// Used by OperationService.dispatchAgentHook (in ./index.ts) and exercised
// directly by ./dispatch-agent-hook.test.ts.

import type { AgentRuntimeConfig } from "@citadel/config";
import type { AgentSession, CreateAgentSessionInput, HookEvent, Repo, Workspace } from "@citadel/contracts";

type RuntimeDescriptor = {
  command: string;
  args: string[];
  displayName: string;
  promptArg?: string | null;
  sessionIdArg?: string | null;
  resumeArg?: string | null;
};

type DispatchAgentHookInput = {
  workspace: Workspace;
  repo: Repo;
  runtimeId?: string;
  displayName?: string;
  prompt: string;
  operationId: string | null;
  hookId: string;
  event: HookEvent;
};

type DispatchAgentHookDeps = {
  runtimes: AgentRuntimeConfig[];
  createAgentSession: (input: CreateAgentSessionInput, runtime: RuntimeDescriptor) => Promise<AgentSession>;
};

const DEFAULT_FALLBACK_RUNTIME_ID = "claude-code";

export async function dispatchAgentHook(
  deps: DispatchAgentHookDeps,
  input: DispatchAgentHookInput,
): Promise<{ sessionId: string }> {
  const requestedRuntimeId = input.runtimeId ?? defaultPromptRuntimeId(deps.runtimes);
  const runtime = deps.runtimes.find((candidate) => candidate.id === requestedRuntimeId);
  if (!runtime) throw new Error(`agent_hook_unknown_runtime: ${requestedRuntimeId}`);

  const session = await deps.createAgentSession(
    {
      workspaceId: input.workspace.id,
      runtimeId: runtime.id,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      prompt: input.prompt,
      ...(input.operationId !== null && input.operationId !== undefined ? { operationId: input.operationId } : {}),
    },
    {
      command: runtime.command,
      args: runtime.args ?? [],
      displayName: runtime.displayName,
      ...(runtime.promptArg !== undefined ? { promptArg: runtime.promptArg } : {}),
      ...(runtime.sessionIdArg !== undefined ? { sessionIdArg: runtime.sessionIdArg } : {}),
      ...(runtime.resumeArg !== undefined ? { resumeArg: runtime.resumeArg } : {}),
    },
  );
  return { sessionId: session.id };
}

// Exported for unit tests; not part of the package public API.
export function defaultPromptRuntimeId(runtimes: AgentRuntimeConfig[]): string {
  const candidate = runtimes.find((runtime) => runtime.supportsPrompt);
  return candidate?.id ?? DEFAULT_FALLBACK_RUNTIME_ID;
}

// Build the dispatcher deps OperationService wires up. Exists so the
// fallback-when-runtimes-undefined behavior (and the createAgentSession
// binding) can be unit-tested without spinning real sqlite/tmux.
export function buildDispatchAgentHookDeps(
  config: { agentRuntimes?: AgentRuntimeConfig[] } | undefined,
  createAgentSession: (input: CreateAgentSessionInput, runtime: RuntimeDescriptor) => Promise<AgentSession>,
): DispatchAgentHookDeps {
  return { runtimes: config?.agentRuntimes ?? [], createAgentSession };
}
