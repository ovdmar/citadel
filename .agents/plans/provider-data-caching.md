Activate the /implement-task skill first.

# Plan: Provider data caching & refresh

## Acceptance Criteria

Source: scratchpad block `00000015-0015-4015-8015-000000000015` + user-confirmed scope.

- [ ] Cockpit renders cached provider data (PR / CI / Jira / version-control / apps / usage) immediately on first load — no 2–5s blank states after daemon restart or page reload, whenever a non-stale-by->24h cached value exists.
- [ ] Warm-boot perf target: navigator workspace cards render their PR lifecycle pill from cache within 200ms of the `/api/workspaces/pr-state` response (verified via Playwright timing).
- [ ] Persistent cache layer over provider data, write-through to a JSON file under the daemon's `dataDir`, written with mode `0o600`. Schema-versioned and tolerant of corrupt/old files (degrade to empty cache, never crash).
- [ ] Cache `load()` is bounded by a 500ms hard timeout. If it doesn't complete within the budget, the daemon proceeds with an empty cache (logs a warn) so route binding is never blocked on slow disks.
- [ ] Stale-while-revalidate semantics: when a request hits an expired entry, the cached value is returned immediately and a background refresh is kicked off; the next request gets the fresh value. The background write is **only applied if a per-key in-flight Symbol token still matches at write time** — any `cache.set/delete/clear` on the same key in the interim invalidates the token. **Unrelated cache mutations on OTHER keys do NOT invalidate the token** (per-key, not global generation).
- [ ] Late-resolving `load()` after the 500ms timeout is a no-op: a `timedOut` flag is captured at race start, and the load's then-handler early-returns if the flag was set, so the late read never overwrites a warming cache.
- [ ] Background refresh job runs on a cadence for every active (non-archived) workspace + every healthy usage-capable runtime, gated by configurable working hours (default 09:00–18:00 local, weekdays only).
- [ ] Per-provider refresh intervals are configurable; defaults: PR/CI 60s, Jira 5min, Usage 5min. Refresh scheduler enforces single-in-flight per (workspace, provider) tuple and a bounded concurrency cap.
- [ ] Background refresh job has a single scheduling chokepoint so #16 (rate-limit handling) can add backoff later without rewiring callers.
- [ ] Background refresh job is enabled by an explicit boolean option on `createDaemonApp` (default `true`), set to `false` by `app-test-helpers.ts` for vitest. **Not gated on `process.env.VITEST`** — that pattern would silently kill the feature in production if the env var leaks.
- [ ] All workspaces in the navigator render their PR lifecycle pill (grey/yellow/green/red) and approval pill from cached PR/CI state, not only the active workspace. State comes from a new dedicated endpoint `GET /api/workspaces/pr-state`, NOT bolted onto `/api/state`.
- [ ] Cockpit window focus triggers an on-demand refresh of the focused workspace's providers, but only when cached data is older than a configurable threshold (default 30s). Implemented via Page Visibility API + window focus.
- [ ] Each runtime's usage indicator pill refreshes on its own configurable cadence (default 5min) — no focus-pause logic; refreshes run on schedule regardless. Override lives on `UsageProviderConfigSchema` (not `RuntimeConfigSchema`) to keep the contract surface narrow.
- [ ] Usage indicator renders a clickable reload button instead of `—` whenever the usage value is missing, errored, or unavailable. Click posts `/api/runtimes/:id/usage/refresh` and refetches. Button is `disabled` while the mutation is pending.
- [ ] Usage reload button preserves top-bar layout: the `cit-usage-pill` chrome carries a `min-width` token so swapping percentage ↔ icon never shifts neighboring controls. Playwright asserts width-difference < 2px between healthy and reload states.
- [ ] All existing cache-invalidation hooks (`workspace-fs-watcher`, `POST /api/workspaces/:id/refresh`, `POST /api/repos/:id/refresh`, config updates, repo deletion, reconcile) also bust the persisted layer.
- [ ] fs-watcher bust triggers a debounced (~2s after last bust) poke into the refresh-job queue for the affected workspace so the cache repopulates promptly after an edit storm settles.
- [ ] Cache `load()` prunes entries whose key references a workspace id no longer in the store, and caps the total entry count at 5000 (most-recently-cached wins) so renames don't leak forever.
- [ ] Cache file lives on disk as ms-precision numbers in `cachedAt`, but every API surface that exposes `cachedAt` to the web client emits an ISO-8601 string so it doesn't mix serialization formats with `checkedAt`.
- [ ] No SQLite/new heavy dependency added — persistence is plain JSON.
- [ ] `make check` and `make e2e` pass.

## Context and problem statement

Citadel's current provider data plumbing:

- `apps/daemon/src/app.ts:88` keeps a per-process in-memory `providerCache: Map<string, {expiresAt, value}>` with TTLs (10s default, 3s git status, 60s apps, 5min usage).
- Cache busts on FS-watcher debounce (`apps/daemon/src/workspace-fs-watcher.ts`), manual `/refresh` endpoints, config updates, repo deletion, and reconcile.
- `apps/web/src/cockpit-tools.tsx:8-14` refetches `/api/workspaces/:id/cockpit-summary` every 10s for the **active** workspace only.
- `apps/web/src/navigator.tsx:172-176` passes the PR summary into `WorkspaceCard` only for the active workspace; every other workspace card receives `pullRequest={null}` and renders a grey "no PR" pill regardless of reality.
- `apps/web/src/usage-indicator.tsx` falls back to `—` whenever usage is missing/errored, with no recovery affordance other than navigating into Settings.

Concrete symptoms:

1. **Cold cache after daemon restart** — every `cockpit-summary` request kicks off `gh`/`jtk` subprocesses; the first 2–5s after a worktree reboot shows blank panels.
2. **PR state in the navigator is silently wrong for non-selected workspaces** — operators can't scan the workspace list to find a green-checks workspace without clicking each one.
3. **Usage indicator dead-ends** — when `gh`/runtime fetcher errors transiently, the operator sees `—` with no obvious recovery path.
4. **No background warmth** — even with daemon up, switching to a workspace nobody's touched recently triggers a cold fetch.

This PR adds a persistence layer on top of the existing `providerCache`, a single-source-of-truth background refresh job, an on-focus refresh hook, navigator-wide PR rendering, and a usage reload affordance. It deliberately stops short of rate-limit-aware backoff — #16 will own that — but lays a single chokepoint for it.

## Spec alignment

This PR contributes to the following spec lines, and the first implementation step **does flip two checkboxes** because the underlying data/wiring is fully delivered:

**Checkboxes to flip in this PR** (these implementation steps must edit the spec files):

- `specs/B.6-providers-hooks-config.md` — `[ ] 8. Provider data includes refresh age.` → `[~]`. The `cachedAt` envelope is wire-delivered end-to-end; UI surfacing of refresh age across all panels is a follow-up.
- `specs/B.4-git-pr-ci-diff.md` — `[ ] 7. Workspace cards render the PR icon with lifecycle color.` → `[~]`. The navigator now drives lifecycle color from cached PR/CI state for every workspace; full coverage of all card surfaces (e.g. mobile) tracked separately.

**Other spec lines this PR contributes to without closing**:

