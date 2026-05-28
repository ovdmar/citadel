// Wires the CI auto-recovery tick into the daemon. Lives in its own file so
// app.ts stays under the 800-line gate.

import type { CitadelConfig } from "@citadel/config";
import type { CiProviderSummary, VersionControlSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type AutoRecoveryMonitorHandle, type OperationService, startAutoRecoveryMonitor } from "@citadel/operations";
import {
  type CollectGitHubVersionControlSummaryDeps,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
} from "@citadel/providers";
import type { ProviderCache } from "./app-helpers.js";
import { parsePositiveInt } from "./app-helpers.js";
import { FIX_CI_PROMPT, decideAutoRecoveryAction } from "./auto-recovery.js";
import { cachedCiOrDisabled, githubCiCacheKey, shouldFetchGithubCi } from "./gh-automation.js";
import type { GhScheduler } from "./gh-scheduler.js";
import { fetchVersionControlGated } from "./vc-fetch-gated.js";

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
  providerCache?: ProviderCache;
  scheduler?: GhScheduler;
  resolveRepoFullName?: (repoId: string) => string | null;
  cachedProvider?: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
};

// Parse env knobs once at startup. Caller may override defaults; the env-var
// surface is documented in specs/B.7 and acts as the operator escape hatch
// until packages/config grows first-class fields.
function readEnvKnobs() {
  const disabled = process.env.CITADEL_AUTO_RECOVERY_DISABLED === "1";
  const idleThresholdMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_IDLE_MS, 5 * 60 * 1000);
  const debounceMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_DEBOUNCE_MS, 30 * 60 * 1000);
  const intervalMs = parsePositiveInt(process.env.CITADEL_AUTO_RECOVERY_INTERVAL_MS, 60 * 1000);
  return { disabled, idleThresholdMs, debounceMs, intervalMs };
}

export function startDaemonAutoRecoveryMonitor(deps: AutoRecoveryWiringDeps): AutoRecoveryMonitorHandle | null {
  const knobs = readEnvKnobs();
  if (knobs.disabled) return null;
  const cachedFetchers = buildCachedAutoRecoveryFetchers(deps);
  return startAutoRecoveryMonitor(
    {
      store: deps.store,
      config: deps.config,
      decide: decideAutoRecoveryAction,
      fetchVersionControl:
        deps.fetchVersionControl ??
        cachedFetchers?.fetchVersionControl ??
        ((workspacePath) => collectGitHubVersionControlSummary(workspacePath)),
      fetchCi: deps.fetchCi ?? cachedFetchers?.fetchCi ?? ((workspacePath) => collectGitHubCiRuns(workspacePath)),
      spawnAutoRecoveryAgent: async ({ workspaceId, runtimeId, prompt }) => {
        const runtime = deps.config.runtimes.find((candidate) => candidate.id === runtimeId);
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
      idleThresholdMs: knobs.idleThresholdMs,
      debounceMs: knobs.debounceMs,
      disabled: knobs.disabled,
      // Conditionally spread — exactOptionalPropertyTypes disallows explicit
      // undefined; omit the key when no predicate is provided so the monitor
      // keeps its prior always-runs behavior.
      ...(deps.shouldRun ? { shouldRun: deps.shouldRun } : {}),
    },
    knobs.intervalMs,
  );
}

function buildCachedAutoRecoveryFetchers(deps: AutoRecoveryWiringDeps): {
  fetchVersionControl: (workspacePath: string) => Promise<VersionControlSummary>;
  fetchCi: (workspacePath: string) => Promise<CiProviderSummary>;
} | null {
  const providerCache = deps.providerCache;
  const scheduler = deps.scheduler;
  const resolveRepoFullName = deps.resolveRepoFullName;
  const cachedProvider = deps.cachedProvider;
  if (!providerCache || !scheduler || !resolveRepoFullName || !cachedProvider) return null;
  const gatedVcDeps = {
    store: deps.store,
    scheduler,
    providerCache,
    collectVc: (path: string, providerDeps?: CollectGitHubVersionControlSummaryDeps) =>
      collectGitHubVersionControlSummary(path, providerDeps),
    resolveRepoFullName,
    cachedProvider,
  };
  const findWorkspaceRepo = (workspacePath: string) => {
    const workspace = deps.store.listWorkspaces().find((candidate) => candidate.path === workspacePath);
    if (!workspace) throw new Error("workspace_not_found");
    const repo = deps.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) throw new Error("repo_not_found");
    return { workspace, repo };
  };
  return {
    fetchVersionControl: (workspacePath) => {
      const { workspace, repo } = findWorkspaceRepo(workspacePath);
      return fetchVersionControlGated(gatedVcDeps, workspace, repo, `vc:${workspace.id}:${workspace.updatedAt}`);
    },
    fetchCi: (workspacePath) => {
      const { workspace, repo } = findWorkspaceRepo(workspacePath);
      const ciKey = githubCiCacheKey(
        workspace,
        repo,
        resolveRepoFullName(repo.id),
        deps.store.getWorkspacePrSnapshot(workspace.id),
      );
      if (!shouldFetchGithubCi(deps.store, workspace)) {
        return Promise.resolve(
          cachedCiOrDisabled(providerCache, ciKey, "GitHub CI is cached until the PR receives a new local commit"),
        );
      }
      return cachedProvider(ciKey, () => collectGitHubCiRuns(workspace.path), 60_000);
    },
  };
}
