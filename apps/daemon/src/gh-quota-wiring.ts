import { execFileSync } from "node:child_process";
import type { VersionControlSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { getGhCooldown } from "@citadel/providers";
import type express from "express";
import { type GhScheduler, createGhScheduler } from "./gh-scheduler.js";
import { type MainWatcherHandle, startMainWatcher } from "./main-watcher.js";

/**
 * Decorate a VersionControlSummary with the current gh cooldown timestamp
 * whenever the daemon's global cooldown is active. Idempotent — returns vc
 * unchanged when there's no cooldown. Used by every pr-routes endpoint AND
 * the cockpit-summary builder so the FE sticky cache + banner see the same
 * signal regardless of code path (fresh fetch / cache fallback / snapshot).
 */
export function decorateWithCooldown(vc: VersionControlSummary): VersionControlSummary {
  const cooldown = getGhCooldown();
  if (!cooldown) return vc;
  return { ...vc, cooldownUntil: new Date(cooldown.until).toISOString() };
}

/**
 * Extract `owner/repo` from a GitHub remote URL. Supports SSH and HTTPS forms:
 *   git@github.com:owner/repo.git    → "owner/repo"
 *   https://github.com/owner/repo.git → "owner/repo"
 *   https://github.com/owner/repo     → "owner/repo"
 * Returns null for non-GitHub URLs or shapes we can't parse — the caller
 * treats null as "skip this repo for scheduler/main-watcher purposes".
 */
export function parseGitHubFullName(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  // SSH form: git@host:path/to/repo.git
  const ssh = trimmed.match(/^git@[^:]+:([^\/]+)\/([^\/]+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  // HTTPS / git form: https://host/path/to/repo[.git]
  const https = trimmed.match(/^https?:\/\/[^\/]+\/([^\/]+)\/([^\/]+?)(?:\.git)?\/?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/**
 * Spawn `git remote get-url <remote>` from a repo's rootPath and parse the
 * GitHub owner/repo from the result. Synchronous because callers (hydrate +
 * each main-watcher tick) expect a sync answer; the underlying git call is
 * a few ms and we cache the result at the call site.
 */
export function resolveRepoFullNameFromGit(rootPath: string, remote: string): string | null {
  try {
    const stdout = execFileSync("git", ["remote", "get-url", remote], {
      cwd: rootPath,
      timeout: 3000,
      encoding: "utf8",
    });
    return parseGitHubFullName(stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve a repo's GitHub full-name (owner/repo) from its stored rows. Used
 * by app.ts to wire into gh-quota-wiring + main-watcher. Caches per-process
 * to avoid spawning git on every resolve call.
 */
export function resolveRepoFullNameFromWorkspaces(repoId: string, store: SqliteStore): string | null {
  const cached = repoFullNameCache.get(repoId);
  if (cached !== undefined) return cached;
  const repo = store.listRepos().find((r) => r.id === repoId);
  if (!repo) {
    repoFullNameCache.set(repoId, null);
    return null;
  }
  const fullName = resolveRepoFullNameFromGit(repo.rootPath, repo.defaultRemote || "origin");
  repoFullNameCache.set(repoId, fullName);
  return fullName;
}

// Per-process cache. Invalidated on repo register/archive via clearRepoFullNameCache.
const repoFullNameCache = new Map<string, string | null>();

export function clearRepoFullNameCache(repoId?: string): void {
  if (repoId === undefined) {
    repoFullNameCache.clear();
    return;
  }
  repoFullNameCache.delete(repoId);
}

// Wires the gh-quota optimization pieces into app.ts. Lives in its own file
// so app.ts stays under the 800-line check:size gate (same pattern as
// auto-recovery-wiring.ts). Owns:
//   - Viewer-gate helpers derived from the SSE client set
//   - gh-scheduler singleton construction
//   - main-watcher start/stop
//   - Optional disable knobs (CITADEL_GH_SCHEDULER_DISABLED,
//     CITADEL_MAIN_WATCHER_DISABLED — the latter consumed by main-watcher
//     itself; the former gates whether we even instantiate the scheduler at
//     all, because shouldRefetch must always return fetch:true when disabled).

export type GhQuotaWiring = {
  scheduler: GhScheduler;
  hasViewers: () => boolean;
  msSinceLastViewer: () => number;
  /**
   * Call from the /events SSE handler AFTER adding the new response to the
   * sseClients set. When the new connection is the very first viewer after
   * an idle period, this clears the scheduler's per-PR cadence wait so the
   * next FE poll fetches fresh — the operator just opened the cockpit and
   * wants up-to-date data, not stale-by-60-seconds cache.
   */
  onViewerAttached: () => void;
  stop: () => void;
};

/** GhQuotaWiring plus the internal-but-needed-by-SSE detach hook. The wiring
 * exposes both; app.ts's /events handler must call onViewerAttached after
 * adding the response to sseClients and onViewerDetached after removing it. */
export type GhQuotaWiringWithDetach = GhQuotaWiring & { onViewerDetached: () => void };

export type WireGhQuotaDeps = {
  sseClients: { size: number };
  store: SqliteStore;
  resolveRepoFullName: (repoId: string) => string | null;
};

export function wireGhQuota(deps: WireGhQuotaDeps): GhQuotaWiringWithDetach {
  // msSinceLastViewer semantics: 0 while at least one client is connected;
  // grows from `lastDetachAt` once the last one disconnects. The first time
  // any client ever attaches, we don't have a "detach" event, so we treat
  // "never had a viewer" as msSinceLastViewer = Infinity (so the no-viewers
  // skip path engages immediately at boot when nobody's listening).
  let lastDetachAt: number | null = null;
  // Track whether we've ever seen a viewer. Before the first attach, treat
  // it like "no viewers and detached at -Infinity" so the daemon doesn't
  // burn quota during the cold-start window before the cockpit opens.
  let everAttached = false;

  const hasViewers = (): boolean => deps.sseClients.size > 0;

  const msSinceLastViewer = (): number => {
    if (hasViewers()) return 0;
    if (!everAttached) return Number.POSITIVE_INFINITY;
    if (lastDetachAt === null) return Number.POSITIVE_INFINITY;
    return Date.now() - lastDetachAt;
  };

  const disabled = process.env.CITADEL_GH_SCHEDULER_DISABLED === "1";
  // When disabled, build a pass-through scheduler that always says "fetch:true"
  // and is a no-op for record/evict/etc. Keeps the wiring uniform.
  const scheduler: GhScheduler = disabled
    ? makePassthroughScheduler()
    : createGhScheduler({
        hasViewers,
        msSinceLastViewer,
        getGhCooldown: () => getGhCooldown(),
      });

  // Hydrate the scheduler from SQLite — picks up persisted PR snapshots so a
  // daemon restart doesn't re-fetch every workspace's PR on first poll. NOOP
  // for disabled scheduler (no entries to populate; passthrough always
  // fetches anyway).
  if (!disabled) {
    const rows = collectHydrateRows(deps.store, deps.resolveRepoFullName);
    if (rows.length > 0) scheduler.hydrate(rows);
  }

  // Main-watcher: per-repo `git ls-remote` once every 3 min to detect when
  // the default branch SHA moves. On change, flips needsMergeStateRefresh on
  // every open PR for the repo so the next scheduler tick refetches
  // mergeStateStatus / mergeable.
  let mainWatcher: MainWatcherHandle | null = null;
  if (!disabled) {
    mainWatcher = startMainWatcher({
      store: deps.store,
      scheduler,
      hasViewers,
      msSinceLastViewer,
      resolveRepoFullName: (repo) => deps.resolveRepoFullName(repo.id),
    });
  }

  // Track previous viewer count so we can detect the 0→1 transition without
  // false-positives on the 2nd/3rd/Nth concurrent attach.
  let prevHadViewers = false;

  const onViewerAttached = (): void => {
    if (!hasViewers()) return; // defensive — caller should add BEFORE calling
    everAttached = true;
    if (!prevHadViewers) {
      // First viewer after idle → clear cadence wait for non-merged PRs.
      // Cooldown gate still applies; we're just removing the "not due yet"
      // brake so the FE's first poll feels live.
      scheduler.invalidateNotDue();
    }
    prevHadViewers = true;
  };

  // Express's /events handler also has a req.on("close") that calls
  // sseClients.delete(res). The wiring there must call onViewerDetached
  // after the delete so we can stamp the lastDetachAt timestamp.
  // (Wired in app.ts via the returned helper on the GhQuotaWiring object;
  // exposed indirectly through the hasViewers/msSinceLastViewer accessors.)
  // We hook the size change via a polling check in onEachEvent below.
  //
  // Simpler: expose a small helper the SSE handler can call on close.
  // We add it to the wiring as an extra property; app.ts must call it from
  // the req.on("close") callback after sseClients.delete(res).
  const onViewerDetached = (): void => {
    if (hasViewers()) {
      // Another viewer is still connected; nothing to mark.
      return;
    }
    lastDetachAt = Date.now();
    prevHadViewers = false;
  };

  // Stash onViewerDetached on the returned object via a wrapper. We don't
  // want to widen the public type with internal-only helpers; instead, the
  // app.ts SSE handler will call onViewerAttached on add and onViewerDetached
  // on close (both expose-side-effectfully through the returned wiring).
  const wiring: GhQuotaWiringWithDetach = {
    scheduler,
    hasViewers,
    msSinceLastViewer,
    onViewerAttached,
    onViewerDetached,
    stop: () => {
      mainWatcher?.stop();
    },
  };
  return wiring;
}

// Pass-through scheduler used when CITADEL_GH_SCHEDULER_DISABLED=1. Always
// fetches; never records; eviction/main-moved are no-ops. Lets the rest of
// the wiring stay uniform without sprinkling "if (scheduler)" guards.
function makePassthroughScheduler(): GhScheduler {
  return {
    shouldRefetch: () => ({ fetch: true }),
    recordFetch: () => {},
    recordFetchError: () => {},
    markRepoMainMoved: () => {},
    evict: () => {},
    invalidateNotDue: () => {},
    hydrate: () => {},
    _entries: () => new Map(),
  };
}

function collectHydrateRows(
  store: SqliteStore,
  resolveRepoFullName: (repoId: string) => string | null,
): import("./gh-scheduler.js").HydrateRow[] {
  const rows: import("./gh-scheduler.js").HydrateRow[] = [];
  for (const ws of store.listWorkspaces()) {
    if (ws.archivedAt) continue;
    const snap = store.getWorkspacePrSnapshot(ws.id);
    if (!snap || snap.prNumber === null || snap.prState === null) continue;
    const repoFullName = resolveRepoFullName(ws.repoId);
    if (!repoFullName) continue;
    rows.push({
      workspaceId: ws.id,
      repoFullName,
      prNumber: snap.prNumber,
      prState: snap.prState,
      lastHeadSha: snap.lastHeadSha,
      lastHeadShaChangedAt: snap.lastHeadShaChangedAt,
      lastChecksGreenAt: snap.lastChecksGreenAt,
      lastMergeStateStatus: snap.lastMergeStateStatus,
    });
  }
  return rows;
}

// Attach helper used by /events. app.ts calls this AFTER adding `res` to
// sseClients; it triggers the 0→1 transition logic. Returns a close callback
// that should be wired into req.on("close") AFTER sseClients.delete(res).
export function wireSseEvent(wiring: GhQuotaWiringWithDetach, _res: express.Response): { onClose: () => void } {
  wiring.onViewerAttached();
  return { onClose: () => wiring.onViewerDetached() };
}
