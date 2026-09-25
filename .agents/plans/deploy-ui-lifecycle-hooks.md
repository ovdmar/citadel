Activate the /implement-task skill first.

# Plan: Deploy UI & Lifecycle Hooks

## Acceptance Criteria

Verbatim from the Citadel scratchpad topic "Deploy UI & lifecycle hooks":

- [ ] Deploy button: spinner + prevent double-tap; hardcode a few seconds if real deploy time can't be tracked.
- [ ] Local deploys: track the running deploy command and show a spinner while it runs.
- [ ] Citadel deploy hook must redeploy everything (not just the UI).
- [ ] Teardown hook — runs before a workspace is killed; repo-configurable; documented alongside the deploy hook.

## Context and problem statement

The cockpit's "Local deploys" panel (`apps/web/src/deployed-apps.tsx`) renders a Redeploy chip per app and a panel-level "redeploy all" icon when ≥2 apps are returned. Today:

- Double-tap is already prevented via `disabled={redeploy.isPending}` (`apps/web/src/deployed-apps.tsx:38,79`).
- The `RefreshCw` icon does **not** visually animate while pending — it just dims via the disabled state. Users get no positive signal that a deploy is running.
- The HTTP route `POST /api/workspaces/:id/deployed-apps/redeploy` (`apps/daemon/src/extra-routes.ts:38`) awaits `operations.redeployApp` (`packages/operations/src/deploy.ts:100`) until the hook exits. For most repos this is fine, but for **Citadel deploying itself** the hook delegates to `make -s deploy` (`.citadel/hooks/deploy:116`), which kills the dev stack's process group as its first step (`Makefile:118-127`). The daemon serving the redeploy request is part of that pgid — so the HTTP connection drops mid-flight, the React Query mutation transitions to `error`, `isPending` flips to `false`, and the spinner that never spun also disappears. The user sees no progress while the new daemon boots ~5–10s later.
- The operator panel for operations (`apps/web/src/routes/operations.tsx`) lists deploy operations but has **no deep-link by id**: verified — its route at `apps/web/src/main.tsx:71-74` has no `validateSearch`, and `OperationsView` has no `useSearch` / selection state. So routing the user there with `?id=…` today is a silent no-op. This plan must extend the route to honor an `id` query param before adding the "View log" link.
- Teardown hooks exist as a `workspace.teardown` event in `HookEventSchema` (`packages/config/src/index.ts:43`), configured per repo via `repo.teardownHookIds` (`packages/config/src/index.ts:136`), and are executed by `OperationService.removeWorkspace` between tmux session kills and worktree cleanup (`packages/operations/src/index.ts:444-481`). They are blocking by default; on hook failure with `!input.force`, the operation fails and worktree cleanup is skipped; with `input.force`, the error is swallowed silently (no warning log today) and cleanup proceeds.
- However, the teardown hook has **no file-based discovery analog** — unlike the deploy hook which can be a plain executable at `.citadel/hooks/deploy` (`packages/hooks/src/deploy.ts:20`). A repo can today only declare a teardown by editing the operator's config to add a `HookConfig` entry plus referencing its id from `repo.teardownHookIds`. That is friction for "repo-shipped lifecycle scripts" — the same friction the deploy hook's file path was introduced to solve.
- Teardown hooks are referenced in `specs/B.6` line 51 and `specs/B.1` line 88 but have no operator-facing docs alongside `deployHookCommand`/`.citadel/hooks/deploy` in `docs/operations/config-reference.md`.
- The daemon's `/api/state` endpoint (`apps/daemon/src/app.ts:168`) does NOT currently include the daemon's process start timestamp. We need it for the watchdog to reliably distinguish "the OLD daemon answered while shutting down" from "the NEW daemon is up".
- The Operation contract (`packages/contracts/src/index.ts:743` — `Operation = z.infer<typeof OperationSchema>`) has only an `error: string | null` field — verified. There is no `error_detail` field; structured error tails must be embedded into the `error` string (matching the existing redeploy pattern at `packages/operations/src/deploy.ts:148` — `result.stderrTail.trim().slice(-1000)`).

This plan delivers:

1. A real, visible spinner on the deploy chip with a minimum-spin floor so brief or aborted-by-self-restart deploys still read as "in progress" — but only for success and network-drop paths, NOT for honest 4xx/5xx errors.
2. UI bridging from the redeploy chip to the operation row, including the missing `?id=…` deep-link surface on `/operations`.
3. A graceful "the daemon I'm waiting on just restarted itself" fallback that keeps the spinner alive until a *newer* daemon answers — using a process-start token to avoid the stale-old-daemon race.
4. A file-based `.citadel/hooks/teardown` discovery path mirroring the deploy hook contract, layered on top of the existing `repo.teardownHookIds` mechanism, ordered BEFORE tmux kill so a failure leaves nothing damaged.
5. Documentation that puts deploy and teardown hooks side-by-side in `docs/operations/config-reference.md`, with the dual-discovery (file vs. config) explained for both, including the explicit caveat for "your hook is going to kill the daemon you're talking to".

