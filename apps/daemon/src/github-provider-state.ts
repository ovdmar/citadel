import type {
  CheckSummary,
  CiProviderSummary,
  Repo,
  VersionControlSummary,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { WorkspacePrSnapshot } from "@citadel/db";
import type { SqliteStore } from "@citadel/db";
import {
  type CollectGitHubVersionControlSummaryDeps,
  type collectGitHubCiRunLog,
  type collectGitHubCiRuns,
  type collectGitHubVersionControlSummary,
  getGhCooldown,
} from "@citadel/providers";
import {
  AUTOMATED_GH_DISABLED_REASON,
  cachedCiOrDisabled,
  cachedCiOrSkipped,
  disabledVersionControlSummary,
  githubCiCacheKey,
  githubCiSkipReason,
  shouldFetchGithubCi,
} from "./gh-automation.js";
import { buildVersionControlProviderDeps } from "./gh-quota-wiring.js";
import { GH_VIEWER_GRACE_MS, type GhScheduler } from "./gh-scheduler.js";
import type { PersistentProviderCache } from "./provider-cache.js";
import { VC_CACHE_TTL_MS, fetchVersionControlGated } from "./vc-fetch-gated.js";

export type GitHubFetchIntent = "automatic" | "interactive";
type CiRunLogSummary =
  | Awaited<ReturnType<typeof collectGitHubCiRunLog>>
  | {
      providerId: "github-gh";
      status: "unavailable";
      reason: string;
      runId: string;
      truncated: false;
      log: "";
      checkedAt: string;
    };

export type GitHubProviderStateService = {
  fetchVersionControl: (
    workspace: Workspace,
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean },
  ) => Promise<VersionControlSummary>;
  fetchCheckoutVersionControl: (
    workspace: Workspace,
    checkout: WorktreeCheckout,
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean },
  ) => Promise<VersionControlSummary>;
  fetchRepoVersionControl: (
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean },
  ) => Promise<VersionControlSummary>;
  fetchRepoCi: (
    repo: Repo,
    cacheKey: string,
    options?: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean; ttlMs?: number },
  ) => Promise<CiProviderSummary>;
  fetchCi: (
    workspace: Workspace,
    repo: Repo,
    options?: { cacheKey?: string; intent?: GitHubFetchIntent; staleWhileRevalidate?: boolean; ttlMs?: number },
  ) => Promise<CiProviderSummary>;
  fetchCiRunLog: (
    repo: Repo,
    runId: string,
    options?: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean; ttlMs?: number },
  ) => Promise<CiRunLogSummary>;
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
  collectCiRunLog: typeof collectGitHubCiRunLog;
  resolveRepoFullName: (repoId: string) => string | null;
  cachedProvider: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
  cachedProviderSwr: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
  ghAutomationEnabled: boolean;
  hasViewers: () => boolean;
  msSinceLastViewer: () => number;
};

