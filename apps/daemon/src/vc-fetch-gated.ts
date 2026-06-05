import { execFileSync } from "node:child_process";
import type { PullRequestSummary, Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore, WorkspacePrSnapshot } from "@citadel/db";
import type { CollectGitHubVersionControlSummaryDeps } from "@citadel/providers";
import type { ProviderCache } from "./app-helpers.js";
import { buildVersionControlProviderDeps } from "./gh-quota-wiring.js";
import type { GhScheduler, SchedulerKey } from "./gh-scheduler.js";
import { makeKey } from "./gh-scheduler.js";
import {
  getInflight,
  globalPrCacheKey,
  readGlobalPrSummary,
  registerInflight,
  writeGlobalPrSummary,
} from "./global-pr-cache.js";

// Scheduler-gated version-control fetch. Wraps the existing cachedProvider
// loop with three things:
//   1. Per-PR cadence consultation — call shouldRefetch before spawning gh.
//      If skipped + cache-hit → serve cached. If skipped + cache-miss → fall
//      through and fetch (can't synthesize a rich VC summary from the
//      snapshot alone; one gh call to repopulate is correct).
//   2. recordFetch / recordFetchError → keep the scheduler's in-memory
//      cadence + backoff state honest.
//   3. updateWorkspacePrSnapshot → persist the v9 PR snapshot so a daemon
//      restart hydrates the scheduler with the right cadence (especially
//      "merged → never re-fetch").
//
// Extracted out of app.ts to keep that file under the 800-line check:size
// gate (same pattern as auto-recovery-wiring.ts / gh-quota-wiring.ts).

export type GatedVcFetchDeps = {
  store: SqliteStore;
  scheduler: GhScheduler;
  providerCache: ProviderCache;
  collectVc: (workspacePath: string, deps?: CollectGitHubVersionControlSummaryDeps) => Promise<VersionControlSummary>;
  resolveRepoFullName: (repoId: string) => string | null;
  cachedProvider: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
  cachedProviderSwr?: <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
};

export const VC_CACHE_TTL_MS = 90_000;

export type FetchVersionControlGatedOptions = {
  allowCollect?: boolean;
  skipReason?: string;
  force?: boolean | undefined;
  staleWhileRevalidate?: boolean;
  snapshot?: {
    read: () => WorkspacePrSnapshot | null;
    write: (patch: Partial<WorkspacePrSnapshot>) => void;
    schedulerTargetId?: string | undefined;
  };
  afterFetch?: (summary: VersionControlSummary) => void;
};