### Why no `.citadel/hooks/teardown` for Citadel itself

The obvious worked example — `.citadel/hooks/teardown` runs `make -s stop` — has a self-foot-gun: `make stop` kills the dev stack's pgid, which is the SAME daemon currently executing `removeWorkspace`. The HTTP response never returns; tmux-kill happened (since teardown runs first) but worktree-prune and DB-delete didn't, leaving a half-removed workspace. The plan therefore does NOT ship a Citadel teardown hook. Removing a Citadel worktree from the cockpit will leave its dev stack zombie; this is a cosmetic issue (the next `make deploy` from another worktree kills any orphan via fuser, and `make stop` from a terminal works manually). The docs subsection calls out this limitation as a known constraint for "your hook lives inside the workspace it's tearing down".

## Spec alignment

| Spec | Section(s) | Action |
|---|---|---|
| `specs/B.5-apps-links-actions.md` | Deploy Workflow §1–§5 | Existing items 1–5 are already met or strengthened. No new items. |
| `specs/B.6-providers-hooks-config.md` | Hooks §3 | Refine to: "Teardown hooks are configured per repo (via `repo.teardownHookIds`) and/or discovered as an executable at `.citadel/hooks/teardown` in the workspace." Keep numbering. |
| `specs/B.1-repositories-workspaces.md` | Archive And Remove Workspace §4 | Refine to: "Remove workspace can run repo teardown hooks (resolved from `repo.teardownHookIds` and/or `.citadel/hooks/teardown`)." |
| `specs/B.2-ade-cockpit.md` | Local deploys / inspector panels (if a corresponding bullet exists) | Add a phrase noting "deploy chip surfaces in-flight redeploy state with a spinner and a link to the operation log." If no exact bullet maps, leave to B.5 untouched. |
| `specs/B.7-operations-activity-mcp.md` | Operations | Add a checkbox under Operations: "Operation rows are deep-linkable from elsewhere in the cockpit via `?id=…` on `/operations`." |
| `specs/B.8-ui-performance-quality.md` | UI feedback latency | No change — spinner appears under 200ms feedback budget. |

Spec edits are the FIRST implementation step before any code.

No conflicts with `specs/A-shared-definitions.md` (Hook / Operation / Workspace usage already canonical).

## Implementation approach

The four AC bullets are tightly coupled and would churn the same files if split, so they ship in one PR organized as the steps below. There are seven implementation steps plus tests.

### Minimum-spin floor and watchdog rationale (refined)

- **Minimum-spin floor (`MIN_SPIN_MS = 4000`)**: applied ONLY to (a) successful mutations and (b) the network-drop watchdog path. Honest 4xx/5xx errors clear the spinner immediately and surface the error toast — no masking. The 4s value matches the observed median for the Citadel self-deploy path (`Makefile:163` waits up to 20s; typical is 3–5s).
- **Watchdog window (`WATCHDOG_MAX_MS = 30000`, `WATCHDOG_INTERVAL_MS = 1000`)**: triggered when the redeploy mutation errors with a network signature (e.g., `TypeError: NetworkError`, `Failed to fetch`, aborted). Polls `/api/state` once per second up to 30s.
- **Stale-daemon-race avoidance**: at trigger time, the UI captures the daemon's current `daemonStartedAt` from app-state (or its own pre-fetch). The watchdog only clears `inFlight` when `/api/state` returns a STRICTLY NEWER `daemonStartedAt`. This eliminates the race where the dying daemon answers during graceful shutdown.
- **MIN_SPIN_MS** carries a `TODO(B.7-SSE)` comment so future progress streaming work knows to revisit it.

## Alternatives considered

1. **Server-Sent Events / WebSocket for live operation progress.** Rejected for this PR. Right long-term answer (B.7) but doubles surface area. Polling watchdog covers the daemon-self-restart case with no new transport.
2. **Switch the HTTP route to fire-and-forget (return 202 immediately).** Rejected. Today's synchronous-await behavior is the cross-repo deploy contract; changing it would force every consumer to poll and would not actually fix the Citadel self-deploy problem (the connection still drops).
3. **Citadel deploy hook forks a detached helper before killing the parent group.** Rejected — bash-level surgery for one repo, complicates the worked example. UI watchdog handles the symptom for any repo whose deploy hook restarts the daemon.
4. **File-based teardown hook OR config-based, not both.** Rejected. Deploy has dual model and operators have built mental models around it. Symmetry beats minimalism here.
5. **Run file-based teardown AFTER configured hooks.** Rejected. Repo-shipped teardown drains local state; operator-defined hooks then process a stable snapshot.
6. **Run teardown after tmux kill (current order for configured hooks).** Rejected for the new file-based path. With the new path running BEFORE tmux kill, a failed teardown leaves NOTHING damaged — strictly safer than the existing configured-hooks order. To avoid a behavior split between the two teardown paths, **this plan also moves configured-hook teardown to before tmux kill** (see Step 4 ordering).
7. **Skip the operation-log "View log" link.** Rejected. AC bullet 2 ("track the running deploy command") wants the link. But it requires extending `/operations` to honor `?id=…` — which is now Step 7b.
8. **Just wait MIN_SPIN_MS unconditionally without a daemon-start-token watchdog.** Rejected. Without the token, the watchdog clears the spinner on the dying daemon's last gasp and the next click hits a connection-refused.
9. **Ship `.citadel/hooks/teardown` for Citadel that conditionally avoids self-suicide.** Rejected — the detection logic ("is this MY daemon I'd be killing?") is fiddly (check `.citadel/dev.json`, compare PIDs, etc.) and would obscure the worked example. Cleaner to document the limitation.

