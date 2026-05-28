Activate the /implement-task skill first.

# Plan: gh-quota-pass-2

Second-pass optimization on top of the already-shipped pass-1 (`.agents/plans/gh-quota-optimization.md`, branch since merged). Pass-1 introduced the global gh cooldown, viewer-gated polling, per-PR adaptive scheduler, SQLite PR snapshot, and the main-watcher. Steady-state load is still exhausting the **GraphQL** quota (REST is fine — confirmed via `gh api rate_limit`: REST core 46/5000, GraphQL 5000/5000) because:

- Every `gh pr view`, `gh repo view`, `gh pr list`, and `gh run list` invocation uses GraphQL under the hood — and the daemon spawns all four per cockpit-summary cache miss, per workspace.
- The per-commit-checks enrichment loop (10 REST calls per PR per refresh) is dead data — no UI consumer.
- Two workspaces tracking the same PR (the common "stacked PRs" pattern) each spawn their own `gh pr view`. Even after stacked-PR detection finds the parent, the daemon doesn't reuse the parent's PullRequestSummary if that PR is itself attached to another workspace.

This plan cuts steady-state GraphQL load by an expected ~70–85% by removing dead work, lengthening repo-level metadata caches, deduplicating per-PR fetches across workspaces, and dropping a redundant FE poll loop.

## Acceptance Criteria

User-stated requirements (verbatim):

- [ ] After 5 minutes of cockpit usage with 5+ visible workspaces, GraphQL points consumed are <30% of current baseline (measure via `gh api rate_limit` before/after).
- [ ] Navbar PR status badges still update within ~60s of an actual PR state change (manual test: push a commit to a watched PR, observe badge refresh).
- [ ] No regression in `apps/daemon/src/gh-scheduler.test.ts` or `pr-routes` tests.
- [ ] Cache invalidation: PR merge action (`/api/workspaces/:id/pr-merge`) must bust both the per-workspace `vc:` cache AND the global PR cache entry for that PR.
- [ ] Stacked-PR detection still works (parent PR badge renders) — verify via inspector view.

## Context and problem statement

Pass-1 capped runaway burn (cooldown + viewer gate + adaptive cadence) but didn't address the per-summary call shape. Each cockpit summary build for a workspace whose `vc:` cache has expired fires:

| # | Call | Endpoint | Quota |
|---|---|---|---|
| 1 | `gh pr view --json …` | GraphQL | Heavy: 13 fields including `statusCheckRollup`, `commits[]`, `reviews[]`, `reviewRequests[]` |
| 2 | `gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed` | GraphQL | 1 query, fires inside every `currentPullRequest` |
| 3 | `gh pr list --state all --limit 50 --json …` | GraphQL | 50 PRs × multiple edges — single heaviest call |
| 4 | `gh run list --limit 10 --json …` | GraphQL | Not scheduler-gated; fires every cockpit summary |
| 5 | up to 10 × `gh api /repos/{owner/repo}/commits/{sha}/check-runs` | REST | Output not consumed by any UI |

For 5 visible workspaces × 60s poll, steady-state easily exceeds 80 GraphQL points/min (the 5000/hr budget allows ~83/min), which explains GraphQL exhaustion within the hour.

Pass-2 attacks five orthogonal sources of waste:

1. **Dead enrichment work.** `pr-routes.ts:enrichCommitChecks` populates `pr.commits[i].checks` but no UI consumes that field (verified with `grep -rn "commits.*checks\|commit\.checks" apps/web/src` — zero hits except the contract definition).
2. **Repo-config refetched per PR view.** `fetchAllowedMergeStrategies` and `fetchParentPr` are repo-level queries that change rarely (config) or slowly (parent PR set). Currently they fire inside every `currentPullRequest` call.
3. **CI runs not gated.** `collectGitHubCiRuns` is called on every cockpit summary build, bypassing the per-PR scheduler.
4. **Single-workspace duplicate poll.** `useWorkspaceCockpitSummary` polls at 30s while the batch poll covers all workspaces at 60s with a 60s daemon cache — the 30s tick mostly hits cache and never produces fresher data than the batch.
5. **Cross-workspace dedup absent.** Workspaces A and B that both track PR `owner/repo#42` each spawn their own `gh pr view`. The data is identical from GitHub's perspective; only the surrounding workspace differs.