export async function fetchVersionControlGated(
  deps: GatedVcFetchDeps,
  workspace: Workspace,
  repo: Repo,
  cacheKey: string,
  options: FetchVersionControlGatedOptions = {},
): Promise<VersionControlSummary> {
  const snapshotReader = options.snapshot?.read ?? (() => deps.store.getWorkspacePrSnapshot(workspace.id));
  const snapshotWriter =
    options.snapshot?.write ?? ((patch) => deps.store.updateWorkspacePrSnapshot(workspace.id, patch));
  const schedulerTargetId = options.snapshot?.schedulerTargetId ?? workspace.id;
  const snapshot = snapshotReader();
  const snapshotHeadSha = snapshot?.lastHeadSha ?? null;
  const repoFullName = snapshot?.prNumber != null ? deps.resolveRepoFullName(repo.id) : null;
  const key: SchedulerKey | null = snapshot?.prNumber && repoFullName ? makeKey(repoFullName, snapshot.prNumber) : null;
  if (
    !options.force &&
    snapshot &&
    snapshot.prNumber == null &&
    snapshot.lastFetchAt &&
    snapshot.lastHeadSha &&
    headMatches(workspace.path, snapshot.lastHeadSha)
  ) {
    const cached = readAnyProviderValue<VersionControlSummary>(deps.providerCache, cacheKey);
    if (cached) return cached;
    return synthesizeNoPrVcFromSnapshot(workspace, repo, snapshot);
  }
  const localHeadChanged =
    Boolean(snapshotHeadSha) &&
    snapshot?.prState !== "merged" &&
    snapshot?.prState !== "closed" &&
    !headMatches(workspace.path, snapshotHeadSha);
  const globalKey = snapshot?.prNumber && repoFullName ? globalPrCacheKey(repoFullName, snapshot.prNumber) : null;

  if (globalKey && !options.force) {
    const cachedPr = readGlobalPrSummary(deps.providerCache, globalKey);
    if (!localHeadChanged && cachedPr && isCurrentHead(workspace.path, cachedPr))
      return synthesizeVcFromGlobalCache(workspace.path, cachedPr);
    const inflight = getInflight(globalKey);
    if (inflight) {
      try {
        const pr = await inflight;
        if (!localHeadChanged && isCurrentHead(workspace.path, pr))
          return synthesizeVcFromGlobalCache(workspace.path, pr);
      } catch {
        // The original fetch path will surface the provider result; this caller
        // falls through to its normal scheduler/cache path.
      }
    }
  }

  // shouldRefetch:false + cache-hit → serve cache without spawning gh.
  if (key && !localHeadChanged) {
    const decision = deps.scheduler.shouldRefetch(key, { force: options.force });
    if (!decision.fetch) {
      const cached = readAnyProviderValue<VersionControlSummary>(deps.providerCache, cacheKey);
      if (cached) return cached;
      if (snapshot) return synthesizeVcFromSnapshot(workspace.path, repoFullName, snapshot, decision.reason);
    }
  }

  if (options.allowCollect === false) {
    const cached = readAnyProviderValue<VersionControlSummary>(deps.providerCache, cacheKey);
    if (cached) return cached;
    if (snapshot)
      return synthesizeVcFromSnapshot(workspace.path, repoFullName, snapshot, options.skipReason ?? "paused");
    return synthesizePausedVc(workspace, repo, options.skipReason ?? "paused");
  }

  const inflightDeferred = globalKey ? deferred<PullRequestSummary>() : null;
  const providerRead =
    options.staleWhileRevalidate && deps.cachedProviderSwr ? deps.cachedProviderSwr : deps.cachedProvider;
  try {
    if (options.force || localHeadChanged) deps.providerCache.delete(cacheKey);
    if (globalKey && inflightDeferred) {
      registerInflight(globalKey, inflightDeferred.promise);
    }
    return await providerRead(
      cacheKey,
      async () => {
        const vc = await deps.collectVc(
          workspace.path,
          buildVersionControlProviderDeps(deps.providerCache, () => deps.resolveRepoFullName(repo.id)),
        );
        if (vc.status === "healthy" && vc.pullRequest) {
          inflightDeferred?.resolve(vc.pullRequest);
        } else {
          inflightDeferred?.reject(new Error(vc.reason ?? "vc fetch had no PR"));
        }
        recordVcOutcome(deps, workspace, repo, vc, key, repoFullName, snapshotWriter, schedulerTargetId);
        options.afterFetch?.(vc);
        return vc;
      },
      VC_CACHE_TTL_MS,
    );
  } catch (err) {
    inflightDeferred?.reject(err);
    if (key) deps.scheduler.recordFetchError(key, err);
    throw err;
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolveValue: (value: T) => void = () => {};
  let rejectValue: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function recordVcOutcome(
  deps: GatedVcFetchDeps,
  workspace: Workspace,
  repo: Repo,
  vc: VersionControlSummary,
  priorKey: SchedulerKey | null,
  priorRepoFullName: string | null,
  writeSnapshot: (patch: Partial<WorkspacePrSnapshot>) => void,
  schedulerTargetId: string,
): void {
  // Non-healthy responses → error path for the scheduler (auth wobble,
  // network blip; rate-limit already short-circuited inside gh()). Without
  // a PR we can't key the scheduler, so just skip persisting.
  if (vc.status !== "healthy") {
    if (priorKey) deps.scheduler.recordFetchError(priorKey, new Error(vc.reason ?? "vc fetch degraded"));
    return;
  }
  if (!vc.pullRequest) {
    const localHead = gitOptional(workspace.path, ["rev-parse", "HEAD"]) || null;
    writeSnapshot({
      prNumber: null,
      prState: null,
      lastFetchAt: new Date().toISOString(),
      lastChecksGreenAt: null,
      lastHeadSha: localHead,
      lastHeadShaChangedAt: localHead ? new Date().toISOString() : null,
      lastMergeStateStatus: null,
    });
    return;
  }
  // First-fetch case: snapshot had no PR yet; resolve the repo full name
  // now and build a fresh key.
  const pr: PullRequestSummary = vc.pullRequest;
  const repoFullName = priorRepoFullName ?? deps.resolveRepoFullName(repo.id);
  if (!repoFullName) return; // can't key the scheduler without a full name
  const key = makeKey(repoFullName, pr.number);
  deps.scheduler.recordFetch(key, pr, schedulerTargetId);
  writeGlobalPrSummary(deps.providerCache, globalPrCacheKey(repoFullName, pr.number), pr);

  // Persist the snapshot — drives the scheduler.hydrate() path on next
  // daemon boot. lastChecksGreenAt is set iff every check rolls up green,
  // cleared otherwise.
  const allGreen =
    pr.checks.length > 0 &&
    pr.checks.every((check) => {
      const conclusion = (check.conclusion ?? "").toLowerCase();
      return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";
    });
  const nowIso = new Date().toISOString();
  const entryChangedAt = deps.scheduler._entries().get(key)?.lastHeadShaChangedAt ?? null;
  const lastHeadShaChangedAtIso = entryChangedAt != null ? new Date(entryChangedAt).toISOString() : null;
  writeSnapshot({
    prNumber: pr.number,
    prState: (pr.state ?? "open").toLowerCase() as "open" | "closed" | "merged",
    lastFetchAt: nowIso,
    lastChecksGreenAt: allGreen ? nowIso : null,
    lastHeadSha: pr.headSha ?? null,
    lastHeadShaChangedAt: lastHeadShaChangedAtIso,
    lastMergeStateStatus: pr.mergeStateStatus ?? null,
  });
}

function isCurrentHead(workspacePath: string, pr: PullRequestSummary): boolean {
  if (!pr.headSha) return true;
  return headMatches(workspacePath, pr.headSha);
}

function headMatches(workspacePath: string, expectedSha: string | null): boolean {
  const localHead = gitOptional(workspacePath, ["rev-parse", "HEAD"]);
  if (!localHead || !expectedSha) return true;
  return localHead === expectedSha;
}

function readAnyProviderValue<T>(cache: ProviderCache, key: string): T | undefined {
  const cached = cache.get(key);
  return cached ? (cached.value as T) : undefined;
}

export function synthesizeVcFromGlobalCache(workspacePath: string, pr: PullRequestSummary): VersionControlSummary {
  const checkedAt = new Date().toISOString();
  const remotes = gitOptional(workspacePath, ["remote"]);
  const defaultBranch = gitOptional(workspacePath, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).replace(
    /^origin\//,
    "",
  );
  const currentBranch = gitOptional(workspacePath, ["branch", "--show-current"]);
  const localGitHealthy = Boolean(remotes || currentBranch || defaultBranch);
  return {
    providerId: "github-gh",
    status: localGitHealthy ? "healthy" : "degraded",
    reason: localGitHealthy ? null : "local git metadata unavailable",
    defaultBranch: defaultBranch || null,
    currentBranch: currentBranch || null,
    remotes: remotes ? remotes.split("\n").filter(Boolean) : [],
    pullRequest: pr,
    checkedAt,
  };
}

function synthesizeNoPrVcFromSnapshot(
  workspace: Workspace,
  repo: Repo,
  snapshot: WorkspacePrSnapshot,
): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "healthy",
    reason: null,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: workspace.branch || null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: snapshot.lastFetchAt ?? new Date().toISOString(),
  };
}

