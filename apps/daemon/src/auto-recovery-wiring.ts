// Wires the CI auto-recovery tick into the daemon. Lives in its own file so
// app.ts stays under the 800-line gate.

import { type CitadelConfig, DEFAULT_FIX_CI_AUTOMATION } from "@citadel/config";
import type { AgentRuntime, CiProviderSummary, VersionControlSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type AutoRecoveryMonitorHandle, type OperationService, startAutoRecoveryMonitor } from "@citadel/operations";
import { listRuntimeHealth } from "@citadel/runtimes";
import { parsePositiveInt } from "./app-helpers.js";
import { FIX_CI_PROMPT, decideAutoRecoveryAction } from "./auto-recovery.js";
import type { GitHubProviderStateService } from "./github-provider-state.js";
import { ciCacheKey, vcCacheKey } from "./provider-cache.js";

export type AutoRecoveryWiringDeps = {
  store: SqliteStore;
  config: CitadelConfig;
  operations: OperationService;
  emit: (event: string, payload: unknown) => void;
  // Optional viewer-gate predicate. When provided, the monitor consults it
  // at the top of every tick and short-circuits when false — wired to the
  // gh-quota viewer-gate so auto-recovery doesn't burn GitHub quota when no
  // cockpit tab is connected.
  shouldRun?: () => boolean;
  fetchVersionControl?: (workspacePath: string) => Promise<VersionControlSummary>;
  fetchCi?: (workspacePath: string) => Promise<CiProviderSummary>;
  github?: GitHubProviderStateService;
};

// Parse env knobs once at startup. Config owns the defaults; env vars remain
// as deployment-level overrides for existing installs.
function readEnvKnobs(config: CitadelConfig) {
  const fixCi = config.automations?.fixCi ?? DEFAULT_FIX_CI_AUTOMATION;
  const disabled = process.env.CITADEL_AUTO_RECOVERY_DISABLED === "1" || !fixCi.enabled;
  const idleThresholdMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_IDLE_MS, fixCi.idleThresholdMs);
  const debounceMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_DEBOUNCE_MS, fixCi.debounceMs);
  const intervalMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_INTERVAL_MS, fixCi.intervalMs);
  return { disabled, idleThresholdMs, debounceMs, intervalMs };
}

export function startDaemonAutoRecoveryMonitor(deps: AutoRecoveryWiringDeps): AutoRecoveryMonitorHandle | null {
  const githubFetchers = deps.github ? buildGitHubStateAutoRecoveryFetchers(deps, deps.github) : null;
  return startAutoRecoveryMonitor(
    {
      store: deps.store,
      config: deps.config,
      decide: decideAutoRecoveryAction,
      fetchVersionControl:
        deps.fetchVersionControl ??
        githubFetchers?.fetchVersionControl ??
        ((workspacePath) => Promise.resolve(unavailableVersionControl(workspacePath))),
      fetchCi:
        deps.fetchCi ?? githubFetchers?.fetchCi ?? ((workspacePath) => Promise.resolve(unavailableCi(workspacePath))),
      spawnAutoRecoveryAgent: async ({ workspaceId, runtimeId, prompt }) => {
        const runtime = deps.config.agentRuntimes.find((candidate) => candidate.id === runtimeId);
        if (!runtime) throw new Error(`runtime_not_found:${runtimeId}`);
        const session = await deps.operations.createAgentSession(
          {
            workspaceId,
            runtimeId: runtime.id,
            displayName: "Fix CI",
            prompt,
          },
          {
            command: runtime.command,
            args: runtime.args,
            displayName: runtime.displayName,
            promptArg: runtime.promptArg ?? null,
            sessionIdArg: runtime.sessionIdArg ?? null,
            resumeArg: runtime.resumeArg ?? null,
          },
          { activitySource: "automatic-rule" },
        );
        deps.emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
        return { id: session.id };
      },
      prompt: FIX_CI_PROMPT,
      readKnobs: () => {
        const knobs = readEnvKnobs(deps.config);
        return {
          idleThresholdMs: knobs.idleThresholdMs,
          debounceMs: knobs.debounceMs,
          disabled: knobs.disabled,
        };
      },
      resolveRuntimeId: () => resolveAutoRecoveryRuntimeId(deps.config),
      idleThresholdMs: readEnvKnobs(deps.config).idleThresholdMs,
      debounceMs: readEnvKnobs(deps.config).debounceMs,
      disabled: readEnvKnobs(deps.config).disabled,
      // Conditionally spread — exactOptionalPropertyTypes disallows explicit
      // undefined; omit the key when no predicate is provided so the monitor
      // keeps its prior always-runs behavior.
      ...(deps.shouldRun ? { shouldRun: deps.shouldRun } : {}),
    },
    () => readEnvKnobs(deps.config).intervalMs,
  );
}

export function resolveAutoRecoveryRuntimeId(
  config: CitadelConfig,
  runtimeHealth: AgentRuntime[] = listRuntimeHealth(config.agentRuntimes),
): string | null {
  const configured = config.automations?.fixCi ?? DEFAULT_FIX_CI_AUTOMATION;
  const ordered = uniqueRuntimeIds([configured.runtimeId, configured.fallbackRuntimeId]);
  const healthById = new Map(runtimeHealth.map((runtime) => [runtime.id, runtime]));
  for (const id of ordered) {
    const runtime = healthById.get(id);
    if (runtime?.health === "healthy" && !isShellCommand(runtime.command)) return id;
  }
  return null;
}

function isShellCommand(command: string): boolean {
  const binary = command.split(/[\\/]/).pop() ?? command;
  return ["bash", "sh", "zsh", "fish"].includes(binary);
}

function uniqueRuntimeIds(ids: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function buildGitHubStateAutoRecoveryFetchers(
  deps: AutoRecoveryWiringDeps,
  github: GitHubProviderStateService,
): {
  fetchVersionControl: (workspacePath: string) => Promise<VersionControlSummary>;
  fetchCi: (workspacePath: string) => Promise<CiProviderSummary>;
} {
  return {
    fetchVersionControl: (workspacePath) => {
      const { workspace, repo } = findWorkspaceRepo(deps.store, workspacePath);
      return github.fetchVersionControl(workspace, repo, vcCacheKey(workspace.id, workspace.updatedAt), {
        intent: "automatic",
      });
    },
    fetchCi: (workspacePath) => {
      const { workspace, repo } = findWorkspaceRepo(deps.store, workspacePath);
      return github.fetchCi(workspace, repo, {
        cacheKey: ciCacheKey(workspace.id, workspace.updatedAt),
        intent: "automatic",
        ttlMs: 60_000,
      });
    },
  };
}

function findWorkspaceRepo(store: SqliteStore, workspacePath: string) {
  const workspace = store.listWorkspaces().find((candidate) => candidate.path === workspacePath);
  if (!workspace) throw new Error("workspace_not_found");
  const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (!repo) throw new Error("repo_not_found");
  return { workspace, repo };
}

function unavailableVersionControl(workspacePath: string): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason: `GitHub state service unavailable for auto-recovery (${workspacePath})`,
    defaultBranch: null,
    currentBranch: null,
    remotes: [],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}

function unavailableCi(workspacePath: string): CiProviderSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason: `GitHub state service unavailable for auto-recovery (${workspacePath})`,
    runs: [],
    checkedAt: new Date().toISOString(),
  };
}
