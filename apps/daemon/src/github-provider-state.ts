import type { CiProviderSummary, Repo, VersionControlSummary, Workspace, WorktreeCheckout } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import {
  type CollectGitHubVersionControlSummaryDeps,
  type collectGitHubCiRuns,
  type collectGitHubVersionControlSummary,
  getGhCooldown,
} from "@citadel/providers";
import {
  AUTOMATED_GH_DISABLED_REASON,
  cachedCiOrDisabled,
  disabledVersionControlSummary,
  githubCiCacheKey,
  shouldFetchGithubCi,
} from "./gh-automation.js";
import { buildVersionControlProviderDeps } from "./gh-quota-wiring.js";
import { GH_VIEWER_GRACE_MS, type GhScheduler } from "./gh-scheduler.js";
import type { PersistentProviderCache } from "./provider-cache.js";
import { VC_CACHE_TTL_MS, fetchVersionControlGated } from "./vc-fetch-gated.js";

export type GitHubFetchIntent = "automatic" | "interactive";

export type GitHubProviderStateService = {
  fetchVersionControl: (
    workspace: Workspace,
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent },
  ) => Promise<VersionControlSummary>;
  fetchCheckoutVersionControl: (
    workspace: Workspace,
    checkout: WorktreeCheckout,
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent },
  ) => Promise<VersionControlSummary>;
  fetchCi: (
    workspace: Workspace,
    repo: Repo,
    options?: { cacheKey?: string; intent?: GitHubFetchIntent; staleWhileRevalidate?: boolean; ttlMs?: number },
  ) => Promise<CiProviderSummary>;
};

export type CreateGitHubProviderStateServiceInput = {
  store: SqliteStore;
  scheduler: GhScheduler;
  providerCache: PersistentProviderCache;
  collectVersionControl: (
    workspacePath: string,
    deps?: CollectGitHubVersionControlSummaryDeps,
  ) => ReturnType<typeof collectGitHubVersionControlSummary>;
  collectCi: typeof collectGitHubCiRuns;
  resolveRepoFullName: (repoId: string) => string | null;
  cachedProvider: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
  cachedProviderSwr: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
  ghAutomationEnabled: boolean;
  hasViewers: () => boolean;
  msSinceLastViewer: () => number;
};

const CI_CACHE_TTL_MS = 60_000;
const NO_VIEWERS_REASON = "GitHub automation is paused while no cockpit tab is connected";