## Spec alignment

Primary spec: **`specs/B.4-git-pr-ci-diff.md`** (PR/CI providers).

**Spec divergence to address.** Line 50 currently reads:

> The cockpit asks at a fast rhythm (60s batch, 30s active workspace); the daemon serves cache or fetches based on the per-PR schedule.

This plan removes the "30s active workspace" half. The spec must be updated to reflect:

> The cockpit asks at a 60s batch rhythm and refetches the active workspace on focus / on `workspace.updated` SSE events; the daemon serves cache or fetches based on the per-PR schedule and a shared global PR cache.

Secondary specs (no behavioral change, just verify nothing breaks):

- `specs/B.2-ade-cockpit.md` — PR pill cycles colors; check list visible. Both keep working since `pr.checks` (the head-rollup field) is unchanged.
- `specs/B.8-ui-performance-quality.md` — "Slow provider commands appear as stale/degraded states." Still honored — the global-cache miss path falls through to existing cooldown / degraded handling.

No new spec items introduced.

## Implementation approach

Six independent refactors plus one new module. **All daemon wiring lands in `apps/daemon/src/gh-quota-wiring.ts`** (currently 281 lines; room to grow) — `apps/daemon/src/app.ts` is at 797/800 lines and cannot absorb any growth without tripping `check:size`. The app.ts edits are restricted to literal TTL constants at existing cache call sites.

