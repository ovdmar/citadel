// Background refresh job. Runs on a slow tick (60s default) and refreshes
// per-workspace provider data (PR/CI/Jira) plus per-runtime usage on a
// per-kind cadence — but only within a configurable working-hours window.
//
// Race correctness for the bust/refresh path is owned by
// cachedProviderWithStaleFallback (per-key Symbol token on the cache). This
// module does not need its own token machinery — it writes through
// cache.set(...) which invalidates whatever token the SWR helper might have
// minted for the same key.
//
// One scheduling chokepoint: scheduleProviderRefresh(item). Topic #16 (rate-
// limit-aware backoff) will plug into this single seam.

import type { CitadelConfig } from "@citadel/config";
import type {
  AgentRuntime,
  CiProviderSummary,
  IssueTrackerSummary,
  RuntimeUsageSummary,
  VersionControlSummary,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { GitHubProviderStateService } from "./github-provider-state.js";
import {
  type PersistentProviderCache,
  checkoutVcCacheKey,
  ciCacheKey,
  issueCacheKey,
  resolveUsageRefreshInterval,
  usageCacheKey,
  vcCacheKey,
} from "./provider-cache.js";

export type ProviderRefreshDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  cache: PersistentProviderCache;
  providers: {
    collectGitHubVersionControlSummary: (rootPath: string) => Promise<VersionControlSummary>;
    collectGitHubCiRuns: (rootPath: string) => Promise<CiProviderSummary>;
    collectJiraIssueSummary: (issueKey: string) => Promise<IssueTrackerSummary>;
    collectRuntimeUsage: (input: {
      runtimeId: string;
      command: string;
      args: string[];
    }) => Promise<RuntimeUsageSummary>;
    listRuntimeHealth: () => AgentRuntime[];
  };
  github?: GitHubProviderStateService;
  hasFocusedWindow?: () => boolean;
  now?: () => number;
  tickIntervalMs?: number;
  jitterMaxMs?: number;
};

type RefreshItem =
  | {
      kind: "vc";
      workspaceId: string;
      cacheKey: string;
      ttlMs: number;
      rootPath: string;
      checkoutId?: string | undefined;
    }
  | { kind: "ci"; workspaceId: string; cacheKey: string; ttlMs: number; rootPath: string }
  | { kind: "issue"; issueKey: string; cacheKey: string; ttlMs: number }
  | { kind: "usage"; runtimeId: string; cacheKey: string; ttlMs: number };

export type ProviderRefreshJob = {
  stop: () => void;
  pokeWorkspace: (workspaceId: string) => Promise<void>;
  // Exposed for unit tests so we don't need to advance real timers.
  runTickForTest: () => Promise<void>;
};

const DEFAULT_TICK_MS = 60_000;
const DEFAULT_JITTER_MS = 500;

function listActiveWorkspaceCheckouts(store: SqliteStore, workspaceId: string): WorktreeCheckout[] {
  if (typeof store.listWorkspaceCheckouts !== "function") return [];
  return store.listWorkspaceCheckouts(workspaceId).filter((checkout) => !checkout.archivedAt);
}

