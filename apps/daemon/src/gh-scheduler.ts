import type { PullRequestSummary } from "@citadel/contracts";

// Per-PR adaptive polling scheduler. Decides whether the cockpit's poll-driven
// request should actually call gh, or be served from cache/snapshot. Keyed by
// `${repoFullName}#${prNumber}` so two workspaces tracking the same PR share
// one cadence (and one rate-limit budget).
//
// The scheduler does NOT spawn its own loop — it's consulted on each request
// from pr-routes. That keeps the model lazy and means a "no viewers" sleep is
// genuinely zero-cost (no setInterval ticking in the background).
//
// State hydrates from SQLite on boot via hydrate(); a successful recordFetch
// is the trigger for the daemon to persist the snapshot back to SQLite. The
// scheduler itself does not write to the database — pr-routes owns that.

export type SchedulerKey = `${string}#${number}`;

export type PrSchedulerEntry = {
  workspaceIds: Set<string>;
  repoFullName: string;
  prNumber: number;
  state: "open" | "closed" | "merged";
  lastHeadSha: string | null;
  lastHeadShaChangedAt: number | null;
  lastChecksConclusion: "green" | "pending" | "failing" | "unknown";
  lastMergeable: "mergeable" | "conflicting" | "unknown";
  lastMergeStateStatus: string | null;
  lastFetchAt: number;
  nextEligibleAt: number;
  needsMergeStateRefresh: boolean;
  consecutiveErrors: number;
};

export type ShouldRefetchReason =
  | "merged"
  | "closed"
  | "conflicting"
  | "cooldown"
  | "no-viewers"
  | "not-due"
  | "backoff";

export type ShouldRefetchResult = { fetch: true } | { fetch: false; reason: ShouldRefetchReason };

export type HydrateRow = {
  workspaceId: string;
  repoFullName: string;
  prNumber: number;
  prState: "open" | "closed" | "merged";
  lastHeadSha: string | null;
  lastHeadShaChangedAt: string | null;
  lastChecksGreenAt: string | null;
  lastMergeStateStatus: string | null;
};

export type GhSchedulerDeps = {
  hasViewers: () => boolean;
  msSinceLastViewer: () => number;
  getGhCooldown: () => { until: number } | null;
  now?: () => number;
};

export type GhScheduler = {
  shouldRefetch(key: SchedulerKey, opts?: { force?: boolean | undefined }): ShouldRefetchResult;
  recordFetch(key: SchedulerKey, summary: PullRequestSummary, workspaceId: string): void;
  recordFetchError(key: SchedulerKey, error: unknown): void;
  markRepoMainMoved(repoFullName: string): void;
  evict(workspaceId: string): void;
  invalidateNotDue(): void;
  hydrate(rows: HydrateRow[]): void;
  // Test seam — never read from production code.
  _entries(): ReadonlyMap<SchedulerKey, PrSchedulerEntry>;
};

// Cadence constants — tuned per the AC and re-derived in the plan.
const CADENCE_DEFAULT_MS = 60_000;
const CADENCE_PENDING_MS = 60_000;
const CADENCE_STABLE_REVIEW_MS = 10 * 60_000;
// Viewer grace: 2 minutes between last viewer detach and the daemon entering
// no-viewers skip mode. Brief tab reloads don't trip it.
export const GH_VIEWER_GRACE_MS = 2 * 60_000;
// Exponential backoff for non-rate-limit errors (auth wobble, network blip,
// gh subprocess crash). 60s * 2^n capped at 5min so we don't burn quota on a
// broken-auth loop while the cooldown gate (above) handles the rate-limit
// case.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const BACKOFF_MAX_SHIFT = 4; // 60s, 120s, 240s, 480s (clamped to 300s)

