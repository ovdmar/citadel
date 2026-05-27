Activate the /implement-task skill first.

# Plan: gh-quota-optimization

## Acceptance Criteria

User-stated requirements (verbatim from the conversation):

- [ ] P2 — Pause all daemon GH polling when no SSE viewers are connected. Wire `sseClients.size > 0` as a viewer gate; auto-recovery loop, batch summary refetch, and any background gh-touching loops skip ticks when no viewers. On new SSE connect, allow next tick to fetch fresh.
- [ ] P3 — Adaptive per-PR polling cadence (daemon-driven scheduler keyed by `${repo}#${prNumber}`):
  - merged → never poll GitHub again (rely on local branch state)
  - green checks AND `lastHeadShaChangedAt` > 10min ago → 3 min between checks
  - pending checks AND `lastHeadShaChangedAt` < 10min ago → 60s
  - default open → 60s
  - FE just asks; daemon decides whether to refetch or return cache.
- [ ] P3-FE — Bump FE cadence to 60s batch / 30s active.
- [ ] P4 — Bump cache TTLs: `vc:` 10s→60s; `commit-checks:` 60s→adaptive (60s pending, 5min green).
- [ ] P5 — Merge-to-main watcher. Poll `git ls-remote <primaryRemote> refs/heads/<defaultBranch>` (LOCAL git, not gh) once every 3 min per repo. When the main SHA moves, mark all open PRs against that repo as "needs mergeStateStatus refresh" → next per-PR tick refetches `mergeable`/`mergeStateStatus`. Otherwise skip the conflict-check entirely.
- [ ] P6 — Persist per-workspace PR snapshot in SQLite: `prNumber`, `prState`, `lastPrFetchAt`, `lastChecksGreenAt`, `lastHeadSha`, `lastHeadShaChangedAt`, `lastMergeStateStatus`. Survives daemon restart so cooldown UX and the per-PR scheduler don't lose state.
- [ ] Rate-limit cooldown (from P1, already shipped on this branch) is surfaced to the FE distinctly enough that the operator sees "GitHub rate-limited, retrying at HH:MM" instead of a generic "degraded".

## Context and problem statement

GitHub API quota (5 000 REST/hr + 5 000 GraphQL/hr per user) is being exhausted in real usage:

> "gh says could not load events: failed to get current username: GraphQL: API rate limit already exceeded for user ID 15231070."

Current polling footprint per active operator:

| Source | Cadence | gh calls per tick |
|---|---|---|
| FE batch (`/api/workspaces/cockpit-summary/batch`) | 30s, pause-on-hidden | 1 × `gh pr view` + 1 × `gh repo view` + 1 × `gh pr list` per workspace + up to 10 × `gh api /commits/:sha/check-runs` per PR |
| FE active workspace (`/api/workspaces/:id/cockpit-summary`) | 10s | same shape, scoped to one workspace |
| Daemon auto-recovery (`auto-recovery-wiring.ts`) | 60s | `gh pr view` + `gh run list` for every workspace, regardless of viewer presence |
| Provider health (`/api/provider-health`) | 15s cache | `gh auth status` |

**Re-derived quota math (round 1 review correction):** the daemon's existing `vc:` cache key at `pr-routes.ts:107` is `vc:${repo.id}:${repo.updatedAt}` — repo-level, shared across workspaces in the same repo. The workspace-level batch endpoint (`app.ts:369`) keys per workspace. For one operator watching 8 workspaces in 1 repo with 5-commit PRs:
- Repo-level vc: shared once per repo → ~3 gh calls per 30s tick (cached for 10s).
- Per-workspace commit-checks: ~8 × 5 = 40 gh-api calls per tick (cached per sha for 60s — so amortized over the SHA lifetime, but every workspace polls them independently every 30s).
- Real worst-case sustained load: ~40 calls per 30s = ~4 800/hr. Already grazing the 5 000 GraphQL ceiling with zero headroom for any other tab, the auto-recovery loop, or a transient burst.

P1 (already shipped on this branch, in `packages/providers/src/index.ts`) added a 15-minute global cooldown when any gh call returns "rate limit exceeded" — that stops the bleeding once the limit is hit, but doesn't prevent hitting it. P2–P6 cut steady-state load by 5–10× by:

1. Killing all background gh load when the operator has no cockpit tab open (P2).
2. Replacing the "everyone polls everything every 30s" model with a per-PR cadence driven by PR maturity (P3).
3. Caching more aggressively at the daemon (P4).
4. Replacing the implicit "mergeStateStatus on every poll" cost with an explicit "main moved → check now" trigger (P5).
5. Persisting per-workspace PR state so cadence + cooldown UX survive daemon restart (P6).

## Spec alignment

Spec mapping (from `.agents/skills/extensions/review-pr.md` glob table):

| Files touched | Spec(s) |
|---|---|
| `packages/providers/**`, `packages/operations/**` | `specs/B.4-git-pr-ci-diff.md`, `specs/B.6-providers-hooks-config.md`, `specs/B.7-operations-activity-mcp.md` |
| `packages/contracts/**`, `packages/db/**` | `specs/A-shared-definitions.md` + `specs/B.4-git-pr-ci-diff.md` |
| `apps/daemon/**` | `specs/B.1-repositories-workspaces.md`, `specs/B.7-operations-activity-mcp.md` |
| `apps/web/**` | `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md` |

**Discrepancies / spec updates needed (first implementation step):**