export function startProviderRefreshJob(deps: ProviderRefreshDeps): ProviderRefreshJob {
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_MS;
  const jitterMaxMs = deps.jitterMaxMs ?? DEFAULT_JITTER_MS;
  const now = deps.now ?? (() => Date.now());
  let stopped = false;
  let inFlight = 0;
  // The pending queue and running set track refresh items in motion. The
  // single-in-flight invariant is enforced via cacheKey membership in
  // `running` and the cache's own inFlightTokens map (the SWR helper writes
  // through the same map, so live route refreshes don't double-fire).
  const running = new Set<string>();

  function withinWorkingHours(): boolean {
    if (!deps.config.providerRefresh.enabled) return false;
    if (process.env.CITADEL_DISABLE_REFRESH_JOB === "1") return false;
    const { startHour, endHour, weekdaysOnly } = deps.config.providerRefresh.workingHours;
    const date = new Date(now());
    const day = date.getDay();
    if (weekdaysOnly && (day === 0 || day === 6)) return false;
    const hour = date.getHours();
    return hour >= startHour && hour < endHour;
  }

  function isStale(cacheKey: string, ttlMs: number): boolean {
    const entry = deps.cache.get(cacheKey);
    if (!entry) return true;
    if (typeof entry.cachedAt !== "number") return true;
    return now() - entry.cachedAt >= ttlMs;
  }

  function collectItemsForWorkspace(workspace: Workspace): RefreshItem[] {
    const items: RefreshItem[] = [];
    const { prCiMs, jiraMs } = deps.config.providerRefresh.intervals;
    const vcKey = vcCacheKey(workspace.id, workspace.updatedAt);
    const ciKey = ciCacheKey(workspace.id, workspace.updatedAt);
    if (isStale(vcKey, prCiMs)) {
      items.push({ kind: "vc", workspaceId: workspace.id, cacheKey: vcKey, ttlMs: prCiMs, rootPath: workspace.path });
    }
    if (isStale(ciKey, prCiMs)) {
      items.push({ kind: "ci", workspaceId: workspace.id, cacheKey: ciKey, ttlMs: prCiMs, rootPath: workspace.path });
    }
    for (const checkout of listActiveWorkspaceCheckouts(deps.store, workspace.id)) {
      const checkoutVcKey = checkoutVcCacheKey(workspace.id, checkout.id, checkout.updatedAt);
      if (isStale(checkoutVcKey, prCiMs)) {
        items.push({
          kind: "vc",
          workspaceId: workspace.id,
          checkoutId: checkout.id,
          cacheKey: checkoutVcKey,
          ttlMs: prCiMs,
          rootPath: checkout.path,
        });
      }
    }
    if (workspace.issueKey) {
      const key = issueCacheKey(workspace.issueKey);
      if (isStale(key, jiraMs)) {
        items.push({ kind: "issue", issueKey: workspace.issueKey, cacheKey: key, ttlMs: jiraMs });
      }
    }
    return items;
  }

  function collectItemsForRuntime(runtime: AgentRuntime): RefreshItem[] {
    if (deps.hasFocusedWindow && !deps.hasFocusedWindow()) return [];
    if (!runtime.capabilities.supportsUsage) return [];
    if (runtime.health !== "healthy") return [];
    // Provider-id key mirrors runtime-usage-routes.ts so the live route and
    // the background job share cache entries.
    const provider = deps.config.usageProviders.find((p) => p.runtimeId === runtime.id);
    const cacheKey = usageCacheKey(runtime.id, provider?.id);
    const ttlMs = resolveUsageRefreshInterval(provider, deps.config);
    if (!isStale(cacheKey, ttlMs)) return [];
    return [{ kind: "usage", runtimeId: runtime.id, cacheKey, ttlMs }];
  }

  async function executeItem(item: RefreshItem): Promise<void> {
    // TOCTOU re-check: pull the latest workspace / runtime from store/config
    // right before dispatch. Workspace archived since tick start, or runtime
    // health degraded since the last listRuntimeHealth(), means abort.
    if (item.kind === "vc" || item.kind === "ci") {
      const ws = deps.store.listWorkspaces().find((w) => w.id === item.workspaceId);
      if (!ws || ws.archivedAt) return;
      if (item.kind === "vc" && item.checkoutId) {
        const checkout = listActiveWorkspaceCheckouts(deps.store, item.workspaceId).find(
          (c) => c.id === item.checkoutId,
        );
        if (!checkout) return;
        if (deps.github) {
          const repo = deps.store.listRepos().find((r) => r.id === checkout.repoId);
          if (!repo) return;
          await deps.github.fetchCheckoutVersionControl(ws, checkout, repo, item.cacheKey, { intent: "automatic" });
          return;
        }
      }
      if (deps.github) {
        const repo = deps.store.listRepos().find((r) => r.id === ws.repoId);
        if (!repo) return;
        if (item.kind === "vc") {
          await deps.github.fetchVersionControl(ws, repo, item.cacheKey, { intent: "automatic" });
        } else {
          await deps.github.fetchCi(ws, repo, { cacheKey: item.cacheKey, intent: "automatic", ttlMs: item.ttlMs });
        }
        return;
      }
      try {
        const value =
          item.kind === "vc"
            ? await deps.providers.collectGitHubVersionControlSummary(item.rootPath)
            : await deps.providers.collectGitHubCiRuns(item.rootPath);
        deps.cache.set(item.cacheKey, { expiresAt: now() + item.ttlMs, value, cachedAt: now() });
      } catch (error) {
        console.error(
          `[provider-refresh] ${item.kind} ${item.workspaceId} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (item.kind === "issue") {
      try {
        const value = await deps.providers.collectJiraIssueSummary(item.issueKey);
        deps.cache.set(item.cacheKey, { expiresAt: now() + item.ttlMs, value, cachedAt: now() });
      } catch (error) {
        console.error(
          `[provider-refresh] issue ${item.issueKey} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    // item.kind === "usage"
    const runtime = deps.providers.listRuntimeHealth().find((r) => r.id === item.runtimeId);
    if (!runtime || runtime.health !== "healthy") return;
    try {
      const value = await deps.providers.collectRuntimeUsage({
        runtimeId: runtime.id,
        command: runtime.command,
        args: runtime.args,
      });
      deps.cache.set(item.cacheKey, { expiresAt: now() + item.ttlMs, value, cachedAt: now() });
    } catch (error) {
      console.error(
        `[provider-refresh] usage ${item.runtimeId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function scheduleProviderRefresh(item: RefreshItem): Promise<void> {
    if (running.has(item.cacheKey)) return;
    // Wait for global concurrency capacity.
    while (inFlight >= deps.config.providerRefresh.maxConcurrentRefreshes) {
      await new Promise((r) => setTimeout(r, 10));
      if (stopped) return;
    }
    // Optional jitter to avoid thundering herd against a single provider.
    if (jitterMaxMs > 0) {
      await new Promise((r) => setTimeout(r, Math.random() * jitterMaxMs));
    }
    running.add(item.cacheKey);
    inFlight += 1;
    try {
      await executeItem(item);
    } finally {
      inFlight -= 1;
      running.delete(item.cacheKey);
    }
  }

  async function runTick(workspaceFilter?: string): Promise<void> {
    if (stopped) return;
    if (!withinWorkingHours()) return;
    const workspaces = deps.store.listWorkspaces().filter((w) => !w.archivedAt);
    const runtimes = deps.providers.listRuntimeHealth();
    const items: RefreshItem[] = [];
    for (const ws of workspaces) {
      if (workspaceFilter && ws.id !== workspaceFilter) continue;
      items.push(...collectItemsForWorkspace(ws));
    }
    if (!workspaceFilter) {
      for (const runtime of runtimes) {
        items.push(...collectItemsForRuntime(runtime));
      }
    }
    await Promise.all(items.map((item) => scheduleProviderRefresh(item)));
  }

  // Bypass the working-hours gate for direct pokes — the operator-driven
  // focus refresh path is a user-perceived interaction and we want to
  // refresh regardless of the clock.
  async function pokeWorkspace(workspaceId: string): Promise<void> {
    if (stopped) return;
    if (process.env.CITADEL_DISABLE_REFRESH_JOB === "1") return;
    if (!deps.config.providerRefresh.enabled) return;
    const ws = deps.store.listWorkspaces().find((w) => w.id === workspaceId);
    if (!ws || ws.archivedAt) return;
    const items = collectItemsForWorkspace(ws);
    await Promise.all(items.map((item) => scheduleProviderRefresh(item)));
  }

  const timer =
    tickIntervalMs > 0
      ? setInterval(() => {
          void runTick().catch((error) => {
            console.error(`[provider-refresh] tick failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }, tickIntervalMs)
      : null;
  if (timer) timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    pokeWorkspace,
    runTickForTest: () => runTick(),
  };
}