- `specs/B.4-git-pr-ci-diff.md` — `[ ] 7. Git status shows refresh time and stale state.` Plan exposes a `cachedAt` envelope on cached responses so the inspector can render age.
- `specs/B.4-git-pr-ci-diff.md` — `[~] 1. PR Identity.` This PR finally feeds non-active workspace cards with PR state so the lifecycle color works in the navigator (today it's stuck grey).
- `specs/B.6-providers-hooks-config.md` — `[ ] 7. Provider degraded state explains missing/stale data.` Usage reload button materializes this for the usage surface.
- `specs/B.2-ade-cockpit.md` — `[ ] 7. Stale provider data state is explicit.` Reload button on usage is one of the first concrete renderings of this.
- `specs/B.8-ui-performance-quality.md` — `[ ] 1. Citadel feels instant with 10-12 active workspaces across 2-3 repositories.` Persisted cache + warm background refresh is the load-time-perceived-speed win.
- `specs/B.8-ui-performance-quality.md` — `[ ] 3. Provider summaries load independently from the main workspace shell.` Reinforced — cached read returns instantly.
- `specs/B.8-ui-performance-quality.md` — `[ ] 4. Slow provider commands appear as stale/degraded states.` Cached `cachedAt` + reload button render this on the usage and (later) PR panels.

## Implementation approach

The persistence layer is added on top of the existing `providerCache` Map by subclassing `Map`, not wrapping it — every existing `.set()`, `.delete()`, `.clear()` call site (in `app.ts`, `daemon-mcp-tool.ts`, `workspace-fs-watcher.ts`, and test files) transparently picks up the flush hook without changes.

### 0) Pre-flight: extract handlers from `app.ts` (load-bearing, not optional)

`app.ts` is at **804 lines today** — already over the 800-line file-size gate enforced by `scripts/checks/file-size.ts`. Adding any new code into `app.ts` will trip CI immediately.

The first implementation slice must reduce `app.ts` below **750 lines** (50-line headroom for the new wiring this PR adds) by extracting handlers into companion files. Concrete targets:

- Extract `GET /api/workspaces/:workspaceId/cockpit-summary` (lines 389–440 today, ~52 lines) into `apps/daemon/src/cockpit-summary-route.ts`. It depends on `cachedProvider`, `store`, `operations`, `providers`, `deriveReadiness`, and `cachedProviderHealth` — all already importable.
- Extract `GET /api/state` (lines 167–187, ~21 lines) into `apps/daemon/src/state-route.ts`. Simple dependency list; this PR will also extend this handler, so isolating it now keeps the line budget clean.

**Hard pre-check** (gate for the first commit of this PR): `wc -l apps/daemon/src/app.ts` must be `<= 750` before any provider-cache code lands.

### 1) Persistence + stale-while-revalidate (daemon)

New module `apps/daemon/src/provider-cache.ts`:

- `createProviderCache({ dataDir, mode = 0o600 })` returns a `ProviderCache extends Map<string, ProviderCacheEntry>` instance plus side-channel helpers:
  - `ProviderCacheEntry = { expiresAt: number; value: unknown; cachedAt: number }` — `cachedAt` is ms-precision local time. No `generation` field on entries — race correctness uses a per-key in-flight Symbol map kept in the helper (see "Race correctness" below).
  - **Subclass behavior**: `set()`, `delete()`, `clear()` invalidate the per-key in-flight token for the mutated key(s) AND schedule a debounced (`~500ms`) flush. This means every existing call site (`providerCache.set(...)`, `providerCache.clear()`, `providerCache.delete(...)`, `bustCacheByPrefixes(...)`) automatically persists AND invalidates in-flight stale-loads for the affected keys without refactoring.
  - A `loading` flag set during `load()` suppresses flush-scheduling for hydrate-time `set`s (the entries already match what's on disk, so persisting again is redundant).
  - `load()`: read `<dataDir>/provider-cache.json` with a **500ms hard timeout**: `Promise.race([readAndParse(), wait(500)])`. Capture a local `timedOut` flag inside the race. The wait branch sets `timedOut = true` and resolves; the read branch's then-handler checks `if (timedOut) return` BEFORE writing any entries into the cache — so a late-resolving read after the daemon has already proceeded does NOT clobber a warming cache. On failure/non-timeout error, log a warn and start empty. Drops on successful (non-timed-out) hydrate:
    1. entries with schema-version mismatch (all of them),
    2. entries with `cachedAt` older than 24h,
    3. entries whose key references a workspace id not in `store.listWorkspaces()` (orphan prune — receives a store snapshot),
    4. anything past 5000 entries (keep most-recently-cached).
  - `flush()`: atomic temp-file rename (`<dataDir>/provider-cache.json.<pid>.tmp` → `<dataDir>/provider-cache.json`). Mode `0o600` to keep PR/Jira summaries out of world-readable space.
  - `bust(prefixes)`: existing prefix-bust semantics, plus schedule a `flush`. Token invalidation for each busted key happens through the same `delete()` path.
  - `dispose()`: clears the debounce, forces a final synchronous flush, returns when fsync resolves.
- `cachedProviderValue` in `apps/daemon/src/app-helpers.ts` extended:
  - New variant `cachedProviderWithStaleFallback<T>({ cache, key, load, ttlMs })`:
    - Cache hit & fresh → return cached.
    - Cache hit & stale → mint a new `token = Symbol()`, store it in `cache.inFlightTokens.set(key, token)`, return cached value to caller, kick off `load()` in the background with single-in-flight dedup keyed by `key`. **On completion, write to cache ONLY IF `cache.inFlightTokens.get(key) === token`** — otherwise an fs-watcher bust, manual refresh, or any other mutation to THIS specific key has happened in the interim. Drop the result. Clear the in-flight slot regardless.
    - On background error, clear in-flight slot (do not bust cache — the existing stale value is the best we have).
    - Cache miss → mint a token, store it, await load synchronously; same token check applies before writing.
  - Existing `cachedProviderValue` remains for callers that want strict TTL semantics (provider-health, etc.). Only the per-workspace handlers (`vc:*`, `ci:*`, `issue:*`, `usage:*`) opt into stale-fallback; `apps:*` already has 60s TTL and can stay strict.
- The cached entry's `value` is unchanged — keys keep including `workspace.updatedAt` so a workspace edit auto-invalidates.

**Race correctness — explicit semantics**:

The bust/write race uses a **per-key in-flight Symbol token**, not a global counter. Why per-key: a global counter (incremented on every `set`/`delete`/`clear`) would incorrectly reject writes to key A whenever an unrelated mutation to key B happened during A's in-flight load — making the miss path effectively never warm under concurrent activity. Per-key tokens are immune to unrelated mutations.

Concretely:
- `PersistentProviderCache` holds `inFlightTokens: Map<string, symbol>`. Mutating methods (`set`, `delete`, `clear`) remove the relevant key's token (clear removes all). The bust/refresh helpers go through these mutating methods, so token invalidation is transitive.
- `cachedProviderWithStaleFallback` mints `token = Symbol()` before each load, stores `inFlightTokens.set(key, token)`, awaits load, then checks `inFlightTokens.get(key) === token` before writing. If anyone busted this key in the meantime (deleted its token), the check fails and the stale load result is dropped.

### 2) Background refresh job (daemon)

New module `apps/daemon/src/provider-refresh-job.ts`:

- `startProviderRefreshJob({ store, config, cache, providers, now? })` returns `{ stop, pokeWorkspace }`.
- Tick interval: 15s (default; configurable).
- On each tick:
  1. Compute `withinWorkingHours()` from local clock against `config.providerRefresh.workingHours`. Skip if outside.
  2. Iterate `store.listWorkspaces()` (non-archived only) and `config.runtimes` (healthy + supportsUsage + per-runtime override or default).
  3. For each `(workspace, providerKind)` and `(runtime, "usage")` tuple, look up the cache entry; if missing or `cachedAt` older than the per-kind interval, queue a refresh.
  4. Queue drains through a single chokepoint `scheduleProviderRefresh(item)` which:
     - **Re-checks `workspace.archivedAt === null` and `runtime.health === "healthy"` immediately before dispatch** (TOCTOU guard for config/state mutations between tick start and refresh execution).
     - Single in-flight per `cacheKey`.
     - Global concurrency cap (default 4).
     - 0–500ms jitter before each call.
  5. Each refresh writes the result through `cache.set(...)`. Failures don't bust the stale value — they just don't update `cachedAt`, so the entry stays stale and another tick will retry.
- `pokeWorkspace(workspaceId)`: queues an out-of-band refresh for one workspace's providers. Called by `workspace-fs-watcher` after the bust debounce settles (~2s after the last bust), so the cache repopulates quickly after an edit storm.
- Stops on server close. Disabled when `process.env.CITADEL_DISABLE_REFRESH_JOB === "1"` (mirrors the existing reaper-disable env knob in `app.ts:776`).
- **Enablement is an explicit option**: `createDaemonApp({ enableRefreshJob = true })`. Vitest harness (`app-test-helpers.ts`) passes `enableRefreshJob: false` so tests don't spawn `gh` subprocesses. **Production never reads `process.env.VITEST`** — accidental env leakage cannot silently disable the feature.

The chokepoint is the **single seam** #16 will extend with rate-limit-aware backoff; everything else inside the job is pure scheduling.

### 2a) fs-watcher → refresh-job poke (edit-storm responsiveness)

In `apps/daemon/src/workspace-fs-watcher.ts`'s `onChange` debounce timeout, after the bust fires, schedule a `pokeWorkspace(workspaceId)` call **2s after the last bust** (a second debounce layer). This way, during a live-editing session where the watcher busts every 350ms, the cache doesn't sit empty for ~15s waiting for the next refresh tick; instead, 2s after the user stops typing, the workspace's providers refresh on-demand. The 2s window keeps the cache cold during active editing (correct), and warm immediately after the burst (also correct).

### 3) Navigator-wide PR state — dedicated endpoint (daemon + web)

The user explicitly called this out: "the workspaces have that rendered in the nav and that must be somewhat fresh even if the workspace is not selected."

- Daemon: **new endpoint `GET /api/workspaces/pr-state`** returning `Record<workspaceId, { pullRequest: PullRequestSummary | null; ciRuns: CiRunSummary[]; checkedAt: string | null; cachedAt: string | null }>`. The handler builds this **purely from cache** (no fresh fetches) — the background job is responsible for keeping the cache warm. Builds via the same `vc:${workspaceId}:${workspace.updatedAt}` and `ci:${workspaceId}:${workspace.updatedAt}` keys. Entries with no cached value are simply omitted from the map. **All time fields serialized as ISO-8601 strings** at the response boundary (internal `cachedAt` is ms; the route converts).
- Web: new `useWorkspacesPrState()` hook in `apps/web/src/cockpit-tools.tsx` querying the dedicated endpoint with a 30s `refetchInterval` (lighter than `/api/state`'s polling rhythm; the background refresh job is the freshness driver, not the client). Navigator consumes the result.
- In `navigator.tsx:172-176`, drop the active-workspace-only condition; look up each workspace's PR state from `useWorkspacesPrState()`. Active workspace still falls back to the cockpit-summary version so a focus-refresh result shows up immediately for the selected workspace.

**Why a dedicated endpoint, not `/api/state`**: `/api/state` is invalidated by virtually every workspace/repo/namespace mutation and is fetched aggressively by the cockpit's `useStateQuery`. Bolting ~20kb of PR JSON onto it pays back the perf win the rest of this PR is designed to capture. The dedicated endpoint has a narrow invalidation domain — only the background refresh and explicit `/refresh` endpoints affect it — and lets the navigator poll it on its own rhythm. #7 (PR display) can consume it for its own polling decisions; it doesn't need to write to the cache.

### 4) On-focus refresh hook (web)

New hook `apps/web/src/hooks/use-focus-refresh.ts`:

- Listens to `document.visibilitychange` and `window.focus`.
- On focus, checks `Date.now() - lastFetchedAt > thresholdMs` against the focused workspace's cockpit-summary query's `dataUpdatedAt`. If true, calls `queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", id] })` — TanStack Query refetches; daemon serves it stale-while-revalidate so the UI gets cached-then-fresh.
- Threshold sourced from config via the existing `/api/config` query (already loaded by `usage-indicator`).
- Wired into `cockpit.tsx` near the active workspace pickup.

### 5) Usage reload button (web)

In `apps/web/src/usage-indicator.tsx`'s `UsagePill`:

- If `summary` undefined OR `summary.status !== "healthy"` OR `summary.categories.length === 0`, render `<button type="button" className="cit-usage-pill cit-usage-pill--reload" disabled={mutation.isPending} …>` instead of the `<Link to="/settings">` — onClick posts `/api/runtimes/:id/usage/refresh` and invalidates `["runtime-usage", runtime.id]`. `disabled` during the in-flight mutation prevents multi-click spam.
- **Layout stability is enforced by CSS, not asserted**: add a `min-width` token to the existing `cit-usage-pill` chrome (sized to fit the widest healthy text — "100%·12h" — plus padding). The reload variant uses the same chrome, swapping the inner content for `<RefreshCw size={12} aria-hidden />`. Playwright snapshot test asserts width-difference between healthy and reload states < 2px.
- Tooltip explains the failure reason from `summary.reason` when present.

### 6) Per-provider usage cadence (daemon + web) — narrow contract

- Extend **`UsageProviderConfigSchema` only** with optional `refreshIntervalMs` (number, min 30s). **Do not** extend `RuntimeConfigSchema` — `RuntimeConfig` is consumed across ~19 sites (web settings UI, MCP `inspect_status` / `list_runtimes`, agent session creation); widening it for an option that only matters when a usage provider exists is a blast radius we don't need.
- Add `resolveUsageRefreshInterval(provider, config)` in `apps/daemon/src/provider-cache.ts` (daemon-side, not in `packages/providers` — keeps providers ignorant of the daemon's refresh config). Order: provider override → `config.providerRefresh.intervals.usageMs`.
- Use this resolver in both `runtime-usage-routes.ts` (TTL on the cached call) and the background refresh job. The two must stay consistent.
- No UI exposure of the per-provider knob in this PR (operators can edit via the existing Advanced settings JSON editor); a dedicated control belongs to a settings polish PR.

### 7) Config schema additions (`packages/config/src/index.ts`)

```ts
providerRefresh: z
  .object({
    enabled: z.boolean().default(true),
    // workingHours uses the daemon process's local clock. Operators working
    // across timezones from a laptop should expect the gate to follow the
    // laptop, not the human — set explicit hours or enabled:false to override.
    workingHours: z
      .object({
        startHour: z.number().int().min(0).max(23).default(9),
        endHour: z.number().int().min(0).max(24).default(18),
        weekdaysOnly: z.boolean().default(true),
      })
      .default({ startHour: 9, endHour: 18, weekdaysOnly: true }),
    intervals: z
      .object({
        prCiMs: z.number().int().min(15_000).default(60_000),
        jiraMs: z.number().int().min(30_000).default(5 * 60_000),
        usageMs: z.number().int().min(30_000).default(5 * 60_000),
      })
      .default({ prCiMs: 60_000, jiraMs: 5 * 60_000, usageMs: 5 * 60_000 }),
    focusRefreshThresholdMs: z.number().int().min(5_000).default(30_000),
    maxConcurrentRefreshes: z.number().int().min(1).max(16).default(4),
  })
  .default({ /* all defaults */ }),
```

All keys default-fill, so existing on-disk configs continue to load.

`UsageProviderConfigSchema` additionally gains `refreshIntervalMs?: number` (min 30s, optional).

## Alternatives considered

### A. Persist via SQLite, not JSON

Rejected. The data is fewer than a few hundred entries per install and the access pattern is "read all on boot, write on cache set". SQLite would add a schema-migration burden in `packages/db/src/index.ts`, force a `schema_migrations` version row, and gain us nothing operators can't get from `cat .citadel-data/provider-cache.json | jq`.

### B. Persist per-workspace cache files

Rejected. Multiplies file-handle traffic on every cache write, complicates the fan-out bust logic, and offers no operational win — one daemon owns the whole cache.

### C. Client-side persistence (IndexedDB / localStorage)

Rejected. The daemon is the single source of truth for cached provider data — MCP tools also need a warm cache, and they don't run inside the browser. Putting the cache on the daemon side means web, MCP, and CLI all benefit.

### D. Replace TanStack Query refetchInterval with a server-sent push

Tempting and probably a future direction, but a much bigger change that depends on SSE-event design we haven't finalized. Out of scope.

### E. Focus-pause governing the background refresh

The original scratchpad asked for this. User explicitly dropped it after grilling: too complicated, multiple cockpit tabs across worktrees confuse the model, working-hours + cadence + on-focus on-demand is sufficient.

### F. Rate-limit-aware backoff in this PR

Out of scope — #16 will add it on top of the `scheduleProviderRefresh` chokepoint.

## Implementation steps

Group order is the same as the implementation order. Each group is one "Implement: …" unit for `/implement-task`.

### Implement: Pre-flight app.ts extraction (HARD GATE — must land first)

- Move the `/api/workspaces/:workspaceId/cockpit-summary` handler from `apps/daemon/src/app.ts:389-440` into a new file `apps/daemon/src/cockpit-summary-route.ts`, exposed as `registerCockpitSummaryRoute(app, deps)`. Deps: `store, operations, providers, asyncRoute, cachedProvider, cachedProviderHealth`.
- Move the `GET /api/state` handler from `apps/daemon/src/app.ts:167-187` into `apps/daemon/src/state-route.ts` (`registerStateRoute(app, deps)`). Same pattern.
- Update `app.ts` to call both registration helpers; preserve existing behavior 1:1.
- **Acceptance**: `wc -l apps/daemon/src/app.ts` returns `<= 750`.
- Existing app.test.ts coverage should pass unchanged. If any test directly hooked into the inline definition (no — currently uses HTTP), no change.

### Implement: RuntimeConfig consumer audit (no code change yet, just enumeration)

- Run `rg -n "RuntimeConfig|listRuntimeHealth" apps packages --type ts -l` and list every consumer in the plan's checklist as part of the implementation work (NOT in the plan doc). The audit confirms `RuntimeConfigSchema` is not being widened in this PR — the per-cadence override lives on `UsageProviderConfigSchema` only — so no consumer needs updating.
- Add an explicit assertion in `packages/config/src/index.test.ts`: `RuntimeConfigSchema.shape` does NOT contain `usageRefreshIntervalMs` (regression guard so a future drive-by addition doesn't silently widen the surface). Symmetric assertion: `UsageProviderConfigSchema.shape.refreshIntervalMs` exists and validates min 30s.

### Implement: Persistent cache module (Map subclass + per-key in-flight tokens)

- Create `apps/daemon/src/provider-cache.ts` exporting:
  - `class PersistentProviderCache extends Map<string, ProviderCacheEntry>`. Overrides `set(k, v)`, `delete(k)`, `clear()` to (a) remove the key's entry from `inFlightTokens` (clear: remove all), and (b) schedule a debounced flush — UNLESS the `loading` flag is set, in which case skip the flush schedule (hydrate doesn't need to re-persist).
  - Public field `inFlightTokens: Map<string, symbol>`.
  - Public boolean `loading`. **Lifecycle**: set to `true` synchronously at the top of `load()`. Cleared in EITHER branch of the race, whichever resolves first:
    - **Timeout branch**: when `timedOut = true` is set, `loading = false` is set at the same time. After this, any `set()` from the live system (refresh job, request handlers) DOES schedule a flush — persistence resumes immediately.
    - **Successful read branch**: in the readPromise's then-handler, after the entries are applied to the Map (or after early-return when `timedOut` was already set), `loading = false`.
    These two clears are mutually exclusive — one of them owns the clear. Tests assert: (a) `set()` during `load()` skips flush; (b) `set()` after timeout fires DOES schedule flush even if the late-resolving read has not yet completed.
  - Factory `createProviderCache({ dataDir, mode = 0o600, listWorkspaces })`.
  - `load()`:
    ```ts
    let timedOut = false;
    const readPromise = this.readAndParse(); // resolves to entries or empty
    await Promise.race([readPromise, new Promise<void>((r) => setTimeout(() => { timedOut = true; r(); }, 500))]);
    readPromise.then((entries) => {
      if (timedOut) return; // late read — do not clobber
      // ... apply filters, populate Map via .set() with `loading=true` (no flush)
    }).catch((err) => { /* log; ignore */ });
    ```
    On non-timeout completion: filter by schema version, 24h `cachedAt` floor, orphan-workspace-id prune (using `listWorkspaces()`), then truncate to 5000 most-recently-cached if oversize.
  - `flush()`: atomic temp-file + rename + `fs.chmod(0o600)` (or pass `mode` to `fs.writeFile`).
  - `dispose()`: clear debounce, do one final synchronous flush.
- File path: `${dataDir}/provider-cache.json`. Schema: `{ version: 1, savedAt: string, entries: Array<[key, ProviderCacheEntry]> }`.
- Re-export `ProviderCache` from `app-helpers.ts` aliased to the new class so all existing imports keep working — the alias is structural (the class extends Map, so it satisfies the existing `Map<string, {...}>` shape).

### Implement: Stale-while-revalidate helper with per-key Symbol token

- In `apps/daemon/src/app-helpers.ts`, add `cachedProviderWithStaleFallback<T>({ cache, key, load, ttlMs })`:
  - Module-scoped `inFlight = new Map<string, Promise<T>>()` for single-in-flight dedup.
  - Token protocol:
    ```ts
    const token = Symbol();
    cache.inFlightTokens.set(key, token);
    try {
      const value = await load();
      if (cache.inFlightTokens.get(key) === token) {
        cache.set(key, { expiresAt: Date.now() + ttlMs, value, cachedAt: Date.now() });
      }
    } finally {
      // Don't blanket-clear inFlightTokens[key] — a bust may have replaced our token with another.
      if (cache.inFlightTokens.get(key) === token) cache.inFlightTokens.delete(key);
      inFlight.delete(key);
    }
    ```
  - Stale hit: return cached value synchronously to the caller; kick off the token+load flow in the background. Do NOT block the request.
  - Miss: await the token+load flow synchronously.
  - Background error: clear in-flight slot (do not bust cache).
- Existing `cachedProviderValue` keeps strict behavior for callers that opt into it (provider-health, etc.).

### Implement: Wire cache into daemon startup

- In `apps/daemon/src/app.ts`, replace `const providerCache = new Map<...>()` with `const providerCache = createProviderCache({ dataDir: config.dataDir, listWorkspaces: () => store.listWorkspaces() })`.
- Boot order: `await providerCache.load()` happens BEFORE route registration so the first request after startup can hit warm cache. The 500ms timeout inside `load()` is the bound.
- Replace `cachedProvider(...)` calls for `vc:*`, `ci:*`, `issue:*` with the stale-fallback variant. Keep `apps:*` and `git:*` strict.
- On server close, `await providerCache.dispose()`.
- The MCP wiring in `mcpDeps = { ..., providerCache, ... }` (`app.ts:703`) takes the new cache transparently — `PersistentProviderCache extends Map` so existing MCP code that calls `providerCache.get(...)` / `providerCache.clear()` / `providerCache.has(...)` works without change.
- Verify `daemon-mcp-tool.test.ts` and `workspace-fs-watcher.test.ts` and **`scheduled-agent-service.test.ts` (lines 58, 100, 167 — `new Map()` constructions)** still pass. Where they construct `new Map()` for a fake cache, that continues to work because the production helpers only require the `Map<string, ProviderCacheEntry>` shape, not the persistence side-channel. Update test type assertions if they reference the old entry shape (missing `cachedAt` / `generation`).

### Implement: Background refresh job

- Create `apps/daemon/src/provider-refresh-job.ts` exporting `startProviderRefreshJob({ store, config, providers, cache, now? })` returning `{ stop, pokeWorkspace }`.
- Implement: tick interval, concurrency cap, single-in-flight per cacheKey, 0–500ms jitter, working-hours gate.
- TOCTOU re-check inside `scheduleProviderRefresh`: validate workspace still non-archived and runtime still healthy at the moment of dispatch (closure over `store`/`config`).
- Wire from `app.ts` after `createWorkspaceFsWatchers`. Enablement via the new `createDaemonApp({ enableRefreshJob = true })` option; `app-test-helpers.ts` sets `false`. Honor `CITADEL_DISABLE_REFRESH_JOB=1` env knob.
- Use `providers.collectGitHubVersionControlSummary`, `providers.collectGitHubCiRuns`, `providers.collectJiraIssueSummary`, `collectRuntimeUsage` — same provider seam as the live routes.
- Do not emit a `provider.refreshed` SSE event in this PR. The client's TanStack `refetchInterval` plus the new dedicated PR-state endpoint cover the refresh notification path; an undocumented SSE event would be debt.

### Implement: fs-watcher → refresh-job poke

- Pass the refresh job's `pokeWorkspace` callback into `createWorkspaceFsWatchers`.
- In `apps/daemon/src/workspace-fs-watcher.ts`'s `onChange` debounce callback, after the existing bust fires, schedule a second-layer debounced (~2s) `pokeWorkspace(workspaceId)`. Reuse a per-workspace timer map.
- Add a unit test asserting the poke fires only after the 2s window after the LAST bust, not after the first.

### Implement: Dedicated `/api/workspaces/pr-state` endpoint

- New route handler in `apps/daemon/src/workspaces-pr-state-route.ts`: `GET /api/workspaces/pr-state` returns `{ workspacePrState: Record<string, WorkspacePrStateEntry> }`.
- Build from cache only:
  ```ts
  const workspacePrState: Record<string, WorkspacePrStateEntry> = {};
  for (const workspace of workspaces) {
    const vc = providerCache.get(`vc:${workspace.id}:${workspace.updatedAt}`);
    const ci = providerCache.get(`ci:${workspace.id}:${workspace.updatedAt}`);
    if (!vc && !ci) continue;
    const vcValue = vc?.value as VersionControlSummary | undefined;
    const ciValue = ci?.value as CiProviderSummary | undefined;
    const cachedAtMs = Math.max(vc?.cachedAt ?? 0, ci?.cachedAt ?? 0) || null;
    workspacePrState[workspace.id] = {
      pullRequest: vcValue?.pullRequest ?? null,
      ciRuns: ciValue?.runs ?? [],
      checkedAt: vcValue?.checkedAt ?? null,
      cachedAt: cachedAtMs ? new Date(cachedAtMs).toISOString() : null,
    };
  }
  ```
- Add `WorkspacePrStateEntry` to `packages/contracts/src/index.ts` and re-export.
- Register the route in `app.ts` near the existing workspace routes.
- Unit test: cached values for workspaces A and B → response includes both; no cache → empty map; removed workspace → entry omitted.

### Implement: Navigator consumes workspacePrState via dedicated hook

- In `apps/web/src/cockpit-tools.tsx`, add `useWorkspacesPrState()` querying `/api/workspaces/pr-state` with `refetchInterval: 30_000` and `staleTime: 25_000`.
- In `apps/web/src/navigator.tsx:172-176`, replace the active-workspace-only check. PR-state lookup precedence per workspace (return first non-null):
  1. If this workspace is active → `activeSummary.versionControl.pullRequest` (10s-fresh via the existing `useWorkspaceCockpitSummary` subscription).
  2. Else → `workspacesPrState[workspace.id]?.pullRequest` (30s-fresh via `useWorkspacesPrState`, plus busted on window focus by the on-focus hook).
  3. Else `null` (grey pill — same as today).
- **Deliberately NOT** reading other workspaces' cockpit-summary caches via `queryClient.getQueryData(...)` inside render — that call is non-subscribing, so the navigator wouldn't re-render when those caches updated. The 30s `useWorkspacesPrState` cadence plus the focus invalidation (`queryClient.invalidateQueries(["workspaces-pr-state"])` from `useFocusRefresh`) is the freshness contract for non-active workspaces. 30s ceiling matches the user-agreed refresh budget.
- Test: `navigator.test.tsx` asserts the precedence (`prefers cockpit-summary for active workspace; uses workspaces-pr-state for all others; falls back to null`).

### Implement: On-focus refresh hook

- Add `apps/web/src/hooks/use-focus-refresh.ts` exporting `useFocusRefresh({ workspaceId, thresholdMs })`. Wires `visibilitychange` and `window.focus`; on focus, reads `queryClient.getQueryState(["workspace-cockpit", workspaceId])?.dataUpdatedAt`. If `Date.now() - dataUpdatedAt > thresholdMs`, calls `queryClient.invalidateQueries(["workspace-cockpit", workspaceId])` AND `queryClient.invalidateQueries(["workspaces-pr-state"])`.
- Call from `apps/web/src/cockpit.tsx` near the active workspace pickup. Threshold sourced from `/api/config` via a small `useConfigQuery` selector (`providerRefresh.focusRefreshThresholdMs`).

### Implement: Usage reload button

- In `apps/web/src/usage-indicator.tsx`'s `UsagePill`, conditionally render `<button>` instead of `<Link>` when `summary` is missing/errored/empty. `disabled={mutation.isPending}` during in-flight.
- Button posts via existing `api(...)` helper; on success, `queryClient.invalidateQueries(["runtime-usage", runtime.id])`.
- CSS: add a `min-width` to the existing `cit-usage-pill` class (size for the widest healthy text `"100%·12h"` + padding). Reload variant reuses chrome with a `RefreshCw` icon (lucide-react, already in the bundle). The `cit-usage-pill--reload` modifier is purely stylistic (e.g. cursor + hover); width-determining tokens stay on the base class.

### Implement: Per-provider usage cadence resolver

- Add `refreshIntervalMs?: number` (min 30s) to `UsageProviderConfigSchema` only. Do NOT add to `RuntimeConfigSchema`.
- Add `resolveUsageRefreshInterval(provider, config)` in `apps/daemon/src/provider-cache.ts` (daemon-owned). Order: provider override → `config.providerRefresh.intervals.usageMs`.
- Use in `runtime-usage-routes.ts` (TTL on the cached call) and the background refresh job.

### Implement: Config schema additions

- Extend `CitadelConfigSchema` with `providerRefresh` (full block in the Implementation Approach section).
- Extend `UsageProviderConfigSchema` with `refreshIntervalMs`.
- Update `packages/config/src/index.test.ts` for: defaults parse, working-hours bounds, interval minimums, `UsageProviderConfigSchema.refreshIntervalMs` minimum, AND the negative regression guard that `RuntimeConfigSchema.shape` does NOT contain `usageRefreshIntervalMs`.

### Implement: Spec breadcrumbs

- Update `specs/B.6-providers-hooks-config.md` line for "Provider data includes refresh age" from `[ ]` to `[~]` (data delivered, UI surfacing partial).
- Update `specs/B.4-git-pr-ci-diff.md` line for "Workspace cards render the PR icon with lifecycle color" from `[ ]` to `[~]` (navigator now drives lifecycle color from cached state for every workspace).
- No other spec checkboxes flip in this PR.

### Implement: Cache busts now persist (audit + flush correctness)

- Sweep every `providerCache.clear()` / `providerCache.delete(...)` / `bustCacheByPrefixes(...)` in `apps/daemon/src/`. Because `PersistentProviderCache` overrides the mutating Map methods, every existing call site is automatically flush-scheduled.
- Confirm `/api/config` PUT (`app.ts:199`), repo deletion (`app.ts:281`), reconcile (`app.ts:537`) and per-workspace/repo refresh endpoints all flow through the subclass's mutating methods.
- No call-site code changes needed beyond using the new factory at construction.

### Migration strategy

No database schema changes. `provider-cache.json` is **not** a tracked-schema artifact — it's a side-effect file:

- File location: `${config.dataDir}/provider-cache.json`.
- New install: file absent, daemon starts with empty cache, first refresh tick populates it.
- Existing install: file absent on first boot of the new daemon, same as new install. Subsequent boots find it and hydrate.
- Schema bump (`version: 1 → 2` in the future): the loader drops all entries on mismatch — no migration code, just stale-but-safe.
- Operator data implications: the file is operator-readable JSON; no secrets are persisted (provider responses don't include tokens). Deletable at any time with no functional loss — daemon will rebuild within one refresh cycle.

No `schema_migrations` row needed (no DB schema change). `PRAGMA foreign_keys = ON` unaffected.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Cache load/persist, stale-while-revalidate semantics, refresh-job scheduling/working-hours/jitter/concurrency, config schema defaults & validation, focus-refresh hook (jsdom), usage-pill reload affordance (React Testing Library). |
| E2E (Playwright) | Required | Cockpit boots with persisted cache and renders PR pill without a 2–5s blank phase; usage reload button appears when usage errors and recovers on click; navigator shows PR pills for non-active workspaces. |

### New tests to add

- `apps/daemon/src/provider-cache.test.ts`:
  - `load() returns empty cache when file is absent`
  - `load() drops entries older than 24h`
  - `load() drops everything on schema-version mismatch`
  - `load() prunes entries whose key references an unknown workspace id`
  - `load() truncates to 5000 entries (most-recently-cached wins)`
  - `load() returns empty when load takes longer than 500ms (timeout)`
  - `load() late-resolving read after timeout does NOT mutate a cache populated since startup` (the `timedOut` flag guard)
  - `load() logs and continues on parse error`
  - `set() / delete() / clear() invalidate the per-key in-flight token AND schedule a debounced flush`
  - `set() during load() (loading=true) does NOT schedule a flush` (hydrate optimization)
  - `set() AFTER the 500ms timeout (loading=false) DOES schedule a flush even if the late read hasn't resolved` (regression guard for the loading-flag leak)
  - `flush() writes atomically (tmp + rename) with mode 0o600`
  - `dispose() flushes pending writes synchronously`
- `apps/daemon/src/app-helpers.test.ts` (extend existing if present, else add):
  - `cachedProviderWithStaleFallback: hit-fresh returns cached without calling load`
  - `cachedProviderWithStaleFallback: hit-stale returns cached and triggers background load`
  - `cachedProviderWithStaleFallback: miss awaits load`
  - `cachedProviderWithStaleFallback: single-in-flight dedup`
  - `cachedProviderWithStaleFallback: background error clears in-flight without busting cache`
  - `cachedProviderWithStaleFallback: token check — bust on SAME key during in-flight discards stale write`
  - `cachedProviderWithStaleFallback: token check — bust on a DIFFERENT key does NOT discard the write` (regression guard for the per-key vs global counter mistake)
- `apps/daemon/src/provider-refresh-job.test.ts`:
  - `skips when outside working hours`
  - `skips when disabled in config`
  - `respects single-in-flight per cacheKey`
  - `respects global concurrency cap`
  - `jitters call start times within configured window`
  - `does not bust cache on provider failure`
  - `re-checks workspace.archivedAt before dispatch (TOCTOU)`
  - `re-checks runtime.health before dispatch`
  - `pokeWorkspace queues an out-of-band refresh for one workspace`
  - `skips when CITADEL_DISABLE_REFRESH_JOB=1`
  - `is gated by enableRefreshJob option, not process.env.VITEST` (regression guard — production never observes VITEST)
- `apps/daemon/src/workspace-fs-watcher.test.ts` (extend):
  - `bust schedules a pokeWorkspace call 2s after the last bust, not after the first` (debounce-of-a-debounce)
- `apps/daemon/src/workspaces-pr-state-route.test.ts` (new):
  - `returns entries for workspaces with cached vc or ci values`
  - `omits workspaces with no cached value`
  - `omits removed workspaces (iterates workspaces, not cache keys)`
  - `serializes cachedAt as ISO-8601 string` (regression guard for the ms/ISO mix)
- `apps/daemon/src/app.test.ts` (extend):
  - `POST /api/workspaces/:id/refresh busts persisted entries (flush is queued)`
  - `daemon boot rehydrates cache and GET /cockpit-summary returns cached body without invoking providers` (assertion: provider collectors are mocked to fail; cached value still flows)
  - `daemon boot is not blocked beyond 500ms when provider-cache.json load is slow`
- `packages/config/src/index.test.ts` (extend):
  - `providerRefresh defaults parse`
  - `providerRefresh.workingHours bounds validation`
  - `providerRefresh.intervals minimum bounds`
  - `UsageProviderConfigSchema.refreshIntervalMs validates min 30s`
  - `RuntimeConfigSchema does NOT contain usageRefreshIntervalMs` (regression guard against contract widening)
- `apps/web/src/usage-indicator.test.tsx` (new):
  - `renders pill with percentage on healthy summary`
  - `renders reload button when summary is missing`
  - `renders reload button when summary.status !== "healthy"`
  - `reload button is disabled while mutation is in-flight`
  - `clicking reload posts /usage/refresh and refetches`
- `apps/web/src/hooks/use-focus-refresh.test.tsx` (new):
  - `does not invalidate when data is fresher than threshold`
  - `invalidates when data is older than threshold and visibilitychange fires`
  - `invalidates when window.focus fires`
  - `invalidates both workspace-cockpit and workspaces-pr-state queries`
  - `does nothing when there is no active workspace`
- `apps/web/src/navigator.test.tsx` (new, if no existing test file — otherwise extend):
  - `renders PR pills for all workspaces with cached state from useWorkspacesPrState`
  - `falls back to grey pill for workspaces without cached state`
  - `prefers cockpit-summary PR for the active workspace`
  - `prefers cockpit-summary cache over pr-state for any workspace with cached cockpit-summary data` (freshness-regression guard for navigated-away workspaces)
- `e2e/provider-caching.spec.ts` (new):
  - `cockpit loads cached PR pills on initial render` — seed a `provider-cache.json` under the isolated `CITADEL_DATA_DIR`, boot daemon, assert pills render within 200ms of `/api/workspaces/pr-state` response.
  - `usage reload button is visible when usage stats are unavailable and recovers usage on click` — use a stub usage provider that fails once then succeeds.
  - `usage reload button preserves top-bar layout width within 2px` — snapshot widths in healthy vs reload states; absolute difference < 2px.

### Existing tests to update

- `apps/daemon/src/workspace-fs-watcher.test.ts`: existing `new Map()` constructions continue to work structurally; if any assertion reads the entry shape, add the new `cachedAt` / `generation` fields. Add the pokeWorkspace debounce test (above).
- `apps/daemon/src/scheduled-agent-service.test.ts` (lines 58, 100, 167): the `new Map()` constructions stay valid because production code only requires the Map shape from these fakes. Spot-check that no test asserts the entry shape strictly.
- `apps/daemon/src/app.test.ts`: tests that boot the daemon must pass `enableRefreshJob: false` via `app-test-helpers.ts` so background refreshes don't leak into the test assertion surface.
- `e2e/operator-cockpit.spec.ts`: if any assertion checks for a "loading" state on first paint, update it to assert immediate cached render (cockpit no longer shows blank for >200ms on warm boots).

### Assertions to add / change / tighten

- Background refresh tick must not run when `enableRefreshJob: false` — assert with a spy on `providers.collectGitHubVersionControlSummary` that it is not invoked after boot when no request comes in.
- Cache flush must be atomic AND set mode 0o600 — assert `fs.stat` returns `mode & 0o777 === 0o600`.
- `cachedAt` is a unix-ms number on disk and internally; on every HTTP response boundary it is an ISO-8601 string (or null). Tighten the contract type — `WorkspacePrStateEntry.cachedAt: string | null`.
- `workspacePrState` keys are workspace ids; the route iterates workspaces (not cache keys), so removed workspaces are omitted.
- Per-key token check (same-key bust): assert that a `cache.delete(key)` between load start and load completion discards the stale write — `cache.get(key)` after the in-flight resolves should NOT be set to the stale-load result.
- Per-key token check (unrelated-key non-interference): assert that a `cache.set(otherKey, ...)` during an in-flight load for `key` does NOT discard the write — `cache.get(key)` after resolution IS set.
- `load()` timeout late-resolution: assert that a `load()` resolving 1s after the 500ms timeout fires does NOT mutate cache entries that have been added since the timeout fired.

### Failure modes / edge cases / regression risks

- **Disk full / write fail**: `flush` rejects; daemon must log and keep running (in-memory cache is still authoritative for the current process).
- **Corrupt JSON on disk**: `load()` returns empty; daemon must not crash. Test-covered.
- **Slow disk on cache load**: 500ms hard timeout; daemon proceeds with empty cache. The in-flight read is abandoned (not awaited). Re-reads on next boot. Test-covered.
- **Clock skew**: cache `cachedAt`s from before a system clock jump back could appear "very fresh". Tolerated; refresh job's interval gate compares relative ages, so a stale clock just delays a refresh by one tick.
- **Daemon worktrees and main daemon share dataDir?**: They do **not** — `defaultDataDir()` already returns `<dataDir>/worktrees/<name>/...` for worktree daemons. Each daemon's cache is its own. No cross-process write conflicts.
- **Concurrent writes**: only one daemon writes its `provider-cache.json`; safe.
- **`workspace.updatedAt` cache keys (orphan accumulation)**: each workspace's cache key embeds `workspace.updatedAt`. When `workspace.updatedAt` changes (rename, namespace move, branch change captured in DB), the old cache entry becomes orphaned. **Mitigated by**: 24h-on-load expiry + workspace-id prune on load + 5000-entry size cap.
- **GitHub rate-limit blowup if user sets very low intervals**: schema enforces `prCiMs >= 15s`, `jiraMs >= 30s`, `usageMs >= 30s`. User can still misconfigure within those bounds; #16 will add backoff.
- **Background refresh during config update**: `/api/config` PUT calls `providerCache.clear()` — the refresh job will repopulate within one tick. Acceptable.
- **FS-watcher fires during background refresh of the same workspace**: watcher busts the cache key. The in-flight refresh completes and tries to write — but the per-key Symbol token has been invalidated by the bust, so the write is dropped. The bust wins. Subsequent reads see a cache miss and synchronously load fresh data. **Test-covered**.
- **Unrelated cache mutation during background refresh**: a refresh-job write to key A happens while a stale-load for key B is in flight. Key B's Symbol token is unaffected (per-key, not global). When B's load resolves, its write succeeds. **Test-covered** — the non-interference test.
- **Late-resolving `load()` after timeout**: the `timedOut` flag set at race-resolution prevents the late then-handler from clobbering a cache that the live system has been populating since boot. **Test-covered**.
- **Edit-storm during background refresh**: fs-watcher busts every 350ms during active editing; cache stays cold for the duration. The 2s pokeWorkspace debounce ensures that once the edit storm settles (no busts for 2s), the cache repopulates on demand instead of waiting up to 15s for the next refresh tick.
- **/api/workspaces/pr-state response size**: dedicated endpoint, narrow invalidation domain. At 50 workspaces × ~2kb = 100kb max. Polled every 30s, not coupled to /api/state's mutation-driven invalidations. Acceptable.
- **MCP consumers**: MCP tools read `providerCache` via the existing wiring (`mcpDeps.providerCache`). `PersistentProviderCache extends Map`, so existing `.get()` / `.clear()` / `.has()` work without change. New `cachedAt` / `generation` fields are additive on the entry; MCP code already accesses `entry.value`. No regression.
- **RuntimeConfig contract surface**: explicitly NOT widened. The per-cadence override lives on `UsageProviderConfigSchema` only. Tests guard against a future drive-by addition.
- **Multi-cockpit / multi-worktree**: each daemon has its own dataDir and its own `provider-cache.json`. Cockpits across worktrees never share cache state. Already true today.
- **Time-of-day boundary**: working-hours gate uses local clock (laptop TZ). DST transitions: one tick may straddle 02:00↔03:00; the gate evaluates whichever local hour applies. Acceptable. Documented in schema description.
- **VITEST env leakage**: production deploys are protected because `enableRefreshJob` is an explicit option defaulting `true`, NOT an env check. Even if `VITEST=1` leaks into the production environment, the refresh job still runs.

### Adversarial analysis

- **How could this fail in production?**
  - `provider-cache.json` accumulates orphan entries across renames. Mitigated by: workspace-id prune on load + 5000-entry size cap + 24h floor. Test-covered.
  - The bust/write race: fs-watcher busts during background refresh. Mitigated by per-key Symbol token in `cachedProviderWithStaleFallback` — same-key bust invalidates the token, unrelated-key activity is non-interfering. Test-covered both ways.
  - Late-resolving `load()` could clobber warmed-up cache after a 500ms boot timeout. Mitigated by the `timedOut` flag captured at race start; the late then-handler early-returns. Test-covered.
  - The background job races with `/api/refresh` endpoints. Single-in-flight dedup keyed by `cacheKey` covers this; both paths go through the same chokepoint.
  - JSON file corruption on `kill -9` mid-write. Atomic temp-rename mitigates.
  - Slow disk on boot. 500ms timeout on `load()`. Daemon proceeds with empty cache; first request synchronously loads.
  - Env-variable leakage disabling the refresh job in production. `enableRefreshJob` is an explicit option, not an env check, so VITEST in production has no effect on the job.
- **What user actions could trigger unexpected behavior?**
  - Setting `providerRefresh.enabled: false` then expecting on-focus refresh to still work — it should (focus is a separate path). Test asserts this.
  - Setting `intervals.usageMs: 10_000` (below min) — schema rejects at load, config write fails with a validation error toast. Existing pattern; covered by `index.test.ts`.
  - Manually editing `provider-cache.json` while daemon runs — the daemon never reads the file after boot, so the edit only takes effect on next boot. Acceptable; document in the file's header comment.
  - Edit storms (rapid file changes) — pokeWorkspace fires 2s after the last bust, so the cache repopulates promptly when the storm settles.
  - Multi-click on the usage reload button — disabled state during mutation prevents spam.
- **What existing behavior could break?**
  - MCP `provider-health` resource uses `cachedProviderValue(...)` for the 15s strict TTL — must keep using the strict variant, not the stale-fallback variant. The plan's app.ts step explicitly preserves this.
  - `app.ts` line gate — the pre-flight extraction step is HARD-GATED on `wc -l < 750` before any new code lands.
  - `RuntimeConfig` contract surface — NOT widened; the per-cadence override lives on `UsageProviderConfigSchema` only. Regression test guards against future widening.
  - `workspace-fs-watcher.test.ts` and `scheduled-agent-service.test.ts` mock `ProviderCache` as `new Map()`. Production code only requires the Map shape from these fakes, so they keep passing. Spot-checked above.
  - `useStateQuery` consumers across the web app: `workspacePrState` is NOT added to `/api/state`; a dedicated endpoint avoids invalidation amplification. Existing `useStateQuery` consumers are unaffected.
- **Which tests credibly catch those failures?**
  - The provider-cache.test.ts atomic-write assertion catches the corruption-on-kill scenario.
  - The provider-cache.test.ts mode-0o600 assertion catches accidental world-readable cache files.
  - The provider-cache.test.ts orphan-prune test catches unbounded growth from renames.
  - The provider-cache.test.ts 500ms-timeout + late-resolution-no-mutation tests catch boot-time regressions on slow disks AND the late-clobber race.
  - The app-helpers.test.ts same-key + unrelated-key token tests catch the bust/write race in both correctness directions.
  - The app.test.ts "daemon boot rehydrates cache and serves it without invoking providers" test catches the cold-cache regression directly.
  - The provider-refresh-job.test.ts concurrency-cap test catches the rate-limit blow-up regression.
  - The provider-refresh-job.test.ts "is gated by enableRefreshJob option, not VITEST" test catches the env-leak regression.
  - The provider-refresh-job.test.ts TOCTOU tests catch config-mutation-mid-tick regressions.
  - The workspaces-pr-state-route.test.ts ISO-string test catches the cachedAt-serialization mix.
  - The config-schema regression-guard test (`RuntimeConfigSchema does NOT contain usageRefreshIntervalMs`) catches future contract widening.
  - The e2e provider-caching.spec.ts warm-boot + width-stability + reload-recovery tests catch user-perceptible regressions.
- **What gaps remain?**
  - No test for "cache file deleted mid-run" — operationally rare; would just degrade to in-memory behavior. Not worth a flaky test.
  - No backpressure metric exposed yet — #16 will add this when it lands rate-limit-aware backoff.
  - We don't test the actual GitHub rate-limit math in CI; that's a deploy-time observation. Plan documents the math; alerting belongs to #16.
  - No test for "background refresh during DST transition" — the gate is hours-based, so the transition just means one tick might evaluate "outside" briefly. Operationally invisible.

## Tests

TDD order; tests come BEFORE the implementation slice they cover.

1. **Pre-flight extraction**: existing `apps/daemon/src/app.test.ts` HTTP-level coverage must continue to pass after the cockpit-summary and state route extractions (no new tests, regression guard).
2. `packages/config/src/index.test.ts` — extend with `providerRefresh` defaults & validation tests + `UsageProviderConfigSchema.refreshIntervalMs` + `RuntimeConfigSchema` negative regression guard.
3. `apps/daemon/src/provider-cache.test.ts` — new; cover load (timeout, orphan prune, 5000-cap), set/delete/clear generation bumps, atomic-flush with mode 0o600, dispose.
4. `apps/daemon/src/app-helpers.test.ts` — extend with stale-fallback tests INCLUDING the generation check (bust during in-flight discards stale write).
5. `apps/daemon/src/provider-refresh-job.test.ts` — new; scheduling + working-hours + concurrency + TOCTOU + pokeWorkspace + the `enableRefreshJob` gate (NOT process.env.VITEST).
6. `apps/daemon/src/workspace-fs-watcher.test.ts` — extend with the pokeWorkspace 2s debounce-of-debounce test.
7. `apps/daemon/src/workspaces-pr-state-route.test.ts` — new; cache-only build, ISO serialization, removed-workspace omission.
8. `apps/daemon/src/app.test.ts` — extend with warm-boot test + 500ms-load-timeout test + refresh-bust-flush test.
9. `apps/web/src/usage-indicator.test.tsx` — new; reload button states, disabled-during-mutation.
10. `apps/web/src/hooks/use-focus-refresh.test.tsx` — new; threshold + event wiring + dual invalidation.
11. `apps/web/src/navigator.test.tsx` — new (or extend if existing); `useWorkspacesPrState` consumption.
12. `e2e/provider-caching.spec.ts` — new; warm-boot 200ms target + usage reload click + width-stability snapshot.

## Schema or contract generation

- `packages/contracts/src/index.ts` gains a `WorkspacePrStateEntry` type and re-exports it. No code-gen step; Vitest type-checks via tsc.

## Verification

Before opening the PR, all of the following must pass:

- `wc -l apps/daemon/src/app.ts` returns `<= 750` AFTER the pre-flight extraction step lands, and stays `<= 800` at every subsequent commit (the file-size check enforces this in CI but it's worth confirming locally).
- `make check` — `check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage`, `check:deps`, `build`.
- `make e2e` — Playwright happy path + the new `e2e/provider-caching.spec.ts` (warm-boot < 200ms, reload-button width stability < 2px, usage recovery on click).
- `make smoke` — daemon HTTP smoke; touches the new `/api/workspaces/pr-state` endpoint and the existing `/api/workspaces/:id/cockpit-summary` to confirm cached read paths.
- `make performance` — confirm cockpit warm-boot first-meaningful-paint isn't regressed by `provider-cache.json` parsing or the new route-extraction wiring.