1. **B.4 §50 ("PR state … refreshed in the background every ~30 seconds.")** — this hard-codes a global 30s cadence. The new behavior is adaptive per-PR (60s default, 3min when green+old, never when merged). Rewrite §50 to reflect that cadence is daemon-decided and per-PR; the FE just asks at a fast rhythm and the daemon serves cache or fetches.
2. **B.4 §51 ("Background polling pauses when the cockpit tab is hidden")** — extend: also pauses when *no cockpit tab is connected at all* (no SSE viewers), with a 2-min grace window.
3. **B.4 §52** — extend the "skipped to avoid useless gh invocations" list with: merged PRs (never re-polled), workspaces in cooldown (queued, not skipped).
4. **B.4 — new section "GitHub Rate Limiting"** — document the global cooldown (15min), what triggers it, how it surfaces (`versionControl.cooldownUntil`), and that all gh subprocesses short-circuit during cooldown.
5. **B.4 §14-15** — `mergeStateStatus` refresh trigger needs documenting: it's refreshed when (a) the PR's own `headSha` changes, OR (b) the repo's default branch SHA changes (main-watcher), OR (c) the operator clicks force-refresh.
6. **B.6 §7-8** — "Provider degraded state explains missing/stale data" + "Provider data includes refresh age" — the new `cooldownUntil` field is the concrete carrier; no spec text change needed, but worth a one-line example in §8.
7. **B.7 (operations spec)** — document the new optional `shouldRun?: () => boolean` predicate on `AutoRecoveryMonitorOptions` so callers of `@citadel/operations` can pause the loop without disabling it.

## Implementation approach

**Chosen: contract-extension + new in-process scheduler module + new main-watcher module + additive SQLite migration + extracted `gh-quota-wiring.ts` to keep `app.ts` under the 800-line gate.**

Key architectural choices:

1. **No new `ProviderStatusSchema` enum value.** Instead, extend `VersionControlSummary` with `cooldownUntil: string | null` (ISO timestamp, present iff the daemon's gh cooldown is active). Status stays `degraded` during cooldown for backwards compat; FE rendering distinguishes by the structured field. Avoids rippling enum changes through ~6 Zod schemas, the discriminator types, every FE renderer, and the sticky-cache classification table. Same UX outcome (distinct banner with retry-at time) at a fraction of the blast radius. **Verified safe** (round 1): no existing FE consumer reads `versionControl.status === "degraded"` — the apparent matches in `inspector.tsx:130,135` are on `app.status`, in `settings.tsx:397,464` are on `provider.status`. The only cockpit-tools.tsx mention is a code comment in `applyStickyUpdates`.

2. **Scheduler is a singleton in-process module** (`apps/daemon/src/gh-scheduler.ts`), not a separate worker. Holds a Map keyed by `${repoNameWithOwner}#${prNumber}` with `{ state, workspaceIds, lastFetchAt, nextEligibleAt, needsMergeStateRefresh, lastHeadSha, lastChecksConclusion, lastHeadShaChangedAt, consecutiveErrors }`. State hydrates from SQLite on daemon boot (P6) and persists on every transition. Public methods:
   - `shouldRefetch(key, opts?: { force?: boolean }): ShouldRefetchResult`
   - `recordFetch(key, summary, workspaceId)` — updates the snapshot and computes `nextEligibleAt` based on the new state. Adds `workspaceId` to the entry's `workspaceIds` set.
   - `recordFetchError(key, error)` — increments `consecutiveErrors`, extends `nextEligibleAt` exponentially (60s × 2^n, capped at 5 min). Cleared by next successful `recordFetch`.
   - `markRepoMainMoved(repoFullName)`
   - `evict(workspaceId)` — removes workspaceId from every entry's `workspaceIds`; deletes entries whose set becomes empty.
   - `hydrate(rows)`
   - `invalidateNotDue()` — clears `nextEligibleAt` to 0 for all entries (called on SSE first-viewer attach).

3. **Viewer gate is injected**, not globally read. `gh-quota-wiring.ts` exposes `hasViewers()` and `msSinceLastViewer()` derived from `app.ts`'s `sseClients` Set; scheduler + auto-recovery loop receive these as deps. Allows easy testing with mocked viewer state. 2-minute grace window after the last viewer disconnects (so a tab-reload doesn't immediately trigger "no viewers" cooldown).

4. **Main-watcher is a separate module** (`apps/daemon/src/main-watcher.ts`) that ticks every 3 min per repo. Uses `git ls-remote <primaryRemote> refs/heads/<defaultBranch>` — local git command, no gh API cost. Runs from `repo.rootPath` (via `store.listRepos()`); falls back to first available workspace path with a warn log if rootPath is missing. `primaryRemote` is `repo.defaultRemote || "origin"` — the canonical remote stored on the repo row at registration time (RepoSchema field). Fork-style operators who use `upstream` set it during `registerRepo`; non-default values flow through end-to-end (validated by `main-watcher.test.ts` `uses repo.defaultRemote (non-origin supported, e.g., fork workflows)`). On SHA change, calls `scheduler.markRepoMainMoved(repoFullName)`. Skipped entirely when `!hasViewers() && msSinceLastViewer() > 120_000`.

5. **Cache layer (`app-helpers.ts`) stays as-is**; cadence and adaptive TTLs live in pr-routes/scheduler. The bare TTL Map is a primitive; specializing it (per-entry TTL classes) would over-engineer. Just pass different `ttlMs` per call site.

6. **`commit-checks:` cache TTL is adaptive at call site** in `pr-routes.ts:enrichCommitChecks` — query the scheduler's last-known check conclusion for the PR; if `green`, pass `5 * 60_000`; otherwise `60_000`. Keeps the Map cache dumb and the policy local.