1. **Delete `enrichCommitChecks`** end-to-end. Remove from `pr-routes.ts` AND remove `fetchCommitChecks` from `packages/providers/src/index.ts` (and its test). The function has one caller; deletion is self-contained. Leave the `PrCommit.checks` contract field intact (defaulted to `[]`) — touching the contract widens blast radius across packages and external consumers without benefit.
2. **Two long-lived per-repo caches** keyed by `gh-repo-merge-strategies:{nameWithOwner}` (TTL **30 min**) and `gh-pr-list:{nameWithOwner}` (TTL 5 min). Both live in the existing `ProviderCache` Map and share `bustCacheByPrefixes` semantics. **Keyed by `nameWithOwner`, NOT `rootPath`** — so worktrees of the same repo share the cache (the entire point of pass-2). The provider resolves `nameWithOwner` via the existing `resolveRepoFullName` helper from `gh-quota-wiring.ts`; on resolution failure (no remote, test path), the call falls through to a direct gh spawn without populating the cache. **Failure-bust path:** when `mergePr` returns a "merge method not allowed" error, `pr-routes.ts` busts the `gh-repo-merge-strategies:{nameWithOwner}` entry so the next refresh re-derives the actual allowed strategies.
3. **CI runs cache re-key + TTL bump.** Re-key from `ci:{workspace.id}:{workspace.updatedAt}` to `ci:{repo.id}:{repo.updatedAt}` so worktrees of the same repo share the cached `gh run list` result (matches the existing `vc:{repo.id}:…` pattern in `pr-routes.ts:110`). Then bump the TTL from 60s → 180s. Re-keying is the primary win for multi-workspace setups; the TTL bump compounds it. Not gating through the scheduler this pass — scheduler keys are `${repo}#${prNumber}`, mismatched with CI's repo-level nature. Full scheduler integration is a follow-up.
4. **Replace the 30s active-workspace poll with batch-driven invalidation.** Remove `refetchInterval: 30_000` from `useWorkspaceCockpitSummary`. In `apps/web/src/cockpit.tsx`, add a `useEffect` that watches `batchPrSummary.dataUpdatedAt` and, when it changes for the currently active workspace, calls `queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", activeWorkspace?.id] })`. The daemon's `vc:` cache is fresh (just populated by the same batch), so this is a near-zero-cost FE→daemon round trip that hands the inspector identical data to the batch — bringing inspector freshness back to ~60s while spending zero extra gh quota.
5. **De-align VC cache TTL from poll.** Bump `vc:` cache TTL from 60s → 90s. With a 60s poll cadence, daemon cache hit rate goes from ~0% (off-by-one alignment) to ~33%.
6. **New module `apps/daemon/src/global-pr-cache.ts`.** A keyed-by-`{owner/repo}#{number}` cache of `PullRequestSummary` payloads:
   - **Storage:** piggyback on the existing `ProviderCache` Map with key prefix `pr:` so `bustCacheByPrefixes` works uniformly.
   - **Key derivation:** exported `globalPrCacheKey(nameWithOwner, prNumber)` is the ONLY way to build a key. A helper `globalPrCacheKeyForWorkspace(workspace, deps)` resolves `nameWithOwner` via `resolveRepoFullName(workspace.repoId)` and reads `prNumber` from the workspace's PR snapshot — returns `null` if either is missing. **Both read and write paths use this identical helper** so key drift is impossible. A unit test pins this invariant.
   - **TTL derivation:** mirror the scheduler's classification (`pending` → 60s, `green+stable` → 180s, `closed` → 300s, `merged` → no write, returns `Infinity` sentinel). Stored `expiresAt` is computed at write time from the cached classification.
   - **Cooldown contract:** the global cache stores **undecorated** `PullRequestSummary` only. When `vc-fetch-gated` synthesizes a `VersionControlSummary` from a global-cache hit, it passes the result through `decorateWithCooldown` at the call site — same as every other VC payload (see `app.ts:409`, `pr-routes.ts:114/207`). This preserves the B.4:56-58 invariant that EVERY outgoing VC payload reflects the *current* cooldown, not whatever was active at write time.
   - **Head-SHA staleness guard.** On global-cache read, the helper compares the cached `pullRequest.headSha` to the workspace's current local HEAD ref (cheap — single `git rev-parse HEAD`, no gh). On mismatch, the cache hit is discarded and we fall through to the gh path. This prevents workspace A's push from being masked by workspace B's stale cache entry.
   - **Single-flight.** A `Map<GlobalPrCacheKey, Promise<PullRequestSummary>>` deduplicates concurrent misses. On miss, the helper checks the inflight map; if a promise is registered, it awaits that instead of spawning gh. The entry is deleted on resolve/reject. Prevents the 2-workspace thundering herd that would otherwise defeat the cache.
   - **Population:** every successful `recordFetch` in `vc-fetch-gated.ts` writes both per-workspace `vc:` AND global `pr:` entries.
   - **Consultation paths:**
     - **vc-fetch-gated read path.** Before consulting the scheduler, compute `globalPrCacheKeyForWorkspace(...)`. If it resolves and the global cache is fresh AND the head-SHA guard passes, synthesize a `VersionControlSummary` and return early.
     - **fetchParentPr lookup.** Pass a `lookupCachedPr(nameWithOwner, prNumber): PullRequestSummary | null` callback into `collectGitHubVersionControlSummary` (via deps). When `fetchParentPr` resolves a candidate parent number, it consults `lookupCachedPr` first; only spawns `gh pr list` (with its 5-min repo cache) if no cached candidate is found.
   - **Invalidation:** `bustGlobalPrEntry(cache, nameWithOwner, prNumber)` for targeted busts. Called by: `pr-routes:pr-merge` after success, `pr-routes:pr-refresh` force path, and the FS watcher when a workspace's HEAD ref moves.
   - **Persistence (out of scope):** global cache is **process-lifetime only**. Daemon restart re-warms it from the first batch poll per PR. SQLite persistence of full PR summaries is deferred to a future pass — pass-1's per-workspace snapshot is sufficient for restart-cadence preservation.

Module boundary preserved: `packages/providers` does not import from `apps/daemon`. The daemon constructs the lookup callback and the repo-cache lookup, and passes them into the provider via deps.

## Alternatives considered