const CI_CACHE_TTL_MS = 5 * 60_000;
const CI_LOG_CACHE_TTL_MS = 5 * 60_000;
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
    cachedProviderSwr: input.cachedProviderSwr,
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
    options: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean } = {},
  ): Promise<VersionControlSummary> {
    const intent = options.intent ?? "interactive";
    const reason = pauseReason(intent);
    if (!input.ghAutomationEnabled) return disabledVersionControlSummary(workspace, repo);
    return fetchVersionControlGated(
      gatedVcDeps,
      workspace,
      repo,
      cacheKey,
      reason
        ? { allowCollect: false, skipReason: reason }
        : { allowCollect: true, force: options.force, staleWhileRevalidate: options.staleWhileRevalidate ?? true },
    );
  }

  async function fetchCheckoutVersionControl(
    workspace: Workspace,
    checkout: WorktreeCheckout,
    repo: Repo,
    cacheKey: string,
    options: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean } = {},
  ): Promise<VersionControlSummary> {
    const reason = pauseReason(options.intent ?? "interactive");
    if (!input.ghAutomationEnabled) return disabledCheckoutVersionControlSummary(checkout, repo);
    const target = workspaceForCheckout(workspace, checkout);
    return fetchVersionControlGated(
      gatedVcDeps,
      target,
      repo,
      cacheKey,
      reason
        ? {
            allowCollect: false,
            skipReason: reason,
            snapshot: checkoutSnapshot(input.store, checkout),
          }
        : {
            allowCollect: true,
            force: options.force,
            staleWhileRevalidate: options.staleWhileRevalidate ?? true,
            snapshot: checkoutSnapshot(input.store, checkout),
            afterFetch: (summary) => updateCheckoutPrBinding(input.store, checkout, summary),
          },
    );
  }

  async function fetchRepoVersionControl(
    repo: Repo,
    cacheKey: string,
    options: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean } = {},
  ): Promise<VersionControlSummary> {
    const reason = pauseReason(options.intent ?? "interactive");
    if (!input.ghAutomationEnabled) return disabledRepoVersionControlSummary(repo);
    if (reason) return cachedRepoVersionControlOrPaused(input.providerCache, cacheKey, repo, reason);
    if (options.force) input.providerCache.delete(cacheKey);
    const providerRead = (options.staleWhileRevalidate ?? true) ? input.cachedProviderSwr : input.cachedProvider;
    return providerRead(
      cacheKey,
      () => input.collectVersionControl(repo.rootPath, providerDepsForRepo(repo.id)),
      VC_CACHE_TTL_MS,
    );
  }

  async function fetchRepoCi(
    repo: Repo,
    cacheKey: string,
    options: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean; ttlMs?: number } = {},
  ): Promise<CiProviderSummary> {
    const reason = pauseReason(options.intent ?? "interactive");
    if (reason) return cachedCiOrDisabled(input.providerCache, cacheKey, reason);
    if (options.force) input.providerCache.delete(cacheKey);
    const providerRead = (options.staleWhileRevalidate ?? true) ? input.cachedProviderSwr : input.cachedProvider;
    return providerRead(cacheKey, () => input.collectCi(repo.rootPath), options.ttlMs ?? 180_000);
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
      return cachedCiOrSkippedFromKeys(cacheKeys, githubCiSkipReason(input.store, workspace) ?? "GitHub CI is cached");
    }
    const ttlMs = options.ttlMs ?? CI_CACHE_TTL_MS;
    const load = () => input.collectCi(workspace.path);
    const value = options.staleWhileRevalidate
      ? await input.cachedProviderSwr<CiProviderSummary>(primaryKey, load, ttlMs)
      : await input.cachedProvider<CiProviderSummary>(primaryKey, load, ttlMs);
    mirrorCiCacheAlias(primaryKey, options.cacheKey, value, ttlMs);
    return value;
  }

  async function fetchCiRunLog(
    repo: Repo,
    runId: string,
    options: { intent?: GitHubFetchIntent; force?: boolean; staleWhileRevalidate?: boolean; ttlMs?: number } = {},
  ): Promise<CiRunLogSummary> {
    const cacheKey = `ci-log:${repo.id}:${runId}`;
    const reason = pauseReason(options.intent ?? "interactive");
    if (reason) return cachedCiRunLogOrPaused(cacheKey, runId, reason);
    if (options.force) input.providerCache.delete(cacheKey);
    const providerRead = (options.staleWhileRevalidate ?? true) ? input.cachedProviderSwr : input.cachedProvider;
    return providerRead(
      cacheKey,
      () => input.collectCiRunLog(repo.rootPath, runId),
      options.ttlMs ?? CI_LOG_CACHE_TTL_MS,
    );
  }

  return {
    fetchVersionControl,
    fetchCheckoutVersionControl,
    fetchRepoVersionControl,
    fetchRepoCi,
    fetchCi,
    fetchCiRunLog,
  };

  function cachedCiOrDisabledFromKeys(keys: string[], reason: string): CiProviderSummary {
    for (const key of keys) {
      const cached = input.providerCache.get(key);
      if (cached) return cached.value as CiProviderSummary;
    }
    return cachedCiOrDisabled(input.providerCache, keys[0] ?? "ci:unavailable", reason);
  }

  function cachedCiOrSkippedFromKeys(keys: string[], reason: string): CiProviderSummary {
    for (const key of keys) {
      const cached = input.providerCache.get(key);
      if (cached) return cached.value as CiProviderSummary;
    }
    return cachedCiOrSkipped(input.providerCache, keys[0] ?? "ci:skipped", reason);
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

  function cachedCiRunLogOrPaused(cacheKey: string, runId: string, reason: string): CiRunLogSummary {
    const cached = input.providerCache.get(cacheKey);
    if (cached) return cached.value as CiRunLogSummary;
    return {
      providerId: "github-gh",
      status: "unavailable",
      reason,
      runId,
      truncated: false,
      log: "",
      checkedAt: new Date().toISOString(),
    };
  }
}

function workspaceForCheckout(workspace: Workspace, checkout: WorktreeCheckout): Workspace {
  return {
    ...workspace,
    repoId: checkout.repoId,
    name: checkout.displayName ?? checkout.name,
    path: checkout.path,
    branch: checkout.branch,
    baseBranch: checkout.baseBranch,
    issueKey: checkout.issue?.key ?? workspace.issueKey,
    issueTitle: checkout.issue?.title ?? workspace.issueTitle,
    issueUrl: checkout.issue?.url ?? workspace.issueUrl,
    updatedAt: checkout.updatedAt,
  };
}

