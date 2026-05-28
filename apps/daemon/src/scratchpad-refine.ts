// Shared refine-scratchpad implementation. Resolves prompt + repo + runtime,
// surfaces the degradation matrix (runtime_unavailable / repo_required /
// launch_failed) per the provider-degradation hard gate, runs the agent
// through OperationService.launchAgent, cleans up orphan workspaces on
// failure when the worktree is clean.
//
// Two callers:
//   1) POST /api/scratchpad/refine (HTTP, used by the cockpit's Refine modal).
//   2) `refine_scratchpad` MCP tool handler (used by external agents).
import type { CitadelConfig } from "@citadel/config";
import type { LaunchAgentInput, ProviderHealth } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { listRuntimeHealth } from "@citadel/runtimes";
import { BUILT_IN_REFINE_SCRATCHPAD, getCitadelAction } from "./citadel-actions.js";

export type RefineSuccess = {
  ok: true;
  workspaceId: string;
  sessionId: string | null;
  operationId: string;
  warning?: string;
};
export type RefineFailure = {
  ok: false;
  error: "runtime_unavailable" | "repo_required" | "launch_failed" | "invalid_input";
  detail: string;
  workspaceId?: string;
};
export type RefineResult = RefineSuccess | RefineFailure;

export type RefineInput = {
  repoId?: string;
  repoName?: string;
  prompt?: string;
};

const RUNTIME_ID = "claude-code";
const IN_PROGRESS_TOKEN = "in-progress";

export type RefineDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  providerHealth: () => Promise<ProviderHealth[]>;
};

export async function refineScratchpad(deps: RefineDeps, input: RefineInput): Promise<RefineResult> {
  const { config, store, operations, providerHealth } = deps;

  // 1) Resolve prompt — explicit override, else saved Citadel Action, else
  //    built-in default (which is what the action would have seeded with).
  let prompt = input.prompt;
  if (!prompt) {
    const saved = await getCitadelAction(config.dataDir, BUILT_IN_REFINE_SCRATCHPAD.id);
    prompt = saved?.promptTemplate ?? BUILT_IN_REFINE_SCRATCHPAD.promptTemplate;
  }
  if (!prompt || prompt.trim().length === 0) {
    return { ok: false, error: "invalid_input", detail: "prompt_required" };
  }

  // 2) Runtime check (provider-degradation gate). config.runtimes has the
  //    invocation spec (command/args/promptArg) we need for launchAgent;
  //    listRuntimeHealth() layers PATH-resolution + health on top.
  const runtimeConfig = config.runtimes.find((r) => r.id === RUNTIME_ID);
  if (!runtimeConfig) {
    return {
      ok: false,
      error: "runtime_unavailable",
      detail: `Runtime '${RUNTIME_ID}' is not configured. Add it in Settings → Agent runtimes.`,
    };
  }
  const healthList = listRuntimeHealth(config.runtimes);
  const claudeCode = healthList.find((r) => r.id === RUNTIME_ID);
  if (claudeCode?.health === "unavailable") {
    return {
      ok: false,
      error: "runtime_unavailable",
      detail: claudeCode.healthReason ?? `Runtime '${RUNTIME_ID}' is unavailable.`,
    };
  }

  // 3) Resolve repo — explicit repoId, else repoName lookup, else fall back to
  //    the most-recently-active workspace's repo, else the first registered.
  const repos = store.listRepos();
  let resolvedRepoId: string | undefined;
  if (input.repoId) {
    if (repos.some((r) => r.id === input.repoId)) resolvedRepoId = input.repoId;
  } else if (input.repoName) {
    resolvedRepoId = repos.find((r) => r.name === input.repoName)?.id;
  } else {
    // Pick the most recently active workspace's repo, falling back to the first
    // registered repo. (Workspace activity isn't a precise "last touched" — we
    // just pick the first non-archived workspace's repo as a stable default.)
    const workspaces = store.listWorkspaces().filter((w) => w.lifecycle !== "archived");
    resolvedRepoId = workspaces[0]?.repoId ?? repos[0]?.id;
  }
  if (!resolvedRepoId) {
    return {
      ok: false,
      error: "repo_required",
      detail: "No repository is registered. Register one in Settings first.",
    };
  }

  // 4) Soft warning if the prompt doesn't mention `in-progress` (case-insensitive).
  let warning: string | undefined;
  if (!prompt.toLowerCase().includes(IN_PROGRESS_TOKEN)) {
    warning =
      "Your refine prompt does not mention 'in-progress' — blocks owned by other agents may be modified by the refine agent.";
  }
  // Also surface provider unavailability as a softer warning (not a block; it
  // mirrors how launch_agent behaves today — we don't refuse the launch).
  const providerHealthList = await providerHealth();
  const degraded = providerHealthList.find((p) => p.status === "unavailable");
  if (degraded && !warning) {
    warning = `Provider '${degraded.displayName}' is currently unavailable; the agent may not complete.`;
  }

  // 5) Launch. workspaceName must satisfy the launch input's 80-char limit and
  //    project naming conventions, so we truncate the ISO stamp to minute.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const workspaceName = `refine-scratchpad-${stamp}`;

  const launchInput: LaunchAgentInput = {
    repoId: resolvedRepoId,
    prompt,
    runtimeId: RUNTIME_ID,
    workspaceName,
  };

  try {
    const result = await operations.launchAgent(launchInput, {
      command: runtimeConfig.command,
      args: runtimeConfig.args,
      displayName: runtimeConfig.displayName,
      promptArg: runtimeConfig.promptArg ?? null,
    });
    const out: RefineSuccess = {
      ok: true,
      workspaceId: result.workspaceId,
      sessionId: result.sessionId ?? null,
      operationId: result.operationId,
    };
    if (warning) out.warning = warning;
    return out;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown_error";
    // Best-effort cleanup: if launchAgent created a workspace but the agent
    // start failed, remove the workspace only when the worktree is clean
    // (the workspace-cleanup-safety policy never deletes dirty worktrees).
    // We don't have a direct handle to the partially-created workspace id,
    // so we look it up by the deterministic name we just used.
    const orphan = store.listWorkspaces().find((w) => w.name === workspaceName);
    let leftBehindWorkspaceId: string | undefined;
    if (orphan) {
      try {
        await operations.removeWorkspace({ workspaceId: orphan.id, force: false, archiveOnly: false });
      } catch {
        // Cleanup failed (dirty worktree). Surface the id so the user can
        // clean it up manually from Settings.
        leftBehindWorkspaceId = orphan.id;
      }
    }
    const failure: RefineFailure = { ok: false, error: "launch_failed", detail };
    if (leftBehindWorkspaceId) failure.workspaceId = leftBehindWorkspaceId;
    return failure;
  }
}