function synthesizeVcFromSnapshot(
  workspacePath: string,
  repoFullName: string | null,
  snapshot: WorkspacePrSnapshot,
  reason: string,
): VersionControlSummary {
  const prState = (snapshot.prState ?? "open").toUpperCase();
  const prNumber = snapshot.prNumber ?? 0;
  const url = repoFullName && prNumber > 0 ? `https://github.com/${repoFullName}/pull/${prNumber}` : "";
  return {
    ...synthesizeVcFromGlobalCache(workspacePath, {
      number: prNumber,
      title: prNumber > 0 ? `PR #${prNumber}` : "PR snapshot",
      url,
      state: prState,
      draft: false,
      reviewDecision: null,
      checks: [],
      additions: null,
      deletions: null,
      reviewers: [],
      commits: [],
      headRefName: null,
      parentPr: null,
      mergeable: snapshot.lastMergeStateStatus === "DIRTY" ? "conflicting" : "unknown",
      allowedMergeStrategies: [],
      mergeStateStatus: null,
      headSha: snapshot.lastHeadSha,
    }),
    reason: `served from PR snapshot (${reason})`,
  };
}

function synthesizePausedVc(workspace: Workspace, repo: Repo, reason: string): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: workspace.branch || null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}

function gitOptional(rootPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: rootPath, timeout: 3000, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}