- **Gate `collectGitHubCiRuns` through the scheduler instead of just bumping cache TTL.** Rejected for this pass: would require synthesizing a per-workspace scheduler key from CI run state (the scheduler keys by `${repo}#${prNumber}`), which is a larger refactor and arguably the wrong abstraction (CI runs are repo-level, not PR-level). Bump-only achieves ~80% of the savings; full gating is a clean follow-up.
- **Drop the `commits` field from `gh pr view --json`** to shrink the query weight. Rejected: `commits` is also used to populate `commits[0].message` for the inspector head-commit line (`cockpit.tsx:505`). The field stays; only the per-commit-checks enrichment goes.
- **Switch parent-PR detection to a GraphQL search query** (`is:pr base:<branch>`) instead of `pr list --limit 50`. Rejected: search has its own rate limit (30/min) and would require an entirely new code path. Caching the existing `pr list` call is the lower-risk move.
- **Move the global PR cache into `packages/providers` as a module-level singleton.** Rejected: would tie cache lifecycle to module load (no `bustCacheByPrefixes` integration) and require provider tests to deal with cross-test cache leakage. Keeping the cache in the daemon respects the daemon-owns-state pattern (see vc-fetch-gated.ts).
- **Push the global cache key into the scheduler itself.** Rejected: scheduler is timing-only; conflating storage and timing concerns would complicate the test surface that pass-1 already stabilized.

## Implementation steps

### Spec updates (FIRST)

- **`specs/B.4-git-pr-ci-diff.md`.** Replace line 50's "(60s batch, 30s active workspace)" with "(60s batch, on-demand for active workspace on focus / SSE invalidation)". Add a one-line bullet noting the global PR cache: "PRs tracked by multiple workspaces share a single cached `PullRequestSummary` keyed by `owner/repo#number` — both the active-workspace fetch and stacked-PR detection consult it before spawning gh."

### A — Delete dead enrichment work

- Remove `enrichCommitChecks` and the `COMMIT_CHECK_CAP` constant from `apps/daemon/src/pr-routes.ts` (lines ~18–100).
- Remove the call site at `pr-routes.ts:176` — the batch endpoint returns the summary as-is.
- Remove `fetchCommitChecks` import from `pr-routes.ts`.
- Remove the `fetchCommitChecks` function from `packages/providers/src/index.ts:687` (and its test in `packages/providers/src/index.test.ts` if present). The function has one caller, being deleted in this PR; the contract field `PrCommit.checks` stays defaulted to `[]` so external consumers are unaffected.
- Leave `PrCommitSchema.checks` in `packages/contracts/src/pr-routes.ts` unchanged.

### B — Long-lived per-repo caches

- New helper type in `packages/providers/src/index.ts`:
  ```ts
  type RepoCacheLookup = (key: string, load: () => Promise<string>, ttlMs: number) => Promise<string>;
  ```
- Thread `RepoCacheLookup` and `resolveNameWithOwner: () => string | null` through `collectGitHubVersionControlSummary` as optional deps. When both are provided, `fetchAllowedMergeStrategies` and `fetchParentPr` resolve `nameWithOwner` first; if it resolves, they wrap the gh call in `RepoCacheLookup`. If `nameWithOwner` is null (test path, no remote), they fall through to a direct gh spawn without populating the cache (existing behavior, no regression).
- In `apps/daemon/src/gh-quota-wiring.ts` (NOT app.ts — see file-size constraint), export a `buildRepoCacheLookup(providerCache, repoFullName)` factory that returns the `RepoCacheLookup` closure keyed by `gh-repo-merge-strategies:{nameWithOwner}` (TTL `30 * 60_000`) and `gh-pr-list:{nameWithOwner}` (TTL `5 * 60_000`). `app.ts`'s only edit at the wiring site is to call the new factory at the existing provider invocation.
- **Failure-bust path:** in `pr-routes.ts:pr-merge`, when `mergePr` returns a result with `ok: false` and `reason` containing `"method"` (heuristic match for "merge method not allowed"), call `providerCache.delete(\`gh-repo-merge-strategies:\${nameWithOwner}\`)` so the next refresh re-derives.

### C — CI runs cache re-key + TTL bump

- Re-key the `ci:` cache from per-workspace to per-repo. Touch sites:
  - `apps/daemon/src/app.ts:388`: change key from `ci:${workspace.id}:${workspace.updatedAt}` to `ci:${repo.id}:${repo.updatedAt}`.
  - `apps/daemon/src/pr-routes.ts:126` already uses `ci:${repo.id}:${repo.updatedAt}` (the provider-summary route). No change needed there.
