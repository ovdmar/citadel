import type { PullRequestSummary, Workspace } from "@citadel/contracts";
import type { WorkspacePrSnapshot } from "@citadel/db";
import type { ProviderCache } from "./app-helpers.js";

export type GlobalPrCacheKey = `pr:${string}#${number}`;

const PENDING_TTL_MS = 60_000;
const GREEN_TTL_MS = 10 * 60_000;
const inflight = new Map<GlobalPrCacheKey, Promise<PullRequestSummary>>();

export function globalPrCacheKey(nameWithOwner: string, prNumber: number): GlobalPrCacheKey {
  return `pr:${nameWithOwner}#${prNumber}`;
}

export function globalPrCacheKeyForWorkspace(
  workspace: Workspace,
  deps: {
    resolveRepoFullName: (repoId: string) => string | null;
    getSnapshot: (workspaceId: string) => Pick<WorkspacePrSnapshot, "prNumber"> | null;
  },
): GlobalPrCacheKey | null {
  const snapshot = deps.getSnapshot(workspace.id);
  if (snapshot?.prNumber == null) return null;
  const nameWithOwner = deps.resolveRepoFullName(workspace.repoId);
  if (!nameWithOwner) return null;
  return globalPrCacheKey(nameWithOwner, snapshot.prNumber);
}

export function classifyTtlMs(summary: PullRequestSummary): number {
  const state = summary.state.toLowerCase();
  if (state === "merged") return Number.POSITIVE_INFINITY;
  if (state === "closed") return Number.POSITIVE_INFINITY;
  if (summary.mergeable === "conflicting" || summary.mergeStateStatus === "DIRTY") return Number.POSITIVE_INFINITY;
  if (summary.checks.length > 0 && summary.checks.every(isGreenCheck)) return GREEN_TTL_MS;
  return PENDING_TTL_MS;
}

export function readGlobalPrSummary(cache: ProviderCache, key: GlobalPrCacheKey): PullRequestSummary | null {
  const cached = cache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached.value as PullRequestSummary;
}

export function writeGlobalPrSummary(cache: ProviderCache, key: GlobalPrCacheKey, summary: PullRequestSummary): void {
  const ttlMs = classifyTtlMs(summary);
  cache.set(key, { expiresAt: Date.now() + ttlMs, value: summary });
}

export function bustGlobalPrEntry(cache: ProviderCache, nameWithOwner: string, prNumber: number): void {
  cache.delete(globalPrCacheKey(nameWithOwner, prNumber));
}

export function lookupGlobalPrByBranch(
  cache: ProviderCache,
  nameWithOwner: string,
  headRefName: string,
): PullRequestSummary | null {
  const prefix = `pr:${nameWithOwner}#`;
  const now = Date.now();
  for (const [key, cached] of cache.entries()) {
    if (!key.startsWith(prefix) || cached.expiresAt <= now) continue;
    const summary = cached.value as PullRequestSummary;
    if (summary.headRefName === headRefName) return summary;
  }
  return null;
}

export function getInflight(key: GlobalPrCacheKey): Promise<PullRequestSummary> | null {
  return inflight.get(key) ?? null;
}

export function registerInflight(key: GlobalPrCacheKey, promise: Promise<PullRequestSummary>): void {
  const tracked = promise.finally(() => inflight.delete(key));
  tracked.catch(() => undefined);
  inflight.set(key, tracked);
}

function isGreenCheck(check: PullRequestSummary["checks"][number]): boolean {
  const conclusion = (check.conclusion ?? "").toLowerCase();
  return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";
}