7. **Auto-recovery loop gating goes through a contract extension** of `@citadel/operations`. `AutoRecoveryMonitorOptions` gains an optional `shouldRun?: () => boolean` predicate. The monitor consults it at the top of each tick and returns early when it returns false. This is a small additive cross-package contract change (architecture-boundary gate: see hard-gates section below).

8. **`vc:` cache key stays as-is for this plan.** Current key `vc:${workspace.id}:${workspace.updatedAt}` rotates on workspace lifecycle/branch/dirty mutations (not on agent session activity, which lives in a separate table). In steady state, `workspace.updatedAt` is stable for minutes-to-hours, so bumping the TTL from 10s → 60s is effective. Stabilizing the key (dropping `updatedAt`) is tracked as a separate follow-up; risk-bounded since the current key is fail-safe (over-invalidates rather than serves stale data).

## Alternatives considered

1. **Add `"rate_limited"` to `ProviderStatusSchema`.** Rejected: ripples through 6+ Zod schemas, every consumer's TypeScript discriminator, FE rendering branches, and the sticky-cache rule table. The structured `cooldownUntil` field gives the same UX and ships in fewer files. Round-1 verification confirmed no FE consumer of `versionControl.status === "degraded"` exists — the field-only approach is clean.

2. **Use GitHub webhooks for merge-to-main and PR state.** Rejected for v1: requires a public-reachable endpoint or a relay, and Citadel is local-first. The user explicitly framed P5 as "smart polling trigger", not "switch to push". Worth considering when Citadel runs on a shared host.

3. **Single scheduler tick (one setInterval that walks all PRs).** Rejected: each PR's `nextEligibleAt` is independent; a single tick forces a worst-case cadence (the smallest interval) for everyone. Per-PR scheduling via `shouldRefetch` on read keeps the model lazy and avoids a hot loop when no viewers are present.

4. **Persist scheduler state in a new SQLite table (`pr_scheduler_state`) instead of extending `workspaces`.** Rejected: the scheduler key is `repo#pr` but the FE-facing state-of-truth is per-workspace (one workspace = one PR at a time). Storing on `workspaces` keeps the snapshot colocated with the row that surfaces it; the scheduler's in-memory Map is the only thing keyed by `repo#pr` and it's a derived view rebuilt at boot.

5. **Replace the providerCache `Map` with a proper LRU/ETag-aware cache.** Rejected as out-of-scope. The current map plus adaptive TTLs gets us the 5–10× quota reduction the user asked for; deeper rework can wait.