- Verify `bustCacheByPrefixes(providerCache, [\`ci:${repo.id}\`, ...])` calls at `pr-routes.ts:200` and `pr-routes.ts:234` continue to bust the new per-repo key. Their current form uses `\`ci:${workspace.id}\`` — update to `\`ci:${repo.id}\``.
- Bump TTL from `60_000` to `180_000` at both call sites.
- Bump the matching CI bust in `app.ts:621` (`ci:${workspace.id}` → `ci:${repo.id}`).

### D — FE polling cleanup, replace with batch-driven invalidation

- `apps/web/src/cockpit-tools.tsx:15-31`: remove `refetchInterval: 30_000` from `useWorkspaceCockpitSummary`. Add `refetchOnWindowFocus: true` if not already present. Update the inline comment.
- `apps/web/src/cockpit.tsx` (around line 74-77 where both hooks are called): add a `useEffect` that watches `batchPrSummary.dataUpdatedAt`. When it changes AND `activeWorkspace?.id` is set, call `queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", activeWorkspace.id] })`. Use `useQueryClient` to get the client.
- Verify no other call site depends on the 30s tick.

### E — VC cache de-alignment

- `apps/daemon/src/app.ts:387` (vc-fetch-gated call): bump TTL from `60_000` to `90_000`.
- `apps/daemon/src/pr-routes.ts:112`, `pr-routes.ts:205`, `pr-routes.ts:228`: bump matching `vc:` TTLs from `60_000` to `90_000`.

### F — Global PR cache