function checkoutSnapshot(store: SqliteStore, checkout: WorktreeCheckout) {
  return {
    read: () => snapshotFromCheckout(store.findWorkspaceCheckout(checkout.id) ?? checkout),
    write: (patch: Partial<WorkspacePrSnapshot>) => updateCheckoutSnapshot(store, checkout, patch),
    schedulerTargetId: checkout.workspaceId,
  };
}

function snapshotFromCheckout(checkout: WorktreeCheckout): WorkspacePrSnapshot | null {
  const pr = checkout.intendedPr;
  if (!pr) return null;
  return {
    prNumber: pr.number ?? null,
    prState: pr.state ?? (pr.number ? "open" : null),
    lastFetchAt: pr.fetchedAt ?? null,
    lastChecksGreenAt: pr.checksGreen && pr.fetchedAt ? pr.fetchedAt : null,
    lastHeadSha: pr.headSha ?? null,
    lastHeadShaChangedAt: null,
    lastMergeStateStatus: pr.mergeStateStatus ?? null,
  };
}

function updateCheckoutSnapshot(
  store: SqliteStore,
  checkout: WorktreeCheckout,
  patch: Partial<WorkspacePrSnapshot>,
): void {
  const current = store.findWorkspaceCheckout(checkout.id) ?? checkout;
  const previous = current.intendedPr;
  if (!previous && Object.keys(patch).length === 0) return;
  const fetchedAt = "lastFetchAt" in patch ? (patch.lastFetchAt ?? null) : (previous?.fetchedAt ?? null);
  const headSha = "lastHeadSha" in patch ? (patch.lastHeadSha ?? null) : (previous?.headSha ?? null);
  const number = "prNumber" in patch ? (patch.prNumber ?? null) : (previous?.number ?? null);
  const checksGreen = "lastChecksGreenAt" in patch ? Boolean(patch.lastChecksGreenAt) : (previous?.checksGreen ?? null);
  const mergeStateStatus =
    "lastMergeStateStatus" in patch ? (patch.lastMergeStateStatus ?? null) : (previous?.mergeStateStatus ?? null);
  store.updateWorkspaceCheckoutPr(checkout.id, {
    provider: previous?.provider ?? "github",
    number,
    url: previous?.url ?? null,
    state: "prState" in patch ? (patch.prState ?? null) : (previous?.state ?? null),
    headSha,
    baseRef: previous?.baseRef ?? checkout.baseBranch,
    fetchedAt,
    checksGreen,
    mergeStateStatus,
    hasConflicts: mergeStateStatus === "DIRTY" ? true : (previous?.hasConflicts ?? null),
  });
}

function updateCheckoutPrBinding(store: SqliteStore, checkout: WorktreeCheckout, summary: VersionControlSummary): void {
  if (summary.status !== "healthy" || !summary.pullRequest) return;
  const pr = summary.pullRequest;
  const fetchedAt = summary.checkedAt || new Date().toISOString();
  store.updateWorkspaceCheckoutPr(checkout.id, {
    provider: "github",
    number: pr.number,
    url: pr.url,
    state: normalizePrState(pr.state),
    headSha: pr.headSha ?? null,
    baseRef: checkout.baseBranch,
    fetchedAt,
    checksGreen: allChecksGreen(pr.checks),
    mergeStateStatus: pr.mergeStateStatus ?? null,
    hasConflicts: pr.mergeable === "conflicting" || pr.mergeStateStatus === "DIRTY",
  });
}

function allChecksGreen(checks: CheckSummary[]): boolean | null {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  return checks.every((check) => {
    const conclusion = (check.conclusion ?? "").toLowerCase();
    return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";
  });
}

function normalizePrState(raw: string | null | undefined): "open" | "closed" | "merged" | null {
  const lower = (raw ?? "").toLowerCase();
  if (lower === "open" || lower === "closed" || lower === "merged") return lower;
  return null;
}

function cachedRepoVersionControlOrPaused(
  cache: PersistentProviderCache,
  cacheKey: string,
  repo: Repo,
  reason: string,
): VersionControlSummary {
  const cached = cache.get(cacheKey);
  if (cached) return cached.value as VersionControlSummary;
  return pausedRepoVersionControlSummary(repo, reason);
}

function disabledRepoVersionControlSummary(repo: Repo): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason: AUTOMATED_GH_DISABLED_REASON,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}

function pausedRepoVersionControlSummary(repo: Repo, reason: string): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
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