export function createGhScheduler(deps: GhSchedulerDeps): GhScheduler {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<SchedulerKey, PrSchedulerEntry>();

  function classifyChecks(summary: PullRequestSummary): PrSchedulerEntry["lastChecksConclusion"] {
    const checks = summary.checks ?? [];
    if (checks.length === 0) return "unknown";
    let anyFailing = false;
    let anyPending = false;
    for (const check of checks) {
      const status = (check.status ?? "").toLowerCase();
      const conclusion = (check.conclusion ?? "").toLowerCase();
      if (conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out") {
        anyFailing = true;
        continue;
      }
      if (status === "in_progress" || status === "queued" || status === "pending" || conclusion === "") {
        anyPending = true;
      }
    }
    if (anyFailing) return "failing";
    if (anyPending) return "pending";
    return "green";
  }

  function computeNextEligibleAt(entry: PrSchedulerEntry, atMs: number): number {
    if (entry.state === "merged") return Number.POSITIVE_INFINITY;
    if (entry.state === "closed") return Number.POSITIVE_INFINITY;
    if (entry.lastMergeable === "conflicting" || entry.lastMergeStateStatus === "DIRTY")
      return Number.POSITIVE_INFINITY;
    if (entry.lastChecksConclusion === "green") return atMs + CADENCE_STABLE_REVIEW_MS;
    if (entry.lastChecksConclusion === "pending") return atMs + CADENCE_PENDING_MS;
    return atMs + CADENCE_DEFAULT_MS;
  }

  function shouldRefetch(key: SchedulerKey, opts: { force?: boolean | undefined } = {}): ShouldRefetchResult {
    // Precedence: cooldown > no-viewers > merged > backoff > not-due > force.
    // The order is documented in the plan; cooldown wins because it's the
    // most actionable signal for the operator.
    if (deps.getGhCooldown()) return { fetch: false, reason: "cooldown" };
    if (!deps.hasViewers() && deps.msSinceLastViewer() > GH_VIEWER_GRACE_MS) {
      return { fetch: false, reason: "no-viewers" };
    }
    const entry = entries.get(key);
    if (!entry) return { fetch: true };
    if (entry.state === "merged") return { fetch: false, reason: "merged" };
    if (entry.state === "closed") return { fetch: false, reason: "closed" };
    if (entry.lastMergeable === "conflicting" || entry.lastMergeStateStatus === "DIRTY")
      return { fetch: false, reason: "conflicting" };
    if (entry.needsMergeStateRefresh) return { fetch: true };
    if (opts.force) return { fetch: true };
    if (entry.consecutiveErrors > 0 && now() < entry.nextEligibleAt) {
      return { fetch: false, reason: "backoff" };
    }
    if (now() < entry.nextEligibleAt) return { fetch: false, reason: "not-due" };
    return { fetch: true };
  }

  function recordFetch(key: SchedulerKey, summary: PullRequestSummary, workspaceId: string): void {
    const at = now();
    const upstreamState = mapPrState(summary.state);
    const newSha = summary.headSha ?? null;
    const checks = classifyChecks(summary);
    const existing = entries.get(key);
    const lastHeadShaChangedAt = existing && existing.lastHeadSha === newSha ? existing.lastHeadShaChangedAt : at;
    const repoFullName = repoFullNameFromKey(key);
    const prNumber = prNumberFromKey(key);
    const workspaceIds = existing?.workspaceIds ?? new Set<string>();
    workspaceIds.add(workspaceId);
    const next: PrSchedulerEntry = {
      workspaceIds,
      repoFullName,
      prNumber,
      state: upstreamState,
      lastHeadSha: newSha,
      lastHeadShaChangedAt,
      lastChecksConclusion: checks,
      lastMergeable: summary.mergeable ?? "unknown",
      lastMergeStateStatus: summary.mergeStateStatus ?? null,
      lastFetchAt: at,
      nextEligibleAt: 0,
      needsMergeStateRefresh: false,
      consecutiveErrors: 0,
    };
    next.nextEligibleAt = computeNextEligibleAt(next, at);
    entries.set(key, next);
  }

  function recordFetchError(key: SchedulerKey, _error: unknown): void {
    const at = now();
    const existing = entries.get(key);
    if (!existing) {
      // Error on first fetch — install a sentinel entry so we back off
      // instead of retrying immediately.
      const repoFullName = repoFullNameFromKey(key);
      const prNumber = prNumberFromKey(key);
      entries.set(key, {
        workspaceIds: new Set<string>(),
        repoFullName,
        prNumber,
        state: "open",
        lastHeadSha: null,
        lastHeadShaChangedAt: null,
        lastChecksConclusion: "unknown",
        lastMergeable: "unknown",
        lastMergeStateStatus: null,
        lastFetchAt: at,
        nextEligibleAt: at + BACKOFF_BASE_MS,
        needsMergeStateRefresh: false,
        consecutiveErrors: 1,
      });
      return;
    }
    const consecutiveErrors = existing.consecutiveErrors + 1;
    const shift = Math.min(consecutiveErrors - 1, BACKOFF_MAX_SHIFT);
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** shift, BACKOFF_CAP_MS);
    entries.set(key, {
      ...existing,
      consecutiveErrors,
      lastFetchAt: at,
      nextEligibleAt: at + backoffMs,
    });
  }

  function markRepoMainMoved(repoFullName: string): void {
    for (const entry of entries.values()) {
      const terminal = entry.state === "merged" || entry.state === "closed";
      const conflicting = entry.lastMergeable === "conflicting" || entry.lastMergeStateStatus === "DIRTY";
      if (entry.repoFullName === repoFullName && !terminal && !conflicting) {
        entry.needsMergeStateRefresh = true;
      }
    }
  }

  function evict(workspaceId: string): void {
    for (const [key, entry] of entries.entries()) {
      if (entry.workspaceIds.delete(workspaceId) && entry.workspaceIds.size === 0) {
        entries.delete(key);
      }
    }
  }

  function invalidateNotDue(): void {
    // First viewer attached after an idle window — fetch fresh on the next
    // tick for everything that isn't terminal-state. Cooldown gate still
    // applies; this just clears the cadence wait.
    for (const entry of entries.values()) {
      if (entry.state !== "merged") {
        entry.nextEligibleAt = 0;
      }
    }
  }

  function hydrate(rows: HydrateRow[]): void {
    for (const row of rows) {
      const key = makeKey(row.repoFullName, row.prNumber);
      const lastHeadShaChangedAt = row.lastHeadShaChangedAt ? Date.parse(row.lastHeadShaChangedAt) : null;
      // Without per-check rollup data in the snapshot, infer the conclusion
      // from lastChecksGreenAt: present → green, absent → unknown. The next
      // successful recordFetch refines it.
      const lastChecksConclusion: PrSchedulerEntry["lastChecksConclusion"] = row.lastChecksGreenAt
        ? "green"
        : "unknown";
      const existing = entries.get(key);
      const workspaceIds = existing?.workspaceIds ?? new Set<string>();
      workspaceIds.add(row.workspaceId);
      entries.set(key, {
        workspaceIds,
        repoFullName: row.repoFullName,
        prNumber: row.prNumber,
        state: row.prState,
        lastHeadSha: row.lastHeadSha,
        lastHeadShaChangedAt,
        lastChecksConclusion,
        lastMergeable: "unknown",
        lastMergeStateStatus: row.lastMergeStateStatus,
        lastFetchAt: 0,
        // On boot: eligible immediately for non-terminal PRs (operator
        // doesn't wait a full cycle); merged PRs are pinned by their state
        // and never re-fetched.
        nextEligibleAt: row.prState === "merged" ? Number.POSITIVE_INFINITY : 0,
        needsMergeStateRefresh: false,
        consecutiveErrors: 0,
      });
    }
  }

  return {
    shouldRefetch,
    recordFetch,
    recordFetchError,
    markRepoMainMoved,
    evict,
    invalidateNotDue,
    hydrate,
    _entries: () => entries,
  };
}

export function makeKey(repoFullName: string, prNumber: number): SchedulerKey {
  return `${repoFullName}#${prNumber}` as SchedulerKey;
}

function repoFullNameFromKey(key: SchedulerKey): string {
  const idx = key.lastIndexOf("#");
  return idx < 0 ? key : key.slice(0, idx);
}

function prNumberFromKey(key: SchedulerKey): number {
  const idx = key.lastIndexOf("#");
  return idx < 0 ? 0 : Number.parseInt(key.slice(idx + 1), 10);
}

function mapPrState(raw: string): "open" | "closed" | "merged" {
  const upper = raw.toUpperCase();
  if (upper === "MERGED") return "merged";
  if (upper === "CLOSED") return "closed";
  return "open";
}