- New file `apps/daemon/src/global-pr-cache.ts`:
  ```ts
  export type GlobalPrCacheKey = `pr:${string}#${number}`;

  export function globalPrCacheKey(nameWithOwner: string, prNumber: number): GlobalPrCacheKey;

  export function globalPrCacheKeyForWorkspace(
    workspace: Workspace,
    deps: { resolveRepoFullName: (repoId: string) => string | null; getSnapshot: (workspaceId: string) => { prNumber: number | null } | null },
  ): GlobalPrCacheKey | null;

  // Classification mirrors gh-scheduler.computeNextEligibleAt
  export function classifyTtlMs(summary: PullRequestSummary): number; // Infinity for merged

  export function readGlobalPrSummary(cache: ProviderCache, key: GlobalPrCacheKey): PullRequestSummary | null;

  export function writeGlobalPrSummary(cache: ProviderCache, key: GlobalPrCacheKey, summary: PullRequestSummary): void;

  export function bustGlobalPrEntry(cache: ProviderCache, nameWithOwner: string, prNumber: number): void;

  // Single-flight helper. Returns either the inflight Promise or null; caller registers
  // its own Promise via registerInflight after deciding to fetch.
  export function getInflight(key: GlobalPrCacheKey): Promise<PullRequestSummary> | null;
  export function registerInflight(key: GlobalPrCacheKey, promise: Promise<PullRequestSummary>): void;
  ```
- `apps/daemon/src/vc-fetch-gated.ts`:
  - On entry, compute `key = globalPrCacheKeyForWorkspace(workspace, deps)`. If non-null:
    - Check `readGlobalPrSummary(cache, key)`. If hit AND `summary.headSha === gitHeadSha(workspace.path)` (head-SHA guard via a cheap `git rev-parse HEAD`), synthesize a `VersionControlSummary` and return early (after the daemon-level call site decorates it with cooldown). If the head-SHA mismatches, fall through.
    - Otherwise check `getInflight(key)`. If a promise is registered, await it instead of spawning gh; on resolve, synthesize VC summary from the result.
    - On both-miss, register the inflight promise BEFORE spawning gh.
  - On `recordFetch`, also call `writeGlobalPrSummary(cache, key, vc.pullRequest)` with the undecorated summary.
  - New helper `synthesizeVcFromGlobalCache(workspacePath, cachedPr)`: gathers remotes + default branch via local git (no gh), assembles a `VersionControlSummary` with `status: "healthy"` if local git succeeds, `status: "degraded"` otherwise. Returns the undecorated VC — caller applies `decorateWithCooldown`.
- `packages/providers/src/index.ts`:
  - Add optional dep `lookupCachedPr?: (nameWithOwner: string, prNumber: number) => PullRequestSummary | null` to `collectGitHubVersionControlSummary`.
  - In `fetchParentPr`, after the candidate is identified, call `lookupCachedPr(parentRepo, parentNumber)` first. If hit, build `ParentPr` from the cached summary's fields (`number`, `url`, `headRefName`, `state`) without spawning gh.
- `apps/daemon/src/pr-routes.ts`:
  - `pr-merge` after success: call `bustGlobalPrEntry(providerCache, nameWithOwner, number)`.
  - `pr-refresh` force path: resolve the workspace's PR identity; if present, call `bustGlobalPrEntry`.
- `apps/daemon/src/workspace-fs-watcher.ts` (existing file; the watcher already busts vc:/ci: prefixes on fsChanged): when the changed file is `.git/HEAD` or `.git/refs/heads/<branch>`, also bust the global `pr:` entry for the workspace. Use `globalPrCacheKeyForWorkspace` to derive the key safely.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Cache TTLs, global PR cache logic, scheduler interactions, FE hook polling cadence. |
| E2E (Playwright) | Required | Verify navbar PR badge still refreshes after a remote PR state change; verify stacked-PR badge still renders in inspector. |

### New tests to add

**Daemon unit:**

- `apps/daemon/src/global-pr-cache.test.ts`:
  - `classifyTtlMs` — pending PR returns 60_000; green+stable PR returns 180_000; closed returns 300_000; merged returns Infinity sentinel.
  - `writeGlobalPrSummary` — pending PR writes with ~60s expiry; merged PR no-ops (no entry written).
  - `readGlobalPrSummary` — returns null after TTL elapses; returns summary while fresh.
  - `bustGlobalPrEntry` — deletes only the targeted key, leaves siblings untouched.
  - **Key derivation invariant** — `globalPrCacheKey("foo/bar", 42)` returns exactly `"pr:foo/bar#42"`. `globalPrCacheKeyForWorkspace` returns the SAME key string for two workspaces whose snapshots resolve to the same `(nameWithOwner, prNumber)` pair (regression guard against drift between read/write paths).
  - **Single-flight** — two concurrent calls with the same key produce a single underlying fetch; both callers receive the same resolved value.
- `apps/daemon/src/vc-fetch-gated.test.ts` (new tests in existing file):
  - "global cache hit serves without spawning gh" — seed global cache + workspace snapshot, assert `collectVc` is NOT called.
  - "global cache hit decorates with current cooldown, not write-time cooldown" — seed global cache outside a cooldown, then enter cooldown, then read; assert resulting `versionControl.cooldownUntil` reflects the current cooldown.
  - "head-SHA guard discards cache hit on mismatch" — seed cache with sha A, set workspace HEAD to sha B (mocked `git rev-parse`); assert fall-through to gh path.
  - "global cache miss falls through to scheduler+gh path" — assert existing path runs.
  - "recordFetch populates both per-workspace and global caches" — observe cache state after a successful fetch.
  - "two workspaces sharing one PR — second fetch hits global cache" — drive two fetches with same `(nameWithOwner, prNumber)` from different workspaces; assert `collectVc` called once.
  - "synthesized VC summary status is `degraded` when local git fails" — mock `git rev-parse` failure; assert status field.
- `apps/daemon/src/pr-routes.test.ts` (update existing):
  - Remove tests that asserted commit-check enrichment behavior.
  - Add: "merge action busts global PR cache entry" — after `/api/workspaces/:id/pr-merge`, assert `pr:{owner/repo}#{number}` is absent.
  - Add: "merge-method-not-allowed failure busts merge-strategies cache" — simulate the mergePr failure; assert `gh-repo-merge-strategies:{nameWithOwner}` is absent.
  - Add: assert `ci:` keys are now `ci:{repo.id}:{updatedAt}` shape (not workspace-keyed).
- TTL invariant tests — assert exact configured values at the call sites: 90s for `vc:`, 180s for `ci:`, 30 min for `gh-repo-merge-strategies:`, 5 min for `gh-pr-list:`. A future tweak fails these tests loudly.
- `apps/daemon/src/workspace-fs-watcher.test.ts` (if exists; else add): assert that `.git/HEAD` change busts the workspace's global `pr:` entry.