export function createGitHubProviderStateService(
  input: CreateGitHubProviderStateServiceInput,
): GitHubProviderStateService {
  const providerDepsForRepo = (repoId: string) =>
    buildVersionControlProviderDeps(input.providerCache, () => input.resolveRepoFullName(repoId));
  const gatedVcDeps = {
    store: input.store,
    scheduler: input.scheduler,
    providerCache: input.providerCache,
    collectVc: input.collectVersionControl,
    resolveRepoFullName: input.resolveRepoFullName,
    cachedProvider: input.cachedProvider,
  };

  function pauseReason(intent: GitHubFetchIntent): string | null {
    if (!input.ghAutomationEnabled) return AUTOMATED_GH_DISABLED_REASON;
    const cooldown = getGhCooldown();
    if (cooldown) return `GitHub rate-limited; retrying at ${new Date(cooldown.until).toISOString()}`;
    if (intent === "automatic" && !input.hasViewers() && input.msSinceLastViewer() > GH_VIEWER_GRACE_MS) {
      return NO_VIEWERS_REASON;
    }
    return null;
  }

  async function fetchVersionControl(
    workspace: Workspace,
    repo: Repo,
    cacheKey: string,
    options: { intent?: GitHubFetchIntent } = {},
  ): Promise<VersionControlSummary> {
    const intent = options.intent ?? "interactive";
    const reason = pauseReason(intent);
    if (!input.ghAutomationEnabled) return disabledVersionControlSummary(workspace, repo);
    return fetchVersionControlGated(
      gatedVcDeps,
      workspace,
      repo,
      cacheKey,
      reason ? { allowCollect: false, skipReason: reason } : { allowCollect: true },
    );
  }

  async function fetchCheckoutVersionControl(
    workspace: Workspace,
    checkout: WorktreeCheckout,
    repo: Repo,
    cacheKey: string,
    options: { intent?: GitHubFetchIntent } = {},
  ): Promise<VersionControlSummary> {
    const reason = pauseReason(options.intent ?? "interactive");
    if (!input.ghAutomationEnabled) return disabledCheckoutVersionControlSummary(checkout, repo);
    if (reason) {
      const cached = input.providerCache.get(cacheKey)?.value as VersionControlSummary | undefined;
      return cached ?? pausedCheckoutVersionControlSummary(checkout, repo, reason);
    }
    return input.cachedProvider(
      cacheKey,
      () => input.collectVersionControl(checkout.path, providerDepsForRepo(checkout.repoId ?? workspace.repoId)),
      VC_CACHE_TTL_MS,
    );
  }

  async function fetchCi(
    workspace: Workspace,
    repo: Repo,
    options: { cacheKey?: string; intent?: GitHubFetchIntent; staleWhileRevalidate?: boolean; ttlMs?: number } = {},
  ): Promise<CiProviderSummary> {
    const primaryKey = githubCiCacheKey(
      workspace,
      repo,
      input.resolveRepoFullName(repo.id),
      input.store.getWorkspacePrSnapshot(workspace.id),
    );
    const cacheKeys =
      options.cacheKey && options.cacheKey !== primaryKey ? [options.cacheKey, primaryKey] : [primaryKey];
    const reason = pauseReason(options.intent ?? "interactive");
    if (reason) return cachedCiOrDisabledFromKeys(cacheKeys, reason);
    if (!shouldFetchGithubCi(input.store, workspace)) {
      return cachedCiOrDisabledFromKeys(cacheKeys, "GitHub CI is cached until the PR receives a new local commit");
    }
    const ttlMs = options.ttlMs ?? CI_CACHE_TTL_MS;
    const load = () => input.collectCi(workspace.path);
    const value = options.staleWhileRevalidate
      ? await input.cachedProviderSwr<CiProviderSummary>(primaryKey, load, ttlMs)
      : await input.cachedProvider<CiProviderSummary>(primaryKey, load, ttlMs);
    mirrorCiCacheAlias(primaryKey, options.cacheKey, value, ttlMs);
    return value;
  }

  return { fetchVersionControl, fetchCheckoutVersionControl, fetchCi };

  function cachedCiOrDisabledFromKeys(keys: string[], reason: string): CiProviderSummary {
    for (const key of keys) {
      const cached = input.providerCache.get(key);
      if (cached) return cached.value as CiProviderSummary;
    }
    return cachedCiOrDisabled(input.providerCache, keys[0] ?? "ci:unavailable", reason);
  }

  function mirrorCiCacheAlias(
    primaryKey: string,
    aliasKey: string | undefined,
    value: CiProviderSummary,
    ttlMs: number,
  ): void {
    if (!aliasKey || aliasKey === primaryKey) return;
    const primaryEntry = input.providerCache.get(primaryKey);
    if (primaryEntry) {
      input.providerCache.set(aliasKey, { ...primaryEntry });
      return;
    }
    const now = Date.now();
    input.providerCache.set(aliasKey, { expiresAt: now + ttlMs, value, cachedAt: now });
  }
}

function disabledCheckoutVersionControlSummary(checkout: WorktreeCheckout, repo: Repo): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason: AUTOMATED_GH_DISABLED_REASON,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: checkout.branch || null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}

function pausedCheckoutVersionControlSummary(
  checkout: WorktreeCheckout,
  repo: Repo,
  reason: string,
): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: checkout.branch || null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}