## Implementation steps

### Step 0 — Pre-flight checks (before any code)

- **Verify `animate-spin` is in the Tailwind build.** Run `pnpm -w build:web` and grep `apps/web/dist/**/*.css` for `animate-spin` OR grep `apps/web/src/**` for an existing usage. If absent, ship the fallback CSS (Step 8) in the same commit BEFORE writing the test in `deployed-apps.test.tsx` that asserts the spin class. The test must reference whichever class actually ships — `animate-spin` (Tailwind) or `icon-spin` (fallback).

### Step 1 — Spec edits (FIRST, before any code)

- `specs/B.1-repositories-workspaces.md` §Archive And Remove Workspace §4: refine to mention dual discovery for teardown.
- `specs/B.6-providers-hooks-config.md` §Hooks §3: refine to mention dual discovery for teardown.
- `specs/B.7-operations-activity-mcp.md` §Operations: add bullet for deep-linkable operations via `?id=…`.
- `specs/B.5-apps-links-actions.md`: no changes (Deploy Workflow §1–§5 already cover the surface).
- `specs/B.2-ade-cockpit.md`: only add a phrase if a Local-deploys bullet already exists; otherwise leave to B.5.

### Step 2 — Contracts and types

- `packages/contracts/src/index.ts`:
  - Add `TeardownHookResolutionSchema` and `TeardownHookResolution` type. Shape: `{ source: "repo-file" | "none"; filePath: string | null; note: string | null }`.
  - JSDoc on the type explicitly notes: "Resolution covers ONLY the `.citadel/hooks/teardown` file-based path. Configured hooks (`repo.teardownHookIds`) are resolved separately by the hooks runner in `packages/operations`; both paths are executed in `removeWorkspace` (file first, then configured)."
  - Add a `daemonStartedAt: z.string()` field (ISO) to whichever schema represents the `/api/state` response shape. If the daemon's state response shape isn't a single named schema (verify in `apps/daemon/src/app.ts`), inline the field at the response-build site and document in the docs subsection — no contract entry required.
- No DB schema changes (see Migration strategy).

### Step 3 — Teardown hook module

- New file `packages/hooks/src/teardown.ts`:
  - Export `TEARDOWN_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "teardown")`.
  - Export `resolveTeardownHook({ workspacePath }) → TeardownHookResolution`. Returns `repo-file` (executable file present), `none` with a diagnostic `note` when the file exists but is not executable (matches `inspectHookFile` in deploy.ts), `none` with `note: null` when missing.
  - Export `runTeardownHook({ resolution, env, timeoutMs, onOutput }) → Promise<{ exitStatus: number | null; stderrTail: string }>`. Spawn with no subcommand args, `stdio: ["ignore", "pipe", "pipe"]`, `detached: false`, line-buffered streaming (same `replace(/\s+$/, "")` + split-on-newline pattern as deploy), timeout enforced via `setTimeout(child.kill("SIGKILL"), timeoutMs)`.
  - Env passed: `CITADEL_WORKSPACE_ID`, `CITADEL_WORKSPACE_PATH`, `CITADEL_WORKSPACE_BRANCH`, `CITADEL_REPO_ID` (same as deploy hook).
- Internals follow `deploy.ts` shape. If a shared helper is naturally extractable (≤30 lines), do it; otherwise duplicate-and-move-on (~50 lines, tolerable per Citadel size policy).
- Export the new module from `packages/hooks/src/index.ts`.

### Step 4 — Wire teardown hook into removeWorkspace (with ordering + force semantics)

In `packages/operations/src/index.ts` `removeWorkspace`, modify the cleanup sequence so it becomes:

```
1. Check root / dirty-git gates (unchanged: lines 410-441)
2. If !input.archiveOnly && !worktreeMissing:                       ← guard, mirrors existing line 453
     a. Resolve file teardown hook (NEW)
     b. Run file teardown if resolved (NEW)
     c. Run configured teardown hooks (existing runWorkspaceHooks; MOVED before tmux kill)
3. Kill tmux sessions (currently lines 444-450)                     ← MOVED to after hooks
4. Prune worktree (existing cleanupWorktree, lines 484-486)
5. DB archive/delete (existing, lines 488-494)
```

**`archiveOnly` interaction (CONCERN A from review):** when `input.archiveOnly === true`, BOTH the file-teardown and configured-teardown steps are skipped (mirrors today's `!input.archiveOnly` guard at line 453). Archive-only means "keep the worktree on disk and just hide the workspace from active views" — running destructive hooks against a preserved worktree would violate that promise. Unit test pins this: `removeWorkspace with archiveOnly:true does NOT invoke .citadel/hooks/teardown OR configured teardown hooks`.

Failure semantics — explicit 3-state table (file teardown):

| State | File teardown result | `input.force` | Action |
|---|---|---|---|
| A | Hook absent / `archiveOnly` / `worktreeMissing` | any | Skip file-teardown step; continue (to configured hooks if applicable). |
| B | Hook fails (exit ≠ 0 OR throws OR timeout) | `false` | Fail operation with labelled error: `error = "file teardown failed: " + (stderrTail.trim().slice(-1000) \|\| "exit " + exitStatus)`. Emit `workspace.remove.blocked` activity and `workspace.teardown.file.failed` activity. DO NOT touch tmux/worktree/DB. Return `{ removed: false, archived: false, dirty }`. |
| C | Hook fails | `true` | Append warning log `[teardown] file teardown failed (exit N): {stderrTail}; continuing because force=true`. Continue with configured hooks → tmux kill → worktree prune → DB delete. |

Configured teardown hooks (`runWorkspaceHooks`) keep their current behavior with one fix and one labelling change:
- When `input.force` swallows the error today (lines 461-480), append a warning log `[teardown] configured hook failed: {message}; continuing because force=true` instead of swallowing silently.
- The error string set on the operation (when `!input.force`) gets prefixed too: `error = "configured teardown failed: " + (error.message ?? "workspace_teardown_failed")`. This addresses CONCERN B (review round 2): UI/operator alerting can now disambiguate "file" vs "configured" failure from the same operation type without inferring it from logs.

Operation log lines for the file-teardown path are prefixed `[teardown]`. Activity events: emit `"workspace.teardown.file"` on success, `"workspace.teardown.file.failed"` on failure (distinct from `"workspace.remove.blocked"` so the activity feed can show both signals).

**Cwd invariant:** the file teardown hook is spawned with `cwd = workspace.path`, and an invariant check ensures `fs.existsSync(workspace.path)` immediately before spawn. If the worktree path was removed externally between the lifecycle gate and the teardown invocation, log a warning and skip the file-teardown step (treat as "absent"). This protects against any future refactor that reorders worktree-pruning to before hooks.

### Step 5 — Citadel deploy hook completeness (no Citadel teardown hook)

- `.citadel/hooks/deploy` line 109 area: add a comment "delegating to `make deploy` restarts BOTH daemon (tsx watch) and vite under one pgid". No behavior change.
- **Do NOT add `.citadel/hooks/teardown`**. Reason: the file lives inside the workspace it would tear down; `make -s stop` kills the daemon mid-`removeWorkspace`. The docs subsection (Step 9) documents this constraint and tells operators to write a teardown hook ONLY when the hook can run cleanly without killing the workspace's own daemon.

### Step 6 — Daemon: expose `daemonStartedAt` in `/api/state`

- In `apps/daemon/src/app.ts` near the existing `/api/state` handler (line 168):
  - Capture `daemonStartedAt = new Date().toISOString()` at module init (or use `process.uptime()` to derive). Single line near top of `app.ts`.
  - Include `daemonStartedAt` in the `/api/state` response body.
  - Add a JSDoc/comment at the field site: `// Identity token for this daemon process. Watchdogs use strict inequality to detect a restart; do NOT use this for time arithmetic.` (per SUGGESTION F from review round 2.)
- No type changes required if state isn't a typed Zod schema today; otherwise add to the schema.
- Smoke test: `pnpm smoke` includes a hit to `/api/state` — assert the field is present and is a parseable ISO date.

### Step 7 — Deploy UI: spinner, watchdog, operation link

#### Step 7a — `apps/web/src/hooks/use-redeploy.ts` (NEW)

State machine module:

- Constants:
  - `MIN_SPIN_MS = 4000` // TODO(B.7-SSE): revisit when operations stream progress.
  - `WATCHDOG_MAX_MS = 30000`
  - `WATCHDOG_INTERVAL_MS = 1000`
- API: `useRedeploy(workspaceId) → { inFlight: boolean; trigger: (name?: string) => void; lastOperationId: string | null; targetName: string | undefined; error: Error | null }`.
- Behavior:
  - **Trigger.** Always performs a one-shot synchronous fetch of `/api/state` to capture the current `daemonStartedAt` (CONCERN C from review round 2 — do NOT rely on the cached query value, which may be arbitrarily stale). The pre-fetch is wrapped in `AbortSignal.timeout(1500)` so it never delays spinner-on by more than 1.5s (round 3 suggestion). If the pre-fetch fails with a network error OR aborts on the timeout, fall back to `null` (treat the watchdog's "newer-token" check as "any 2xx response with a `daemonStartedAt`"). Then set `inFlight = true`, `targetName = name`, `lastOperationId = null`, `error = null`, start the `MIN_SPIN_MS` timer, and fire the POST mutation.
  - **Success path.** Captures `operationId` from response body. If `MIN_SPIN_MS` has elapsed → `inFlight = false`; invalidates the deployed-apps query. Else wait for the timer.
  - **Network-error path** (matches `TypeError`, `Failed to fetch`, aborted, or generic fetch failure with no Response). Enter watchdog: poll `/api/state` every `WATCHDOG_INTERVAL_MS` for up to `WATCHDOG_MAX_MS`. Clear `inFlight` only when the poll returns a `daemonStartedAt` strictly newer than the captured pre-redeploy value. On `WATCHDOG_MAX_MS` timeout, clear `inFlight`, emit a `console.warn`, and trigger a `toast.warning("Redeploy may still be in progress — check the operations log.")` via `apps/web/src/toaster.ts` (verify the toast surface during implementation; if not present, fall back to a non-blocking inline notice in the panel).
  - **Non-network error path** (any error with a parseable HTTP response body OR a structured error): set `error`, clear `inFlight` **immediately** (no MIN_SPIN_MS floor — honest errors should not be masked). Invalidate deployed-apps so the chip status reflects reality.
- Network-error detection: prefer testing for absence of a Response object (typical fetch failure) and string-matching `"TypeError"`/`"Failed to fetch"`/`"NetworkError"` in the error message. Document the heuristic in a code comment.
- **Cleanup (CONCERN E from review round 2):** `useRedeploy` MUST explicitly clean up its timers and abort in-flight watchdog polls on unmount. Implementation pattern: keep `setTimeout` ids and a `aborted: boolean` ref; the `useEffect` cleanup function calls `clearTimeout` for the MIN_SPIN_MS timer, `clearInterval` for the watchdog poll, and flips `aborted = true` so any in-flight `fetch` resolves into a no-op. All state setters are guarded with an `if (aborted) return` check. Unit test: `useRedeploy unmounts cleanly during an active watchdog poll with no setState-on-unmounted warnings`.

#### Step 7b — Operations route gains `?id=…` deep-link

- `apps/web/src/main.tsx` `operationsRoute`: add `validateSearch: z.object({ id: z.string().optional() }).parse`.
- `apps/web/src/routes/operations.tsx`:
  - Import `useSearch` from TanStack Router; read `id`.
  - When `id` matches an operation in the list, render its row with a `.highlighted` class AND scroll it into view (CONCERN D from review round 2: use `useEffect(() => { rowRef.current?.scrollIntoView({block:"center"}) }, [id])` — keyed on `id`, NOT on mount, so navigation from a "View log" click while already on `/operations` re-triggers the scroll for the new id).
  - Expand the operation's details panel (existing UI already supports expansion — verify wiring).
  - When `id` doesn't match (operation purged or never existed), render the list unfiltered and show a transient note "Operation {id} not found" at the top of the list.

#### Step 7c — `apps/web/src/deployed-apps.tsx`

- Replace the inline `useMutation` with `useRedeploy(workspaceId)`.
- Both buttons: `disabled={state.inFlight && targetMatches}`, `aria-busy={state.inFlight && targetMatches}`. The icon receives `className="animate-spin"` (or fallback `icon-spin`) when its slice is in flight.
- Per-chip in-flight scoping: only the chip whose name matches `state.targetName` spins; the panel-level button spins only when `state.targetName === undefined`.
- When `state.inFlight && state.lastOperationId` is known, render a compact `<Link to="/operations" search={{ id: state.lastOperationId }}>View log</Link>` next to the chip grid (or next to the panel-level button when "all" was triggered).
- When `state.lastOperationId` is unknown (network-error path before response), omit the link — there's nothing to link to.

### Step 8 — CSS fallback (only if Step 0 reveals `animate-spin` missing)

- Append to `apps/web/src/cockpit.css` (or whichever file contains `.icon-button` — Step 0 identifies it):
  - `@keyframes citadel-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`
  - `.icon-spin { animation: citadel-spin 1s linear infinite; }`
- Use the fallback class consistently in the deploy chip (and tests) instead of `animate-spin`.

### Step 9 — Documentation

- `docs/operations/config-reference.md` under `## Hooks`:
  - Add `### Deploy hook` subsection: dual discovery (`.citadel/hooks/deploy` file OR `repo.deployHookCommand` config), `list` / `redeploy [name]` subcommands, env vars, output streaming to operation log, exit-status semantics.
  - Add `### Teardown hook` subsection: dual discovery (`.citadel/hooks/teardown` file OR `repo.teardownHookIds` referencing a `HookConfig` with `event: "workspace.teardown"`), no-subcommand contract, env vars, blocking behavior, file-then-configured ordering, force-cleanup interaction (3-state table from Step 4), and an explicit "do NOT use a teardown hook that kills the daemon you're talking to" caveat with the Citadel-self-teardown example as a worked anti-pattern.
  - Cross-link the two subsections so operators see the symmetry; explicitly mention that `TeardownHookResolution` covers only the file-based path and configured hooks are resolved separately.

### Migration strategy

**No schema changes.** This change adds no new tables, columns, indexes, or `schema_migrations` rows. `PRAGMA foreign_keys = ON;` is unaffected. Operator databases need no migration. No data implications.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | (a) `packages/hooks/src/teardown.test.ts` — file resolution + execution + timeout. (b) `packages/operations/src/index.test.ts` (existing file, extended) — `removeWorkspace` invokes file teardown BEFORE tmux kill; file teardown failure with `!force` blocks ALL subsequent cleanup; with `force=true` continues with explicit warning log; cwd-invariant guard skips file teardown when path disappeared. (c) `apps/web/src/hooks/use-redeploy.test.ts` — minimum-spin floor on success, immediate clear on non-network error, watchdog requires newer `daemonStartedAt`, timeout path. (d) `apps/web/src/deployed-apps.test.tsx` — spinner class during in-flight, double-tap disabled, "View log" link rendered when operationId known, per-chip scope. (e) `apps/web/src/routes/operations.test.tsx` — `?id=…` highlights/expands the matching row; missing id shows the not-found note. |
| E2E (Playwright) | **Required** | (a) `e2e/deploy-redeploy.spec.ts` — open a workspace with apps, click Redeploy, assert spinner class appears within 100ms, button disabled, spinner removed and grid refreshes after completion, "View log" link present and routes to `/operations?id=<op>`. (b) `e2e/workspace-teardown-hook.spec.ts` — create a workspace whose `.citadel/hooks/teardown` writes a sentinel; remove the workspace; assert the sentinel exists AT the time of worktree removal (file written but worktree still intact at sentinel-stat time); operation log shows `[teardown] …` lines in expected order (file → configured). (c) Citadel-self-deploy survival: not directly assertable in CI (would kill the test daemon). Document in PR body as a manual QA step. |

No "Integration" layer per the Citadel test-layer override.

### New tests to add

- `packages/hooks/src/teardown.test.ts`:
  - `resolveTeardownHook returns repo-file when an executable .citadel/hooks/teardown exists`
  - `resolveTeardownHook returns none when the file is missing`
  - `resolveTeardownHook returns none with a diagnostic note when the file exists but is not executable`
  - `runTeardownHook captures exit status and streams stdout line-by-line`
  - `runTeardownHook surfaces stderrTail on non-zero exit`
  - `runTeardownHook honors timeoutMs and SIGKILLs the child on overrun`
  - `runTeardownHook does not hang when the hook spawns a daemon and exits` (assert promise resolves within a generous bound)
- `packages/operations/src/index.test.ts` (extend existing — preferred over new file per regression-test gate):
  - `removeWorkspace runs .citadel/hooks/teardown BEFORE tmux session kills` (assert tmux kill order vs file hook spawn order via fake clocks)
  - `removeWorkspace blocks ALL cleanup (tmux, worktree, DB) when file-based teardown fails and force=false`
  - `removeWorkspace continues with explicit warning log when file-based teardown fails and force=true`
  - `removeWorkspace with archiveOnly:true does NOT invoke .citadel/hooks/teardown OR configured teardown hooks` (CONCERN A pin)
  - `removeWorkspace skips file teardown when workspace.path no longer exists (cwd-invariant)`
  - `removeWorkspace activity emits workspace.teardown.file on success and workspace.teardown.file.failed on failure`
  - `removeWorkspace, configured teardown failure with force=true now emits a warning log line` (regression-pin the silent-swallow fix)
  - `removeWorkspace file teardown failure sets error prefixed with "file teardown failed:"` (CONCERN B pin)
  - `removeWorkspace configured teardown failure sets error prefixed with "configured teardown failed:"` (CONCERN B pin)
- `apps/web/src/hooks/use-redeploy.test.ts`:
  - `inFlight stays true for at least MIN_SPIN_MS even when the mutation resolves immediately`
  - `inFlight clears IMMEDIATELY on a 4xx/5xx error with parseable body (no MIN_SPIN_MS masking)`
  - `inFlight stays true through a network-error and clears only when /api/state returns a newer daemonStartedAt`
  - `inFlight does NOT clear when /api/state returns the same daemonStartedAt (old daemon last gasp)`
  - `inFlight clears after WATCHDOG_MAX_MS with a warning toast if /api/state never returns a newer token`
  - `lastOperationId is captured from the success response body and is null after a network error`
  - `trigger always fetches a fresh /api/state for the daemonStartedAt token, not the cached query value` (CONCERN C pin — mock the fetcher and assert one extra GET per trigger())
  - `trigger sets inFlight within ~1.5s even when /api/state pre-fetch hangs` (round 3 timeout pin — mock fetch to never resolve; assert inFlight=true within the AbortSignal.timeout window)
  - `useRedeploy unmounts cleanly during an active watchdog poll without setState-on-unmounted warnings` (CONCERN E pin)
- `apps/web/src/deployed-apps.test.tsx` (NEW — no existing file):
  - `Spin class appears on the targeted chip's icon while inFlight is true`
  - `Button is disabled and aria-busy while inFlight is true`
  - `Clicking redeploy twice rapidly only fires one mutation`
  - `"View log" link appears only when operationId is known and inFlight is true`
  - `Per-chip click only spins the targeted chip, not the panel-level button`
- `apps/web/src/routes/operations.test.tsx` (NEW):
  - `?id=<existing-op> renders that row highlighted and scrolled into view`
  - `?id=<missing-op> renders the list with a "not found" note at top`
  - `no id param renders the list unchanged`
  - `changing the id search param while mounted re-triggers scrollIntoView for the new row` (CONCERN D pin — render with id=A, then update search to id=B, assert scrollIntoView was called for both)
- `e2e/deploy-redeploy.spec.ts`:
  - End-to-end as described in §Layer evaluation.
- `e2e/workspace-teardown-hook.spec.ts`:
  - File-based teardown executes; sentinel proves ordering relative to worktree removal.

### Existing tests to update

- `packages/operations/src/index.test.ts`: existing `removeWorkspace` cases must continue to pass. Reordering tmux kill to AFTER hooks may cause one of the existing assertions about tmux-kill log line ordering to need adjustment — search for `Killed N tmux session` log assertions and update their position in the expected log sequence. Document each existing test that needed an ordering tweak in the PR body.
- `packages/hooks/src/index.test.ts` line 27–36: existing CONFIGURED teardown-failure case must continue to pass for the non-force path. Verify the force-path "now logs a warning" change is also covered (extend the existing case rather than adding a new file).

### Assertions to add/change/tighten

- `removeWorkspace` test: explicitly assert operation log ordering: `[teardown] running .citadel/hooks/teardown` → file-hook output → `Running N teardown hook(s):` → configured-hook output → `Killed N tmux session(s) attached to workspace` → `cleanup worktree at …`. (Order matters and is the rationale for the entire reordering.)
- `use-redeploy` test with `vi.useFakeTimers()`: explicit assertion that on a 400 response the spinner clears WITHIN one tick (no MIN_SPIN_MS wait).
- Deploy UI test: assert the icon's `className` literally contains either `animate-spin` or `icon-spin` (whichever Step 0 settled on) — tightens beyond "button exists".

### Failure modes / edge cases / regression risks

- **File present but `chmod -x`** — `resolveTeardownHook` must NOT silently treat it as "none". Returns `none` with diagnostic `note` (matches deploy at `packages/hooks/src/deploy.ts:43-44`).
- **Teardown hook writes faster than line-buffered handler** — use the `replace(/\s+$/, "")` + split-on-newline pattern from deploy.
- **Teardown hook spawns a daemon and exits 0** — `stdio: ["ignore", "pipe", "pipe"]` + `detached: false` to avoid hanging on grandchild fds.
- **Force-remove on a repo whose teardown hangs** — `timeoutMs` from `commandPolicy.hookTimeoutMs` (default 120000) must SIGKILL. Asserted in unit test.
- **Citadel deploy hook self-restarts daemon mid-request** — UI watchdog covers it. If a future change removes the self-restart (e.g., daemon learns to swap implementations in-place), the watchdog simply never triggers — strictly happier path, no regression.
- **`refetchInterval: 10_000` already running on deployed-apps query** — watchdog polls `/api/state`, NOT `/deployed-apps`. No interference.
- **Operation log link navigates while another deploy is in flight** — fine; the operations route handles concurrent rows.
- **Stale daemon answers `/api/state` mid-shutdown** — watchdog requires `daemonStartedAt > captured`. Old daemon answers with the SAME token → ignored; new daemon answers with a NEWER token → spinner clears.
- **No teardown hook configured at all** — current behavior preserved exactly: `source === "none"`, configured-hooks path runs as before; only the tmux-kill-ordering moves (now after hooks), which is a strict safety improvement.
- **Workspace path disappeared between gate and teardown spawn** — cwd-invariant guard logs a warning and skips file-teardown step; configured hooks may still run depending on the `runWorkspaceHooks` cwd policy (they have their own cwd resolution — out of scope for this change).
- **Tailwind `animate-spin` not in bundle** — Step 0 detects this BEFORE writing the assertion; CSS fallback ships in same commit.
- **`/operations?id=…` for a purged operation** — covered by the not-found note assertion.
- **Operator opens `/operations?id=…` from an external link weeks later** — works the same way; if the operation no longer exists, "not found" note. No security concern (operation ids are server-issued opaque tokens).

### Adversarial analysis

- **How could this fail in production?**
  - File teardown hangs → SIGKILL after `hookTimeoutMs`, operator sees timeout in operation log.
  - Spinner watchdog token mismatch on systems with extremely fast daemon restart (<1ms between old-die and new-up) → impossible given Node startup costs; the cksum-port-derive + DB-open in `app.ts` takes hundreds of ms.
  - Tailwind class missing → Step 0 detection + fallback CSS.
  - `daemonStartedAt` collision on extremely close restarts within the same wall-clock millisecond → ISO precision is ms; capture with `Date.now()` would be more precise. Use `new Date().toISOString()` per existing patterns; collision is acceptable (an extra MIN_SPIN_MS wait, no correctness break).
- **What user actions trigger unexpected behavior?**
  - Operator triggers Redeploy then immediately Archive/Remove. The redeploy operation continues; the remove operation enqueues; they touch independent operation rows. If remove succeeds and tears down before redeploy completes, the redeploy operation finishes against a deleted workspace (operations rows are by id, not by workspace).
  - Operator force-removes with a destructive teardown — the teardown still runs once (existing contract for configured hooks; same contract for file-based). The 3-state failure table makes this explicit in the docs; force=true means "I accept that side effects from hooks have run".
  - Operator navigates to `/operations?id=…` for a running operation, then the operation is purged → "not found" note.
- **What existing behavior could break?**
  - Existing `removeWorkspace` log-line-ordering tests may need adjustment (tmux kill moves to AFTER hooks). Step Tests calls this out explicitly. No functional regression — the ordering is strictly safer.
  - Existing configured teardown hook on force=true used to swallow errors silently; now logs a warning. Pure additive; no consumer depends on silence.
  - Existing repos with `repo.teardownHookIds` continue to work (file path additive).
- **Which tests credibly catch those failures?** The `removeWorkspace` ordering test, the `use-redeploy` daemonStartedAt token tests, the operations-route `?id=…` tests, and the E2E teardown sentinel test directly assert the load-bearing invariants.
- **What gaps remain?** Live SSE/progress streaming (B.7 work). Self-deploy survival in automated E2E (kills the daemon under test — documented manual step).

## Tests

Test files to create / modify, in TDD execution order (test first, then code):

1. `packages/hooks/src/teardown.test.ts` — NEW (red)
2. `packages/hooks/src/teardown.ts` — NEW (make 1 pass)
3. `packages/operations/src/index.test.ts` — MODIFY (add file-teardown + reorder cases; red)
4. `packages/operations/src/index.ts` — MODIFY (make 3 pass; includes ordering change)
5. `apps/daemon/src/app.ts` — MODIFY (add `daemonStartedAt`)
6. `apps/web/src/hooks/use-redeploy.test.ts` — NEW (red)
7. `apps/web/src/hooks/use-redeploy.ts` — NEW (make 6 pass)
8. `apps/web/src/routes/operations.test.tsx` — NEW (red)
9. `apps/web/src/main.tsx` + `apps/web/src/routes/operations.tsx` — MODIFY (validateSearch + selection; make 8 pass)
10. `apps/web/src/deployed-apps.test.tsx` — NEW (red)
11. `apps/web/src/deployed-apps.tsx` — MODIFY (make 10 pass; consume use-redeploy, spinner, link)
12. `e2e/deploy-redeploy.spec.ts` — NEW
13. `e2e/workspace-teardown-hook.spec.ts` — NEW
14. Specs + docs edits (Step 1, Step 9)

## Schema or contract generation

- `packages/contracts/src/index.ts` gains `TeardownHookResolutionSchema` + type. No code generation step; Citadel re-exports via project references during `pnpm build`.
- No OpenAPI / SQL generation.

## Verification

Before opening the PR, every command in this list must pass locally:

- `make check` — runs `check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage`, `check:deps`, `build`. Comprehensive gate.
- `make e2e` — Playwright. Two new spec files plus existing flows must pass.
- `make smoke` — daemon API. Required because `/api/state` gains `daemonStartedAt`.
- Manual: trigger Redeploy in the Citadel cockpit and confirm the spinner is visible for the full restart, then the apps grid refreshes once the daemon is back. Document the manual step in the PR body.