**Provider unit:**

- `packages/providers/src/index.test.ts` (or a focused new file):
  - "fetchParentPr uses lookupCachedPr first" — supply a stub `lookupCachedPr` that returns a known summary; assert no `gh pr list` is spawned (mock `gh` via `setGithubCommand`).
  - "fetchParentPr falls through to gh when lookup returns null" — assert `gh pr list` IS spawned.
  - "fetchParentPr cache-hit ParentPr shape matches fresh-fetch ParentPr" — deep-equal assertion comparing the cached-path output against the gh-spawn output for the same underlying PR. Snapshot if convenient.
  - "fetchAllowedMergeStrategies hits repo cache when nameWithOwner resolves" — invoke twice; assert `gh repo view` ran once.
  - "fetchAllowedMergeStrategies falls through (no cache write) when nameWithOwner is null" — assert each call spawns gh.
  - "fetchParentPr per-repo list cache hit when nameWithOwner resolves" — invoke twice; assert `gh pr list` ran once.

**Frontend unit:**

- `apps/web/src/cockpit-tools.test.ts`:
  - Remove any test that asserted `useWorkspaceCockpitSummary`'s refetch interval is 30s.
  - Add: `useWorkspaceCockpitSummary` returns a query without a `refetchInterval` (or with `refetchInterval: false`).
  - Add: `useWorkspaceCockpitSummary` still hydrates from `placeholderSummary` instantly on mount.
