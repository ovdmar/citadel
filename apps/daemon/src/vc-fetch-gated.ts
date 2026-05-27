import { execFileSync } from "node:child_process";
import type { PullRequestSummary, Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { CollectGitHubVersionControlSummaryDeps } from "@citadel/providers";
import { type ProviderCache, peekProviderValue } from "./app-helpers.js";
import { buildVersionControlProviderDeps } from "./gh-quota-wiring.js";
import type { GhScheduler, SchedulerKey } from "./gh-scheduler.js";
import { makeKey } from "./gh-scheduler.js";
import {
  getInflight,
  globalPrCacheKey,
  globalPrCacheKeyForWorkspace,
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
};

export const VC_CACHE_TTL_MS = 90_000;

export async function fetchVersionControlGated(
  deps: GatedVcFetchDeps,
  workspace: Workspace,
  repo: Repo,
  cacheKey: string,
): Promise<VersionControlSummary> {
  const snapshot = deps.store.getWorkspacePrSnapshot(workspace.id);
  const repoFullName = snapshot?.prNumber != null ? deps.resolveRepoFullName(repo.id) : null;
  const key: SchedulerKey | null = snapshot?.prNumber && repoFullName ? makeKey(repoFullName, snapshot.prNumber) : null;
  const globalKey = globalPrCacheKeyForWorkspace(workspace, {
    resolveRepoFullName: deps.resolveRepoFullName,
    getSnapshot: (workspaceId) => deps.store.getWorkspacePrSnapshot(workspaceId),
  });

  if (globalKey) {
    const cachedPr = readGlobalPrSummary(deps.providerCache, globalKey);
    if (cachedPr && isCurrentHead(workspace.path, cachedPr))
      return synthesizeVcFromGlobalCache(workspace.path, cachedPr);
    const inflight = getInflight(globalKey);
    if (inflight) {
      try {
        const pr = await inflight;
        if (isCurrentHead(workspace.path, pr)) return synthesizeVcFromGlobalCache(workspace.path, pr);
      } catch {
        // The original fetch path will surface the provider result; this caller
        // falls through to its normal scheduler/cache path.
      }
    }
  }

  // shouldRefetch:false + cache-hit → serve cache without spawning gh.
  if (key) {
    const decision = deps.scheduler.shouldRefetch(key);
    if (!decision.fetch) {
      const cached = peekProviderValue<VersionControlSummary>(deps.providerCache, cacheKey);
      if (cached) return cached;
      // Cache empty (TTL elapsed, restart, etc.) — fall through and fetch.
    }
  }

  const inflightDeferred = globalKey ? deferred<PullRequestSummary>() : null;
  try {
    if (globalKey && inflightDeferred) {
      registerInflight(globalKey, inflightDeferred.promise);
    }
    const vc = await deps.cachedProvider(
      cacheKey,
      () =>
        deps.collectVc(
          workspace.path,
          buildVersionControlProviderDeps(deps.providerCache, () => deps.resolveRepoFullName(repo.id)),
        ),
      VC_CACHE_TTL_MS,
    );
    if (vc.status === "healthy" && vc.pullRequest) {
      inflightDeferred?.resolve(vc.pullRequest);
    } else {
      inflightDeferred?.reject(new Error(vc.reason ?? "vc fetch had no PR"));
    }
    recordVcOutcome(deps, workspace, repo, vc, key, repoFullName);
    return vc;
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
): void {
  // Non-healthy responses → error path for the scheduler (auth wobble,
  // network blip; rate-limit already short-circuited inside gh()). Without
  // a PR we can't key the scheduler, so just skip persisting.
  if (vc.status !== "healthy" || !vc.pullRequest) {
    if (priorKey && vc.status !== "healthy") {
      deps.scheduler.recordFetchError(priorKey, new Error(vc.reason ?? "vc fetch degraded"));
    }
    return;
  }
  // First-fetch case: snapshot had no PR yet; resolve the repo full name
  // now and build a fresh key.
  const pr: PullRequestSummary = vc.pullRequest;
  const repoFullName = priorRepoFullName ?? deps.resolveRepoFullName(repo.id);
  if (!repoFullName) return; // can't key the scheduler without a full name
  const key = makeKey(repoFullName, pr.number);
  deps.scheduler.recordFetch(key, pr, workspace.id);
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
  deps.store.updateWorkspacePrSnapshot(workspace.id, {
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
  const localHead = gitOptional(workspacePath, ["rev-parse", "HEAD"]);
  if (!localHead || !pr.headSha) return true;
  return localHead === pr.headSha;
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

function gitOptional(rootPath: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: rootPath, timeout: 3000, encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}