6. **Use a monotonic clock (`performance.now()`) for grace-window and cadence arithmetic.** Rejected: existing daemon (including shipped P1 cooldown's `ghCooldownUntil`) uses `Date.now()` consistently. Introducing one monotonic island creates clock-domain mismatches with cooldown-until comparisons. Backward clock jumps (laptop wake) make grace windows *longer*, which is fail-safe; forward jumps cost one missed tick. Documenting the trade-off in adversarial-analysis is the right call.

7. **Inject the viewer gate into `fetchVersionControl` / `fetchCi` callbacks instead of via `shouldRun`.** Rejected: the auto-recovery monitor still does work outside those callbacks (sentinel checks, agent spawn decisions) — only gating the network calls leaves overhead. The `shouldRun` predicate fully short-circuits the tick.

## Implementation steps

### Step 0 — commit P1 (already done in working tree)

P1 (rate-limit circuit breaker in `packages/providers/src/index.ts` + tests) is already implemented on this branch with passing tests but uncommitted. Commit as `fix(gh): global cooldown circuit breaker on rate-limit detection` before starting P2.

### Step 1 — Specs (B.4 + B.6 + B.7)

- Update `specs/B.4-git-pr-ci-diff.md` §50–52 to reflect adaptive cadence + no-viewer pause (with 2-min grace) + merged-PR skip.
- Add new section `## GitHub Rate Limiting` to `specs/B.4-git-pr-ci-diff.md` documenting the 15min cooldown, what triggers it, and the `versionControl.cooldownUntil` carrier field.
- Update `specs/B.4-git-pr-ci-diff.md` §14–15 to enumerate the three `mergeStateStatus` refresh triggers (PR's headSha changed, repo default-branch SHA moved, force refresh).
- Touch up `specs/B.6-providers-hooks-config.md` §8 with a one-line `cooldownUntil` example.
- Update `specs/B.7-operations-activity-mcp.md` to document the new optional `shouldRun?: () => boolean` predicate on `AutoRecoveryMonitorOptions`.

### Step 2 — Contracts (additive)

- `packages/contracts/src/index.ts`: extend `VersionControlSummarySchema` with `cooldownUntil: z.string().nullable().optional()`. Optional (not required) so older daemon ↔ newer FE remains compatible.
- Rebuild `packages/contracts` dist; nothing else in contracts changes.

### Step 3 — SQLite migration v9 (additive, all nullable)

**Migration strategy:**

| Operation | Classification | Reversibility |
|---|---|---|
| `ALTER TABLE workspaces ADD COLUMN pr_number INTEGER` | Additive | Trivially reversible (DROP COLUMN in v10 if ever needed) |
| `ALTER TABLE workspaces ADD COLUMN pr_state TEXT` | Additive | ↑ |
| `ALTER TABLE workspaces ADD COLUMN pr_last_fetch_at TEXT` | Additive | ↑ |
| `ALTER TABLE workspaces ADD COLUMN pr_last_checks_green_at TEXT` | Additive | ↑ |
| `ALTER TABLE workspaces ADD COLUMN pr_last_head_sha TEXT` | Additive | ↑ |
| `ALTER TABLE workspaces ADD COLUMN pr_last_head_sha_changed_at TEXT` | Additive | ↑ |
| `ALTER TABLE workspaces ADD COLUMN pr_last_merge_state_status TEXT` | Additive | ↑ |
| `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (9, 'workspaces-pr-snapshot', datetime('now'))` | Additive | n/a |

- **Why v9 row** (round-1 clarification): the trailing-ensureColumn convention at `migrate.ts:210` (no version bump for additive columns) was set when those columns were tactical add-ons inside an existing feature. The `agent-sessions-auto-resume-backoff` work at v8 (line 227) precedent shows we DO version-bump when additive columns belong to a new logical feature. The PR-snapshot is a new logical feature: scheduler hydrate, migration tests, and any future tooling will want to assert on a `version=9` row. Adding the row is the right call here.
- Version 9, name `'workspaces-pr-snapshot'`. Monotonically greater than 8 (verified via existing `migrate.ts:195,227`).
- All columns nullable; existing rows read NULL → scheduler treats as "never fetched, eligible now". No data backfill needed.
- `PRAGMA foreign_keys = ON;` remains set (no change to connection setup).
- Operator data: existing local databases run the additive ALTER on startup; first time scheduler reads a workspace, all snapshot fields are NULL → scheduler fetches fresh on first tick. No silent breakage.

Files:
- `packages/db/src/migrate.ts` — add the 7 ensureColumn calls + the v9 INSERT.
- `packages/db/src/index.ts` — add typed read/write methods: `getWorkspacePrSnapshot(id)`, `updateWorkspacePrSnapshot(id, patch)`. Snapshot type covers `prNumber | null`, `prState: "open"|"closed"|"merged"|null`, and the 5 timestamp/SHA fields.

### Step 4 — Persist PR snapshot (P6)

- After every successful `gh pr view` in pr-routes (the batch endpoint + single-workspace endpoint), call `store.updateWorkspacePrSnapshot` with the just-fetched fields including `prState` derived from `pr.state.toLowerCase()`.
- `lastHeadShaChangedAt` is computed by comparing the new `headSha` with the snapshot's `lastHeadSha`; updated only on change.
- `lastChecksGreenAt` is set to `now` iff every check rolls up to a green/successful state; cleared when any check is failing or pending.
- On daemon boot: scheduler hydrates its in-memory Map from `store.listWorkspaces()` rows that have a non-null `pr_number`. **`prState` is used to classify entries immediately on hydrate** so merged PRs are NOT re-fetched on first tick.

### Step 5 — `gh-scheduler.ts` module (P3)

New file: `apps/daemon/src/gh-scheduler.ts`.

```ts
type SchedulerKey = `${string}#${number}`; // "owner/repo#42"

type PrSchedulerEntry = {
  workspaceIds: Set<string>;     // multiple workspaces may share one PR
  repoFullName: string;
  prNumber: number;
  state: "open" | "closed" | "merged";
  lastHeadSha: string | null;
  lastHeadShaChangedAt: number | null;
  lastChecksConclusion: "green" | "pending" | "failing" | "unknown";
  lastFetchAt: number;
  nextEligibleAt: number;
  needsMergeStateRefresh: boolean;
  consecutiveErrors: number;
};

export type ShouldRefetchResult =
  | { fetch: true }
  | { fetch: false; reason: "merged" | "cooldown" | "no-viewers" | "not-due" | "backoff" };

export function createGhScheduler(deps: {
  hasViewers: () => boolean;
  msSinceLastViewer: () => number; // ms since last viewer attach, Infinity if no viewers ever
  getGhCooldown: () => { until: number } | null;
}): {
  shouldRefetch(key: SchedulerKey, opts?: { force?: boolean }): ShouldRefetchResult;
  recordFetch(key: SchedulerKey, summary: PullRequestSummary, workspaceId: string): void;
  recordFetchError(key: SchedulerKey, error: unknown): void;
  markRepoMainMoved(repoFullName: string): void;
  evict(workspaceId: string): void;
  invalidateNotDue(): void;
  hydrate(rows: WorkspaceWithPrSnapshot[]): void;
  _entries(): ReadonlyMap<SchedulerKey, PrSchedulerEntry>; // test seam
};
```

Cadence table (matches AC):

| State | Condition | Cadence |
|---|---|---|
| merged | `summary.state === "MERGED"` | Never re-poll (fetch returns `false`/`"merged"` forever) |
| closed | `summary.state === "CLOSED"` | 5 min (rare; keeps option to re-detect a re-opened PR) |
| open / green | all checks green AND `lastHeadShaChangedAt > 10min ago` | 3 min |
| open / pending | any check pending AND `lastHeadShaChangedAt < 10min ago` | 60s |
| open / default | open, any other case | 60s |
| `needsMergeStateRefresh = true` | regardless of cadence | force eligible on next call |
| `consecutiveErrors > 0` | exponential backoff | `60s × 2^min(n,4)`, capped at 5 min, returns `"backoff"` if still in window |
| `force: true` (manual refresh button) | always | always fetch (subject to cooldown gate) |
| `!hasViewers() && msSinceLastViewer() > 120_000` | regardless | skip, `"no-viewers"` |
| `getGhCooldown() !== null` | regardless | skip, `"cooldown"` |

**Skip-reason precedence** (when multiple skip conditions hold, this is the order `shouldRefetch` reports — picked so the FE sees the most user-actionable reason):
1. `cooldown` — structured surface to the operator, takes priority over everything else.
2. `no-viewers` — daemon-internal; only matters when there's no operator.
3. `merged` — terminal state; never re-fetched.
4. `backoff` — transient error window.
5. `not-due` — normal cadence wait.
6. `force` override applies last (overrides `not-due` and `backoff`, but NOT `cooldown` or `no-viewers`).

Eviction semantics: `evict(workspaceId)` removes the workspaceId from every entry's `workspaceIds` set. An entry whose set becomes empty is deleted. The DB snapshot on the workspace row is the workspace-deletion path's responsibility (it'll be removed when the row is deleted/archived).

### Step 6 — `pr-routes.ts` integration (P3 + P4)

- `cockpit-summary` (single) and `cockpit-summary/batch` endpoints: for each workspace, build `key = repo#pr`; call `scheduler.shouldRefetch(key)`. If `fetch: true`, run the existing `cachedProvider(...vc:...)` flow with TTL bumped to 60s, then call `scheduler.recordFetch(key, pr, workspaceId)` + `store.updateWorkspacePrSnapshot(...)`. On caught error, call `scheduler.recordFetchError(key, error)`. If `fetch: false`, serve the most recent cached `vc:` entry (or the persisted snapshot, if cache evicted).
- **`pr-refresh` returns 200 + `{ versionControl, cooldownUntil }` from snapshot/cache when in cooldown** — no 503. Matches the batch endpoint shape; FE just renders the cockpit banner. (Round-1 revision; original 503 + Retry-After dropped to avoid FE handler gap.)
- **Cooldown-field injection at response boundary.** When `getGhCooldown()` is active, the pr-routes response builder MUST inject `versionControl.cooldownUntil = new Date(ghCooldown.until).toISOString()` on every emitted `versionControl` payload — regardless of whether the payload came from a fresh fetch, a scheduler-skip cache fallback, or a stale snapshot. Without this, served-from-cache responses during cooldown carry whatever `cooldownUntil` was set at last fetch (typically `null`), and the FE sticky cache (which only writes `status === "healthy"` entries via `applyStickyUpdates`) would never see the cooldown marker — breaking the banner. Pair with a `pr-routes.test.ts` assertion: "cached-served response during cooldown carries a non-null `cooldownUntil` even though no gh call was made."
- `commit-checks` adaptive TTL: in `enrichCommitChecks`, look up the scheduler entry's `lastChecksConclusion`; pass `300_000` ms when `"green"`, else `60_000`.
- **No change to workspace-fs-watcher.** (Round-1 verification: `apps/daemon/src/workspace-fs-watcher.ts:166` already only busts `git:` + `apps:`, never `vc:`. The "stop busting vc on fs change" step is a no-op and is removed from this plan.)
- Add `scheduler.evict(workspaceId)` to the workspace-deletion code path.

### Step 7 — `gh-quota-wiring.ts` extraction (BLOCKER-2 fix — keep `app.ts` under 800 lines)

New file: `apps/daemon/src/gh-quota-wiring.ts`. Owns:
- `let lastViewerAttachAt: number = 0;` plus `hasViewers()` and `msSinceLastViewer()` helpers reading from the `sseClients` Set passed in.
- Viewer-attach hook function: called from the `/events` handler when `sseClients.size` transitions 0 → 1; emits `"viewers.attached"` event and calls `scheduler.invalidateNotDue()`.
- Scheduler construction (`createGhScheduler({...})`).
- Main-watcher startup (`startMainWatcher({...})`) — returns the stop handle.

`app.ts` adds one call:
```ts
const ghQuota = wireGhQuota({ sseClients, store, providerCache, emit });
// ghQuota.scheduler, ghQuota.stopMainWatcher, ghQuota.hasViewers, ghQuota.msSinceLastViewer
```

The viewer-attach hook is invoked from `app.ts`'s `/events` handler:
```ts
sseClients.add(res);
ghQuota.onViewerAttached(); // 0→1 transition triggers fresh-fetch invalidation
```

Net LOC added to `app.ts`: ~10. Estimated final `app.ts` line count: ~757. Comfortable under 800.

### Step 8 — Viewer gate (P2)

- `apps/daemon/src/auto-recovery-wiring.ts`: pass `shouldRun: () => ghQuota.hasViewers() || ghQuota.msSinceLastViewer() <= 120_000` into `startAutoRecoveryMonitor`.
- `packages/operations/src/auto-recovery-monitor.ts`: extend `AutoRecoveryMonitorOptions` with `shouldRun?: () => boolean`. At the top of each tick (inside the existing setInterval handler), `if (opts.shouldRun && !opts.shouldRun()) return;`. Default behavior unchanged when omitted.
- **Architecture-boundary note:** this is a cross-package contract change. The change is additive (new optional field), backwards compatible, and the only caller in tree is `apps/daemon`. No other consumers exist. Architecture-boundaries.ts is not affected (no new cross-package import).
- Test in `packages/operations/src/auto-recovery-monitor.test.ts` (extend existing): assert that `shouldRun=false` skips a tick; assert that omitting `shouldRun` runs every tick (default).

### Step 9 — Main-watcher (P5)

New file: `apps/daemon/src/main-watcher.ts`.

- 3-minute setInterval (`MAIN_WATCHER_INTERVAL_MS`, env-overridable; `CITADEL_MAIN_WATCHER_DISABLED=1` env knob to disable).
- For every distinct repo in `store.listRepos()`, run `git ls-remote <primaryRemote> refs/heads/<defaultBranch>` from `repo.rootPath`. Resolves `primaryRemote` from `repo.defaultRemote || "origin"` (the RepoSchema field set at registration time — handles `upstream`-style fork workflows when the operator passes a non-default value). Falls back to first available workspace path with a warn log if `rootPath` is missing or unreadable.
- Store last-seen SHA per repo in an in-memory Map (no persistence needed — re-fetch on boot is cheap).
- On SHA change, call `scheduler.markRepoMainMoved(repoFullName)`.
- Skip entirely when `!hasViewers() && msSinceLastViewer() > 120_000`.
- ls-remote failures are tolerated (log at debug; don't change last-seen SHA so the next tick can recover).

Wired in `gh-quota-wiring.ts` (not `app.ts` directly per Step 7).

### Step 10 — Env knobs (SUG-1)

- `CITADEL_GH_SCHEDULER_DISABLED=1` — when set, scheduler `shouldRefetch` always returns `{ fetch: true }` (passthrough to existing behavior); `recordFetch`/`recordFetchError` become no-ops. Matches `CITADEL_AUTO_RECOVERY_DISABLED` pattern.
- `CITADEL_MAIN_WATCHER_DISABLED=1` — when set, `startMainWatcher` returns a no-op stop handle without starting the interval.
- Both knobs parsed in `gh-quota-wiring.ts` via the same `parsePositiveInt` pattern as `auto-recovery-wiring.ts`.

### Step 11 — Frontend cadence + cooldown surface

- `apps/web/src/cockpit-tools.tsx`:
  - `useWorkspaceCockpitSummary`: bump `refetchInterval` from `10_000` → `30_000`.
  - `nextPollInterval`: bump return from `30_000` → `60_000`.
  - `applyStickyUpdates`: when `summary.versionControl.cooldownUntil` is non-null, still cache the summary (not "drop" — cooldown is a transient state with valid last-known data) but ensure the cooldown field reaches consumers.
- New tiny banner component (or extend an existing one): when any workspace's `versionControl.cooldownUntil` is in the future, render a top-of-cockpit pill "GitHub rate-limited — retrying at HH:MM". Driven off the sticky cache; one banner per cockpit, not per workspace.

### No additional schema/contract artifacts to regenerate

The contract change is a plain Zod schema extension; `pnpm --filter @citadel/contracts build` is part of `pnpm check` already.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Scheduler state machine, main-watcher SHA-change trigger, viewer gate, rate-limit cooldown propagation, SQLite v9 migration, sticky cache + cooldown field, adaptive cache TTL selection, `shouldRun` predicate behavior in operations package. The bulk of the new logic is pure functions / mockable IO — unit-testable end-to-end. |
| E2E (Playwright) | Not required | The behaviors here are time-based (cadences measured in minutes), driven by external state (gh API response shape), or non-visual (cache hit ratios). The single visible UX change — the cooldown banner — is small enough to be a unit test on the rendering component plus a sticky-cache integration test. Pushing this through Playwright would add 10-30 min of test time for ~5 min of coverage; an explicit decision to keep it in the unit layer. |

### New tests to add

**Scheduler (`apps/daemon/src/gh-scheduler.test.ts`):**
- `shouldRefetch returns fetch:false reason:"merged" once state is MERGED, forever` — record a merged PR, advance time by 1 hour, assert still `false`.
- `shouldRefetch returns fetch:true on first call (nextEligibleAt = 0)` — fresh entry.
- `shouldRefetch returns fetch:false reason:"not-due" 30s after a successful fetch on default-open PR` (cadence 60s).
- `shouldRefetch returns fetch:true 61s after a fetch on default-open PR`.
- `shouldRefetch returns 60s cadence when checks are pending AND headSha changed <10min ago`.
- `shouldRefetch returns 3min cadence when checks are green AND headSha changed >10min ago`.
- `shouldRefetch returns fetch:false reason:"cooldown" while getGhCooldown() is active`.
- `shouldRefetch returns fetch:false reason:"no-viewers" 121s after last viewer detached AND no viewers now`.
- `shouldRefetch returns fetch:true within the 2-minute grace window after viewers detach`.
- `markRepoMainMoved flips needsMergeStateRefresh for every PR matching the repo, leaves others alone`.
- `recordFetch updates lastHeadShaChangedAt only when headSha actually changes`.
- `recordFetch resets consecutiveErrors to 0`.
- `recordFetchError increments consecutiveErrors and extends nextEligibleAt exponentially (60s, 120s, 240s, 300s cap)`.
- `shouldRefetch returns fetch:false reason:"backoff" inside the exponential window`.
- `evict(workspaceId) removes the id from every entry's workspaceIds and deletes entries with empty sets`.
- `evict preserves the entry if another workspace still references it`.
- `hydrate populates the in-memory map from DB rows; nullable columns survive as nulls`.
- `hydrate classifies pr_state="merged" rows immediately so they never get a boot-time fetch`.
- `invalidateNotDue() clears nextEligibleAt to 0 for all entries; entries in cooldown stay in cooldown via the gate`.
- `force: true overrides not-due but still respects cooldown` — fetch returns `false`/`"cooldown"` when both force and cooldown are set.
- `precedence: cooldown wins over backoff` — set both an active cooldown and `consecutiveErrors > 0`; assert `shouldRefetch` returns `reason: "cooldown"` (not `"backoff"`).
- `precedence: cooldown wins over no-viewers` — set both an active cooldown AND zero viewers + grace expired; assert `reason: "cooldown"`.

**Main-watcher (`apps/daemon/src/main-watcher.test.ts`):**
- `stable SHA across two ticks → no scheduler call` — mock `git ls-remote` to return the same SHA; assert `markRepoMainMoved` not called.
- `changed SHA → exactly one scheduler call per repo` — return different SHAs; assert called once with the right repo full name.
- `ls-remote failure does not throw, last-seen SHA preserved` — mock to throw; assert next successful tick still detects change against the prior SHA.
- `skipped entirely when hasViewers=false AND grace expired` — assert `git ls-remote` not spawned.
- `runs when within grace window` — assert it spawns even with hasViewers=false if grace not expired.
- `uses repo.rootPath when present` — assert cwd is the repo's rootPath.
- `falls back to first workspace path with warn log when rootPath unreadable`.
- `uses the first entry of remotes[] (not hardcoded "origin") when primary remote is non-default` — e.g., a workspace whose remotes list is `["upstream", "origin"]` triggers `git ls-remote upstream ...`.
- `CITADEL_MAIN_WATCHER_DISABLED=1 prevents the interval from starting`.

**Operations contract extension (`packages/operations/src/auto-recovery-monitor.test.ts` — extend):**
- `shouldRun=false skips tick work (no provider invocations)`.
- `shouldRun=true runs tick normally`.
- `omitting shouldRun preserves the prior behavior (runs every tick)`.

**Viewer gate (`apps/daemon/src/app.test.ts` or new `gh-quota-wiring.test.ts`):**
- `hasViewers() returns true when sseClients.size > 0`.
- `msSinceLastViewer() returns 0 during active viewing, monotonically increases after last detach`.
- `onViewerAttached fires invalidateNotDue exactly when sseClients.size transitions 0 → 1` (not on the second or third concurrent attach).
- `auto-recovery skips its tick when 0 viewers for >120s` — integration with the shouldRun predicate.
- `auto-recovery runs on first SSE connect even mid-cycle`.

**Rate-limit cooldown surfacing (`apps/daemon/src/pr-routes.test.ts`):**
- `cockpit-summary returns versionControl.cooldownUntil when cooldown is active` — mock `getGhCooldown` to return a future timestamp; assert the field flows through.
- `batch endpoint returns cached summaries during cooldown without calling gh` — populate cache, set cooldown, assert no provider invocations.
- `cached-served response during cooldown carries non-null cooldownUntil` — populate cache with `cooldownUntil: null`, activate cooldown, assert the response decorates the served payload with the current cooldown's ISO timestamp (R2 SUG-1 hook).
- `pr-refresh returns 200 + cooldownUntil during cooldown (not 503)` — assert status + body shape.
- `pr-refresh fetches fresh when not in cooldown` — control-case.

**SQLite migration (`packages/db/src/migration.test.ts` — extend):**
- `records schema_migrations version 9 row with name 'workspaces-pr-snapshot'`.
- `existing workspaces survive the v9 migration with NULL snapshot columns`.
- `updateWorkspacePrSnapshot writes and getWorkspacePrSnapshot reads round-trip` — all 7 fields including `prState`.
- `pr_number INTEGER NULL accepted` — explicitly assert nullable.
- `pr_state column accepts "open"/"closed"/"merged"/NULL`.

**Sticky cache + cooldown (`apps/web/src/cockpit-tools.test.tsx` — extend):**
- `applyStickyUpdates preserves cooldownUntil through a degraded-status batch entry`.
- `cooldown banner renders the soonest cooldownUntil across workspaces`.

**Adaptive cache TTL (`apps/daemon/src/pr-routes.test.ts`):**
- `enrichCommitChecks passes 300s TTL when scheduler reports green` — spy on cachedProvider's ttlMs argument.
- `enrichCommitChecks passes 60s TTL otherwise`.

### Existing tests to update

- `apps/web/src/cockpit-tools.test.tsx`: update cadence-expectation tests to assert `60_000` (batch) / `30_000` (active) instead of `30_000` / `10_000`.
- `apps/daemon/src/pr-routes.test.ts`: the `vc:` cache TTL constant moves from 10s to 60s — any test asserting the value updates.
- `packages/providers/src/index.test.ts`: P1 already added `isRateLimitError` tests; no changes needed in this plan.
- (Removed previous fs-watcher test extension — no behavior change there.)

### Assertions to add/change/tighten

- `pr-routes.test.ts`: assert that the batch handler's provider-fetch counter increments only for entries where `shouldRefetch.fetch === true`.
- `auto-recovery-monitor.test.ts`: assert provider-fetch counter is 0 across the no-viewer window.
- Sticky-cache test: tighten to assert the `cooldownUntil` ISO string is preserved verbatim across cache merges.

### Failure modes / edge cases / regression risks

- **Force-refresh during cooldown.** Returns 200 + `{ versionControl, cooldownUntil }` from snapshot/cache (round-1 revision; no 503).
- **Force-push storm.** `lastHeadShaChangedAt` updates only on actual SHA change; rapid `recordFetch` calls with the same SHA leave the timestamp alone. Covered by a scheduler test.
- **Workspace deleted mid-fetch.** Scheduler entry's `workspaceIds: Set<string>` is decremented via `evict(workspaceId)`; entry deleted only when set is empty. Other workspaces sharing the same PR keep working. Covered by an eviction test.
- **Re-opened PR on same branch.** When `state` flips from `MERGED` back to `OPEN` (rare but possible), scheduler's "never re-poll" rule strands us. Mitigation: force-refresh button always fetches; local branch HEAD change (detected by fs-watcher) triggers force-refresh for that workspace.
- **Two workspaces sharing the same branch & PR.** Scheduler key is `repo#pr` with `workspaceIds: Set<string>` — share rate-limit state cleanly.
- **Main-watcher across many repos with stale auth.** ls-remote uses local git, not gh; fails on auth issues with a non-zero exit; logged at debug; doesn't kill the tick. Covered by failure-tolerance test.
- **Main-watcher with non-default remote.** First-remote-in-`remotes[]` resolution handles `upstream`-style fork workflows. Covered by a non-origin remote test.
- **Daemon restart loses scheduler in-memory state.** Mitigated by P6 — `hydrate()` on boot reads `workspaces.pr_*` columns including `pr_state`, so merged PRs are correctly classified without a wasted boot-fetch.
- **Cooldown banner flapping.** A cooldown-then-success transition could cause the banner to flash. Mitigation: the banner reads `cooldownUntil` from the sticky cache; sticky cache holds previous values until a healthy response. Specifically tested in sticky-cache test.
- **Persistent gh auth failure (not rate-limited).** `recordFetchError` exponential backoff (60s → 120s → 240s → 5min cap) prevents quota burn on a broken-auth loop. Covered by a scheduler error-path test.
- **`workspace.updatedAt`-keyed `vc:` cache rotation.** Stable in steady state (rotates only on lifecycle/branch/dirty changes, not session activity). TTL bump is effective. Cache-key stabilization tracked as a follow-up; not in scope for this plan.

### Adversarial analysis

- **How could this fail in production?** Scheduler in-memory state drift after a long uptime; SQL snapshot fields drift from in-memory map. Mitigation: scheduler is the single writer of the snapshot; recordFetch always writes both. Periodic invariant assertion (in dev only) could be added but not in scope.
- **What user actions trigger unexpected behavior?** (a) Spamming the force-refresh button — gated by cooldown + scheduler `force: true`, no extra GH cost beyond a single fetch. (b) Opening/closing the cockpit tab repeatedly — 2min grace window dampens the thrash. (c) Switching default branches on a tracked repo — main-watcher re-resolves the primary remote and default branch per tick, so a base-branch change picks up automatically next tick.
- **What existing behavior could break?** B.4 §50 hard-codes "every ~30 seconds"; spec update covers that. FE renderers that key off `versionControl.status === "degraded"` still work; the new `cooldownUntil` is purely additive. Verified (round 1) no FE code path reads `versionControl.status === "degraded"` — only `app.status` and `provider.status`, both unrelated.
- **Clock drift / laptop wake.** All cadence and grace arithmetic uses `Date.now()` (consistent with existing daemon and shipped P1 cooldown). Backward clock jumps after wake make grace windows *longer* (fail-safe). Forward jumps cost one missed tick at worst. Documented trade-off; rejected the monotonic-clock alternative to avoid a clock-domain mismatch with cooldown-until comparisons.
- **Cross-package contract change (operations).** Adding `shouldRun?` to `AutoRecoveryMonitorOptions` is additive and backwards compatible; the only in-tree caller is `apps/daemon`. No architecture-boundary violation (architecture-boundaries.ts isn't affected — no new cross-package imports).
- **Which tests credibly catch those failures?** Scheduler state-machine tests, sticky-cache cooldownUntil test, auto-recovery-monitor shouldRun tests, scheduler error-backoff tests.
- **What gaps remain?** No webhook = no instant detection of remote merges by other users. Main-watcher's 3min interval is the floor; for merge-conflict detection that matters when a coworker merges right before you push, the worst case is 3 min of staleness — acceptable tradeoff per user's framing. `workspace.updatedAt`-keyed `vc:` cache may still rotate during heavy workspace mutation bursts (e.g., bulk lifecycle changes); stabilization is a tracked follow-up.

## Tests

(Derived from QA/Test Strategy; TDD order = tests precede implementation within each step.)

Create:
- `apps/daemon/src/gh-scheduler.test.ts`
- `apps/daemon/src/main-watcher.test.ts`
- `apps/daemon/src/gh-quota-wiring.test.ts` (or extend `app.test.ts` if it exists with similar wiring tests)

Extend:
- `apps/daemon/src/pr-routes.test.ts` (cooldown surface, 200 + cooldownUntil from pr-refresh, adaptive commit-checks TTL, vc: TTL bump)
- `apps/daemon/src/auto-recovery-monitor.test.ts` (shouldRun predicate behavior)
- `packages/operations/src/auto-recovery-monitor.test.ts` (shouldRun contract default + opt-in behavior)
- `packages/db/src/migration.test.ts` (v9 row, 7 additive columns including pr_state, round-trip)
- `apps/web/src/cockpit-tools.test.tsx` (cadence updates, cooldown banner data shape)

No new contract tests — the `cooldownUntil` field is a single optional Zod field.

## Verification

Per the extension's Verification commands:

- `make check` — required. Covers `check:arch`, `check:size` (must pass — see file-size note below), `typecheck`, `lint` (biome), `test` (vitest unit + extended new tests), `coverage`, `check:deps`, `build`.
  - **File-size note:** `apps/daemon/src/app.ts` is currently 747/800 lines. After the Step-7 extraction to `gh-quota-wiring.ts`, expected `app.ts` is ~757 lines (single `wireGhQuota` call adds ~10 LOC). Net stays under 800; `check:size` passes.
  - **Coverage expectation:** the `≥90% line coverage on core/backend/shared` rule from `docs/contributors/v2-engineering-standards.md` does NOT directly apply to `apps/daemon` (an app, not a guarded module). The new pure modules (`gh-scheduler.ts`, `main-watcher.ts`, `gh-quota-wiring.ts`) are small (≤200 LOC each estimated) and MUST hit ≥90% line coverage in their own right. The implementation session should run `pnpm --filter @citadel/daemon test:coverage` (or equivalent) and confirm the three new modules clear 90% before merge.
- `make e2e` — NOT required by this change set (no user-flow regression risk identified). Skip unless `make check` flags a coupled E2E failure.
- `make smoke` — REQUIRED. The change touches the daemon's HTTP surface (`cockpit-summary`, `cockpit-summary/batch`, `pr-refresh`) including new response field. Smoke must validate both pre- and post-cooldown response shapes for all three endpoints.
- `make performance` — NOT required. No startup or hot-path code touched at any meaningful scale; the scheduler check is O(1) per request.