- `apps/web/src/cockpit.test.tsx` (or wherever cockpit's batch→active invalidation wiring is exercised): add a test that simulates a batch poll success and asserts the active workspace's `["workspace-cockpit", id]` query gets invalidated.

**Frontend unit:**

- `apps/web/src/cockpit-tools.test.ts`:
  - Remove any test that asserted `useWorkspaceCockpitSummary`'s refetch interval is 30s.
  - Add: `useWorkspaceCockpitSummary` returns a query without a `refetchInterval` (or with `refetchInterval: false`).
  - Add: `useWorkspaceCockpitSummary` still hydrates from `placeholderSummary` instantly on mount.

### Existing tests to update

- `apps/daemon/src/pr-routes.test.ts` — drop expectations around `commit.checks` population. Adjust the batch-endpoint assertion shape if it pinned the checks array.
- `apps/daemon/src/vc-fetch-gated.test.ts` — extend the "shouldRefetch:false + cache hit" case to also cover "global cache hit (per-workspace cache cold)".
- `apps/web/src/cockpit-tools.test.ts` — already covered above.

### Assertions to add/change/tighten

- Tighten: `pr-routes.test.ts` already asserts the response shape; add assertion that no per-commit checks are populated beyond the schema default `[]`.
- Add: TTL invariants — assert exact values (90s vc, 180s ci, 6h merge-strategies, 5min pr-list) at the configuration sites so a future tweak fails the test loudly.
- Add: cross-workspace dedup invariant — counter on the mocked `collectVc` reaches exactly 1 for two workspaces sharing a PR.

### Failure modes / edge cases / regression risks

- **Global-cache stale data after PR merge.** Mitigation: merge endpoint busts both `vc:` and global `pr:` entries. Test covers it.
- **Snapshot-vs-cache key mismatch.** Single helper `globalPrCacheKeyForWorkspace` used by BOTH read and write — drift impossible by construction. Pinned by a regression test.
- **Cooldown decoration leak.** Global cache stores undecorated; `decorateWithCooldown` is applied at the call site. Test asserts current-time cooldown is reflected in cache-hit responses.
- **Head-SHA staleness across worktrees.** Cheap `git rev-parse HEAD` check before accepting a cache hit. On mismatch, fall through. FS watcher also busts the entry on `.git/HEAD` change.
- **Two workspaces tracking different branches of same PR number in different repos.** Disambiguated by `nameWithOwner` in the key — verified by test.
- **`fetchAllowedMergeStrategies` cache returning a stale "allow"** for a strategy the repo no longer accepts. TTL is 30 min; merge attempt itself surfaces a clear error from gh, which busts the cache via the failure-bust path; the operator's retry then uses fresh data. Acceptable lag window.
- **`fetchParentPr` cache returning stale parent state.** Parent PR closed/merged in the last 5 min would still show as open. Acceptable visual lag.
- **Synthesized `VersionControlSummary` from global cache differs from a fresh fetch.** Synthesizer fills `pullRequest` from cache; remotes/default-branch from authoritative local git. Status is `"healthy"` only when local git succeeds; `"degraded"` otherwise. Test asserts shape equality with a fresh-fetch fixture.
- **Inspector freshness regression from dropping 30s poll.** Mitigation: batch-poll success drives an invalidation of the active workspace's query, serving from the daemon's just-populated `vc:` cache. Inspector freshness ~60s (matching batch). `refetchOnWindowFocus` covers tab-switch cases.
- **Concurrent cache miss (thundering herd).** Single-flight via `inflight` Promise map: concurrent misses share one underlying fetch. Test covers it.
- **Daemon restart wipes the in-memory global cache.** Documented as in-scope behavior. First poll after restart re-warms via gh; subsequent polls dedupe. Pass-1's SQLite snapshot still preserves scheduler cadence across restart.

### Adversarial analysis

- **How could this fail in production?** The global cache could mask a state change if SSE invalidation drops a `workspace.updated` event and TTL hasn't expired. Mitigation: TTLs are short (≤5min); force-refresh exists; main-watcher still flips `needsMergeStateRefresh`.
- **What user actions trigger unexpected behavior?** Toggling repo merge config in GitHub UI then immediately trying to merge from cockpit could show a strategy that isn't actually allowed. The merge call itself fails cleanly at gh — acceptable.
- **What existing behavior could break?** Stacked-PR detection. Test: stacked-PR e2e (existing in `e2e/pr-display.spec.ts` if covered there) must still pass.
- **Which tests credibly catch those failures?** New global-cache invalidation test + existing stacked-PR e2e + the per-repo cache tests.
- **What gaps remain?** No header-based proactive backoff (`X-RateLimit-Remaining`). The cooldown gate from pass-1 still requires hitting a rate-limit error to engage. Documented as a non-goal.

## Tests

TDD order — write tests first, then implementation:

1. `apps/daemon/src/global-pr-cache.test.ts` (new)
2. `apps/daemon/src/vc-fetch-gated.test.ts` (extend)
3. `apps/daemon/src/pr-routes.test.ts` (update + extend)
4. `packages/providers/src/index.test.ts` (extend or new focused file)
5. `apps/web/src/cockpit-tools.test.ts` (update)

E2E (no new files; rerun existing):

- `e2e/pr-display.spec.ts` — verify stacked-PR badge still renders.
- `e2e/operator-cockpit.spec.ts` — verify navbar PR pill states.
- `e2e/pr-conflicts.spec.ts` — verify mergeStateStatus still surfaces correctly.

## Schema or contract generation

No schema changes. No contract generation needed (PrCommit.checks contract field is preserved, just no longer populated by the daemon).

## Verification

Run before opening the PR:

- `make check` — typecheck, lint, unit tests, coverage, build, arch/size/deps gates. **`check:size` will catch any accidental growth past 800 lines in `app.ts`.**
- `make smoke` — daemon HTTP surface changes (vc/ci cache TTLs/keys, merge endpoint cache busting, force-refresh global-cache bust).
- `make e2e` — Playwright PR-display + cockpit + conflicts specs.

Skip `make performance` — no hot-path rendering changes.

### Quota baseline measurement (AC #1)

The numeric AC requires <30% of current GraphQL consumption. Capture before merging:

1. **Baseline:** with the merge-base of `main`, run the daemon with 5+ visible workspaces, poll the cockpit for 5 min, then `gh api rate_limit -q '.resources.graphql.used'` at T0 and T+5min. Record delta as `baseline_graphql_used`.
2. **Post-change:** repeat with the pass-2 branch checked out. Record delta as `pass2_graphql_used`.
3. PR description must include both numbers and assert `pass2_graphql_used / baseline_graphql_used < 0.30`.

If the ratio fails, the PR is not ready to merge; revisit the cache-hit instrumentation before tuning further.
