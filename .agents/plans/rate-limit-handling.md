Activate the /implement-task skill first.

# Plan: Rate-limit handling

## Acceptance Criteria

- [ ] AC1: A new canonical agent-session status `rate_limited` exists in the contract enum, persists in the DB, round-trips through HTTP/MCP (including all MCP tool description strings that enumerate the status set), and is rendered by the cockpit (workspace-card status dot uses the `attention` tone for it).
- [ ] AC2: The Claude Code status adapter detects rate-limit panes from REAL captures committed under `packages/runtimes/src/fixtures/claude-code/rate-limited-*.txt`. If real captures cannot be obtained during this PR, detection is deferred to a follow-up PR and the infrastructure (status enum + reducer + scheduler + helpers) ships first behind an adapter that returns `null` for the rate-limit observation — see "Scope contingency" below.
- [ ] AC3: Same as AC2 for the Codex adapter and `packages/runtimes/src/fixtures/codex/rate-limited-*.txt`. Adapters that cannot extract a reset time emit the observation with `resetAt: null`; the session still transitions to `rate_limited`.
- [ ] AC4: `reduceStatus` handles a new `pane_rate_limited` signal. Non-terminal sessions transition to `rate_limited` with `statusReason = "rate_limited:<ISO reset>"` or `"rate_limited:unknown_reset"`. `rate_limited` is sticky: `active` signals do NOT transition out; only an explicit `pane_observation` of `running`/`idle`/`waiting_for_input` (with **≥2 consecutive ticks of non-`rate_limited` observation**, see below) OR a lifecycle signal (`exited_*`, `tmux_missing`) exits the state.
- [ ] AC5: Each `rate_limited` session's `statusReason` is a parseable contract; a `parseRateLimitReason(reason: string): { resetAt: string | null } | null` helper in `@citadel/core` round-trips both the timestamped and `unknown_reset` shapes and returns `null` for anything else.
- [ ] AC6: A daemon-internal rate-limit scheduler (`packages/operations/src/rate-limit-scheduler.ts`) runs at the END of every `runStatusMonitorTick` (same `setInterval`, deterministic monitor-then-scheduler ordering — no separate timer). It scans sessions for `status === "rate_limited"` AND `parseRateLimitReason(statusReason).resetAt !== null`. If any qualify and no pending resumption row exists, it persists a `rate_limit_resumptions` row with `scheduled_at = max(now + 60s, min(resetAt) + 60s)`. If ALL rate-limited sessions have `resetAt === null`, no row is scheduled (debug log emitted instead).
- [ ] AC7: When a resumption row is due, the scheduler executes: (a) lists current `rate_limited` sessions, (b) filters to those whose `parseRateLimitReason(statusReason).resetAt <= now` (i.e., reset has actually passed) AND whose `tmuxSessionName !== null` AND that are NOT a background scheduled-agent run, (c) for each, calls `resumeRateLimitedSession(sessionId)` which **re-confirms the rate-limit banner is still visible in the pane** before sending a single Enter via `pressEnter`, and records an `agent.message` activity event with `source: "system"` and message-prefix `"[rate-limit-resumer]"` (the `ActivityEvent.source` enum is NOT widened — see Implementation step 1). Sessions still rate-limited per the pane but with `resetAt > now` remain — the row transitions `pending → executed` and a fresh row is scheduled on the next monitor tick for the new earliest `resetAt`.
- [ ] AC8: On daemon restart, pending resumption rows whose `scheduled_at` is in the past are NOT executed on the very first post-boot tick; the scheduler's EXECUTE phase gates on a per-session `hasCompletedFirstTick === true` flag that flips at the END of each `runStatusMonitorTick` (after observation + reducer + persistence). The flag is in-memory (`MonitorSessionState`), so on a fresh boot it starts `false` for every session and only flips after the first full tick has produced and persisted a pane observation. Sessions whose first post-boot observation does NOT confirm `rate_limited` are reaped from the resume candidate set by the resumer's banner re-confirm (AC7) and by the reducer transitioning them out — handles "daemon restarted and the runtime already recovered" cleanly. The flag is also checked in the SCHEDULE phase to avoid pre-emptive new rows from a possibly-stale post-restart state.
- [ ] AC9: After resumption, the next status-monitor tick re-observes each session. Sessions still showing the rate-limit banner re-transition to `rate_limited` with a fresh `statusReason`; a new resumption row is scheduled. Only one pending resumption row exists at any time (DB-level: store method `insertRateLimitResumption` is a no-op if a `pending` row already exists, returning the existing row).
- [ ] AC10: Schema migration adds the `rate_limit_resumptions` table and bumps `schema_migrations.version` to `8`. Migration is idempotent and preserves `PRAGMA foreign_keys = ON;`. Existing rows with legacy statuses are unaffected.
- [ ] AC11: All hardcoded `["starting","running",...]`-style status lists across the repo are replaced by typed helpers in `@citadel/contracts` (`isInteractiveStatus`, `isAliveStatus`, `isAcceptingInputStatus`) so future enum additions are exhaustively safe. Per-site decisions for `rate_limited` are listed in Implementation step 6. `sendAgentMessage`'s `acceptingStates` does NOT include `rate_limited` (operator messages during rate-limit are rejected with `session_not_accepting_input` — the auto-resumer uses the lower-level `pressEnter` path that bypasses this gate).
- [ ] AC12: Unit tests cover: fixture-driven parser tests for both runtimes (or skip-with-justification if the scope contingency applies), reducer transitions for `pane_rate_limited` including ≥2-tick hysteresis on exit, scheduler lifecycle (pending/executed, daemon-restart post-boot gate, per-session reset-due filter, background-session exclusion), `parseRateLimitReason` round-trip, `parseResetTime` REQUIRING explicit timezone marker (no marker → null), the new typed helpers in contracts, DB serialization of the new status, and the new MCP tool description includes `rate_limited`. Coverage thresholds on guarded packages (90% line) are preserved.

## Scope contingency

If real rate-limit captures cannot be obtained from a live Claude Code or Codex session during this PR, ship the infrastructure ONLY:
- Status enum widening, reducer signal, scheduler, resumer helper, typed-helper extraction, MCP description update, DB migration.
- Adapter detection emits `null` (no `pane_rate_limited` observed).
- Detection regexes and fixtures land in a follow-up PR.

This contingency is acceptable because: (a) fixture-driven adapters demand real captures (per `specs/B.3` Runtime Adapters item 2 — UI rendering changes trigger fixture+regex update as one PR); (b) inventing regexes against speculation would land tests that pass against the inventions, not against reality; (c) the rest of the surface (UI tone, scheduler, helpers) is testable without runtime captures.

Decide which path to take at the START of implementation, in implementation step 3, by attempting to capture real panes (run `claude` against a rate-limited account, or simulate by truncating quotas). The decision is recorded in the PR body.

## Context and problem statement

Citadel surfaces seven canonical agent-session statuses today (`starting`, `running`, `waiting_for_input`, `idle`, `stopped`, `failed`, `unknown`). When a Claude Code or Codex session hits a usage-limit wall, the runtime stops processing turns and displays a "limit reached / resets at X" banner in the pane. Citadel currently models this as `idle` (no activity) or `waiting_for_input` (if the runtime parks at a prompt), neither of which is true: the agent CANNOT proceed regardless of operator input until the reset time.

This causes two operator problems:
1. The cockpit shows a green/yellow dot for these sessions, hiding the fact that the agent is blocked.
2. The operator has to manually wake each agent after the reset (typically by hitting Enter in the pane), and only knows the agent is blocked by visually scanning panes.

The goal of this plan is to (a) detect the rate-limited state and parse the reset time in the per-runtime status adapters; (b) add a `rate_limited` canonical status and surface it in the UI as attention; and (c) schedule a single daemon-internal one-shot task that, 1 minute after the earliest reset, sends a wake signal to every still-rate-limited session — with strict safety guards on the actual keystroke.

Touch points (verified by grep):

- `packages/contracts/src/index.ts` — `AgentSessionStatusSchema` enum (L13-21); `ActivityEventSchema.source` (L453) deliberately NOT extended; new `RateLimitResumptionSchema`; new typed helpers (`isInteractiveStatus`, `isAliveStatus`, `isAcceptingInputStatus`).
- `packages/runtimes/src/status/index.ts` — `PaneObservation` (L18) → discriminated union carrying optional `resetAt`.
- `packages/runtimes/src/status/claude-code.ts`, `codex.ts` — add rate-limit priority above other observations, sourced from real fixtures.
- `packages/runtimes/src/usage/reset-time.ts` (NEW) — shared `parseResetTime(text, now)` requiring an explicit timezone marker.
- `packages/operations/src/agent-status.ts` — `StatusSignal` adds `pane_rate_limited`; reducer adds case; ≥2-tick exit hysteresis tracked via a new field on the monitor state (NOT the reducer prev).
- `packages/operations/src/status-monitor.ts` — observation forwarding; per-session hysteresis counter `consecutiveNonRateLimitedTicks`; calls `runRateLimitSchedulerTick` at the END.
- `packages/operations/src/rate-limit-scheduler.ts`, `rate-limit-resumer.ts` — NEW (with tests).
- `packages/core/src/index.ts` — `parseRateLimitReason`; `sessionNeedsAttention` returns true for `rate_limited`; existing `derive*` callers using hardcoded status lists are migrated to typed helpers.
- `packages/db/src/migrate.ts` — `rate_limit_resumptions` table, schema_migrations row 8.
- `packages/db/src/index.ts` — store methods for resumption rows.
- `packages/terminal/src/submit-prompt.ts` — co-locate new `pressEnter(sessionName)` next to `submitPrompt`; re-export from `packages/terminal/src/index.ts`.
- Every hardcoded `["starting","running",...]`-style status list (full audit listed in Implementation step 6).
- `packages/mcp/src/index.ts` — tool description strings enumerating status values (full grep in step 7).

## Spec alignment

Per `.agents/skills/extensions/review-pr.md` glob mapping:

- `packages/contracts/**`, `packages/core/**`, `packages/db/**` → `specs/A-shared-definitions.md` (no changes — no new domain noun) + `specs/B.3-agent-sessions-terminal.md` (status enum widened).
- `packages/operations/**`, `apps/daemon/src/**` → `specs/B.7-operations-activity-mcp.md` (rate-limit-resumer activity entry source/message-prefix and one-shot scheduler).
- `apps/web/**` → `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md` (no behavioral change beyond the additional pulse tone).
- `packages/runtimes/src/status/**` → `specs/B.3-agent-sessions-terminal.md`.

Spec gap: `specs/B.3-agent-sessions-terminal.md` item 8 enumerates the seven-value enum verbatim — promoted to eight. The FIRST implementation step is the spec update:

- Add `rate_limited` to the canonical enum list with semantics: "agent process is alive but the runtime has reported that all model-side capacity is exhausted until a documented reset time. Sticky like `idle`/`waiting_for_input` — only an explicit pane observation of `running`/`idle`/`waiting_for_input` (≥2 consecutive ticks) or a lifecycle signal transitions out."
- Add a sentence in `specs/B.7-operations-activity-mcp.md` under Operations: "Rate-limited sessions are automatically resumed by a daemon-internal one-shot scheduler that fires one minute after the earliest reset time; the resumption is recorded as an `agent.message` activity event with source `system` and a `[rate-limit-resumer]` message prefix. The keystroke is suppressed if the pane no longer shows the rate-limit banner at execution time."

## Implementation approach

Three concerns, layered, with safety baked into each:

1. **Status surface + typed helpers.** Add `rate_limited` to the canonical enum; refactor `PaneObservation` to a discriminated union; replace every hardcoded status list across the repo with three typed helpers — `isInteractiveStatus`, `isAliveStatus`, `isAcceptingInputStatus`. This makes the enum addition exhaustively safe and the next enum addition trivial.

2. **Per-runtime detection from real captures.** Fixture-driven detectors in the Claude Code and Codex adapters. Real pane captures committed under `packages/runtimes/src/fixtures/{claude-code,codex}/rate-limited-*.txt`. Reset-time parsing factored into a shared `parseResetTime(text, now): string | null` that REQUIRES an explicit timezone marker and returns null on ambiguity. If captures are unobtainable during the PR window, ship infrastructure and defer detection (see Scope contingency).

3. **Scheduler + safe resumer.** A new `rate-limit-scheduler.ts` module follows the same DI shape as `status-monitor.ts`. It is INVOKED FROM `runStatusMonitorTick` at the end, after the monitor's status writes have landed — same `setInterval`, deterministic ordering. State persists in a new SQLite table so daemon restarts don't drop pending resumptions. The actual Enter keystroke is gated by:
   - The session's status is still `rate_limited` at execute time.
   - `parseRateLimitReason(statusReason).resetAt <= now` — only resume sessions whose reset is actually in the past.
   - The session has a `tmuxSessionName` AND is not a background scheduled-agent run.
   - **At the moment of execute, capture the pane fresh and re-confirm the rate-limit banner is still visible** — if the adapter's banner regex no longer matches, skip the Enter (operator may have already taken action, or runtime is in a different state).
   - On daemon restart, `monitorState.hasCompletedFirstTick === true` is required (per-session) in BOTH the scheduler's schedule and execute phases — guarantees one full post-boot status-monitor tick has run before any resumption fires.

The scheduler remains daemon-internal (not a `ScheduledAgent` row) for the reasons in Alt A below.

## Alternatives considered

**Alt A — Reuse `ScheduledAgent` rows with `scheduleType: "once"` and `runMode: "background"`.** Rejected: a ScheduledAgent ties to a `repoId`, `runtimeId`, `prompt`, and a `BackgroundSessionCreator` that spawns a NEW tmux/runtime session. The resumption operation has none of those (it only presses Enter in an EXISTING session). The wiring would create cleanup obligations and would surface as a confusing user-visible row in the Scheduled Agents UI.

**Alt B — In-memory `setTimeout` per rate-limited session.** Rejected: daemon restarts drop the timer, leaving sessions stuck forever. SQLite persistence is cheap and survives crash.

**Alt C — Per-session resumption row.** Rejected: the spec says "schedule a one-time background agent that auto-resumes ALL rate-limited agents" — one row that fans out is simpler and matches the operator's expectation of "one resume event per reset cycle." Per-session reset-due filtering happens at execute time (AC7), so sessions whose reset hasn't passed are still skipped.

**Alt D — Drive `/usage` or `/status` slash-commands to detect rate-limit.** Rejected: those commands require driving an ephemeral tmux process; using them on every 2s monitor tick would saturate the runtime. The pane-content path is the cheap signal.

**Alt E — Notify-and-let-operator-resume instead of auto-Enter.** Considered. The "operator was mid-keystroke" race (review concern #3) is real. Rejected as the default ONLY because the pane re-confirm guard mitigates the worst case (if the banner moved off-screen or input is non-empty, the regex won't match the rate-limit shape and Enter is suppressed). Auto-resume remains the spec-stated goal; a "notify only" mode is a follow-up if the safety guard proves insufficient.

## Implementation steps

### 0. Spec update (FIRST)

- Edit `specs/B.3-agent-sessions-terminal.md` item 8: extend the canonical status enum from seven to eight values; document `rate_limited` semantics and ≥2-tick hysteresis on exit.
- Edit `specs/B.7-operations-activity-mcp.md` Operations section: document the rate-limit-resumer activity event (source `system`, message-prefix `[rate-limit-resumer]`) and the one-shot scheduler with re-confirm-before-Enter safety guard.

### 1. Contracts, typed helpers, migration

- `packages/contracts/src/index.ts`:
  - Extend `AgentSessionStatusSchema` with `"rate_limited"`.
  - `ActivityEventSchema.source` is NOT widened — keep the existing closed enum. The resumer uses `source: "system"` with the `[rate-limit-resumer]` message prefix as the discriminator. This avoids breaking downstream consumers (UI filter dropdowns, MCP clients) that snapshot the enum.
  - Add `RateLimitResumptionStatusSchema = z.enum(["pending", "executed"])`, `RateLimitResumptionSchema { id, scheduledAt, createdAt, executedAt: nullable, status }`.
  - Add typed helpers (exported, pure):
    - `isInteractiveStatus(s)` → `s in {starting, running, waiting_for_input}` — actively driving toward completion.
    - `isAliveStatus(s)` → `s in {starting, running, waiting_for_input, idle, rate_limited, unknown}` — process exists (everything but `stopped`/`failed`).
    - `isAcceptingInputStatus(s)` → `s in {starting, running, waiting_for_input, idle}` — operator messages should be accepted. `rate_limited` is intentionally excluded because the agent cannot process input until reset.
  - Export inferred TS types.
- `packages/db/src/migrate.ts`:
  - `CREATE TABLE IF NOT EXISTS rate_limit_resumptions (id TEXT PRIMARY KEY, scheduled_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, executed_at TEXT)`.
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_rl_resumptions_pending_singleton ON rate_limit_resumptions(status) WHERE status = 'pending'` — DB-level invariant that AT MOST ONE pending row exists.
  - `CREATE INDEX IF NOT EXISTS idx_rl_resumptions_status_scheduled ON rate_limit_resumptions(status, scheduled_at)`.
  - `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (8, 'rate-limit-resumptions', datetime('now'))`.
- `packages/db/src/index.ts`:
  - `insertRateLimitResumption(row)` — relies on the partial unique index for idempotency; catches `SQLITE_CONSTRAINT_UNIQUE` and returns the existing pending row instead.
  - `findPendingRateLimitResumption()` — returns the single pending row or null.
  - `listDueRateLimitResumptions(now)` — `WHERE status='pending' AND scheduled_at <= ?`.
  - `markRateLimitResumptionExecuted(id, executedAt)`.

#### Migration strategy

- **Operation list.** `CREATE TABLE rate_limit_resumptions` (additive), `CREATE UNIQUE INDEX idx_rl_resumptions_pending_singleton ... WHERE status='pending'` (additive partial index), `CREATE INDEX idx_rl_resumptions_status_scheduled` (additive), `INSERT OR IGNORE INTO schema_migrations(8, …)`.
- **Classification.** All four are additive. Safe; ships in one step.
- **`schema_migrations` row.** New version `8`, name `rate-limit-resumptions`, strictly greater than the current max (verified `7`).
- **`PRAGMA foreign_keys = ON;` preservation.** No `PRAGMA` lines touched.
- **Operator data implications.** Existing installs on startup gain an empty `rate_limit_resumptions` table and unchanged `agent_sessions` rows. No legacy rows use `rate_limited`, so the enum widening is non-breaking (values stored as `TEXT`).

### 2. Core helpers + reset-time parser

- `packages/core/src/index.ts`:
  - `parseRateLimitReason(reason: string): { resetAt: string | null } | null` — accepts `"rate_limited:<ISO>"` and `"rate_limited:unknown_reset"`; returns null otherwise.
  - Extend `sessionNeedsAttention` to return true for `status === "rate_limited"`.
  - Audit the file for hardcoded status lists and migrate to the new typed helpers (`packages/core/src/index.ts:73` — `session.status === "running"`).
- `packages/runtimes/src/usage/reset-time.ts` (NEW): `parseResetTime(text: string, now: Date): string | null`. Behavior:
  - Recognizes explicit timezone markers: `(UTC)`, `(GMT)`, `(local)` followed by parseable time-of-day or date+time.
  - With `(UTC)` or `(GMT)`: time-of-day-only → next UTC occurrence after `now`; date+time → absolute moment.
  - With `(local)`: time interpreted in the Node process's local timezone (this is the runtime-process timezone — matches the runtime's display).
  - **Without any timezone marker**: return `null`. The string is ambiguous; do not guess.
  - All other unrecognized shapes return `null`.

### 3. Per-runtime status adapters

- **Step 3a — Capture real fixtures.** Attempt to obtain real rate-limited captures from Claude Code and Codex (run against a rate-limited account, or simulate by truncating quotas). If successful, commit them as `packages/runtimes/src/fixtures/{claude-code,codex}/rate-limited-*.txt`. If unsuccessful, declare the Scope contingency and skip 3b/3c — proceed to step 4.
- **Step 3b — Refactor `PaneObservation` AND add stateless `detectRateLimit`.** `packages/runtimes/src/status/index.ts` (L18) changes from a string union to a discriminated union: `{ kind: "running" } | { kind: "idle" } | { kind: "waiting_for_input" } | { kind: "rate_limited"; resetAt: string | null }`. Both existing adapters return the new shape; the monitor wiring (step 4) maps `{kind}` to the right signal. **In addition, extend `RuntimeStatusAdapter` with `detectRateLimit(paneCapture: string): { resetAt: string | null } | null`** — a stateless secondary method, NO `SessionAdapterState` or `ObservationContext`. The adapter's `observe()` implementation calls `detectRateLimit()` internally as its priority-1 check so the regex/parsing logic lives in one place. The resumer (step 5) uses ONLY `detectRateLimit` — it does not invoke `observe()`. This avoids coupling the resumer to monitor internals and prevents adapter behavior from depending on the order in which it's called.
- **Step 3c — Add detection.**
  - `packages/runtimes/src/status/claude-code.ts`: priority 1 (above AskUserQuestion footer). Regex calibrated to the real fixture text. Parse the reset substring through `parseResetTime`. Scan window: last 24 lines (twice the existing CHROME_SCAN_LINES) — banners may sit higher than the mode-line.
  - `packages/runtimes/src/status/codex.ts`: detection from the `/status` panel residue (`5h limit` or `Weekly limit` row showing `0% left`) OR a banner string captured from a real session. Extract via the shared `LIMIT_RE`/`parseResetTime` helpers.
- **Step 3d — Tests.** Per-fixture tests assert `{ kind: "rate_limited", resetAt: <ISO|null> }`. Also add a test that combines a stale AskUserQuestion footer with a rate-limit banner in the SAME fixture and asserts the rate-limit shape wins.

### 4. Reducer + monitor wiring (hysteresis on exit)

- `packages/operations/src/agent-status.ts`:
  - Extend `StatusSignal` with `{ type: "pane_rate_limited"; resetAt: string | null }`.
  - Reducer rules:
    - When `prev.status === "rate_limited"` AND the new `resetAt` is "equal" to the parsed value of `prev.statusReason`, return `null` (no-op — avoids high-frequency SSE writes). **Equality is `Date.parse(a) === Date.parse(b)` (numeric millisecond compare), NOT string-equality** — avoids spurious refinement writes when the parser emits a different but equivalent ISO format (e.g., `"…00:00Z"` vs `"…00:00.000Z"`). Both null → equal. One null, one not → not equal.
    - When `prev.status === "rate_limited"` AND `resetAt` differs (per the same `Date.parse` compare), treat as reason refinement: `{ status: "rate_limited", reason: "rate_limited:<new>" }` without `lastStatusAt`.
    - Otherwise, `statusUpdate(prev, "rate_limited", "rate_limited:<ISO|unknown_reset>", now)`.
  - For the existing `pane_observation` case: when `prev.status === "rate_limited"` AND `signal.observed` is `running`/`idle`/`waiting_for_input`, the reducer alone is NOT enough — the monitor enforces the ≥2-tick hysteresis (see below) by deciding whether to forward the signal. The reducer's job stays simple (transition on receipt). Document this in a comment.
- `packages/operations/src/status-monitor.ts`:
  - Extend `MonitorSessionState` with `consecutiveNonRateLimitedTicks: number` AND `hasCompletedFirstTick: boolean` (the post-boot gate flag — flipped to `true` at the END of `runStatusMonitorTick`, after all observation/reducer/persistence work AND after the scheduler tick. Initial value is `false` for every newly-created `MonitorSessionState`).
  - When the session's prev status is `rate_limited` and the adapter emits a non-rate_limited observation:
    - Increment `consecutiveNonRateLimitedTicks`.
    - Only forward the `pane_observation` signal to the reducer when the counter reaches ≥2.
    - Reset the counter to 0 on any `pane_rate_limited` observation.
  - When the session's prev status is `rate_limited` AND the adapter emits a `pane_rate_limited` observation, reset the counter to 0 and forward the `pane_rate_limited` signal (the reducer handles same-reset no-op).
  - Adapter-observation branch updated to dispatch the discriminated union to the right signal type.
  - At the END of the tick (after the per-session loop completes AND the scheduler tick returns), iterate the candidate session list once more to set `hasCompletedFirstTick = true` on each. This guarantees the flag is only true AFTER a full tick has run.

### 5. Rate-limit scheduler + resumer

- `packages/operations/src/rate-limit-scheduler.ts` (NEW):
  - Exports `runRateLimitSchedulerTick(deps, opts)`.
  - Deps: `now()`, `listSessions()`, `findPendingResumption()`, `insertResumption(row)`, `listDueResumptions(now)`, `markExecuted(id, now)`, `resumeSession(sessionId): Promise<{ resumed: boolean; reason: string }>`, `emit(event, payload)`, `monitorStates: Map<string, MonitorSessionState>` (read-only — for the post-boot gate).
  - Algorithm per tick (invoked from `runStatusMonitorTick` AFTER all status writes for this tick, but BEFORE the flip of `hasCompletedFirstTick`):
    1. **Schedule phase.** List all sessions with `status === "rate_limited"` AND parseable `resetAt` AND `tmuxSessionName !== null` AND `monitorStates.get(s.id)?.hasCompletedFirstTick === true`. If any qualify and `findPendingResumption() === null`, compute `scheduledAt = max(now + 60s, min(resetAt) + 60s)`, insert one row.
    2. **Execute phase.** For each due row: re-list rate_limited sessions, filter to those with `parseRateLimitReason(statusReason).resetAt <= now`, AND `tmuxSessionName !== null`, AND not in `background_sessions` (lookup by tmux session name), AND `monitorStates.get(s.id)?.hasCompletedFirstTick === true` (the post-boot gate is enforced HERE too — a stale pending row from a previous daemon run does not execute until the current daemon has completed at least one full tick per candidate). For each remaining session, await `resumeSession(sessionId)`. Mark row `executed`. Emit `rate-limit.resumed { sessionIds, skipped }`.
  - The scheduler is invoked AT THE END of `runStatusMonitorTick`, NOT as a separate `setInterval`. Done in the same async function call so monitor writes land first. The `hasCompletedFirstTick` flip happens AFTER the scheduler returns, so on the first post-boot tick the gate is `false` for every session and the scheduler is a no-op — exactly the protection AC8 promises.
- `packages/operations/src/rate-limit-resumer.ts` (NEW):
  - Exports `resumeRateLimitedSession(deps, { sessionId }): Promise<{ resumed: boolean; reason: string }>`.
  - Deps: store, terminal helpers (`pressEnter`, `paneCapture`, `lastNonEmptyLine`), `now()`, **stateless `detectRateLimit(runtimeId, paneCapture): { resetAt: string | null } | null` selector**. The plan adds a new **stateless secondary method `detectRateLimit(paneCapture: string)` to `RuntimeStatusAdapter`** — independent of `observe()` so it does not require fabricating `SessionAdapterState`/`ObservationContext`. The adapter's `observe()` implementation calls `detectRateLimit()` internally as its priority-1 check, so the logic lives in one place. This is the cleaner separation; the alternative of borrowing live monitor state is rejected because it couples the resumer to monitor internals and risks adapter behavior diverging from the monitor tick (e.g., codex's `hasObservedSinceBoot` idle-suppression).
  - Algorithm:
    1. Load session; require `status === "rate_limited"`; require `tmuxSessionName`.
    2. Re-capture the pane: `paneCapture(tmuxSessionName)`.
    3. Re-invoke `detectRateLimit(runtimeId, paneCapture)`. If it returns `null` (banner no longer matches), return `{ resumed: false, reason: "banner_gone" }` — DO NOT send Enter, DO NOT record an activity event.
    4. **TOCTOU guard.** Call `lastNonEmptyLine(paneCapture)` and verify the bottom line is consistent with the rate-limit banner shape (e.g., matches a banner regex from the adapter, or starts with the configured banner-shape prefix), NOT a non-empty user-input area (a line starting with the runtime's input prompt character `❯` followed by user characters). If the bottom-line check fails, return `{ resumed: false, reason: "input_in_progress" }`. The capture-and-check is single-syscall (tmux capture-pane is synchronous); there is still a sub-100ms window between the syscall returning and the subsequent `tmux send-keys Enter` — acknowledged in adversarial analysis.
    5. Call `pressEnter(tmuxSessionName)`.
    6. Record `ActivityEvent { type: "agent.message", source: "system", message: "[rate-limit-resumer] Sent wake signal to <displayName>" }`.
    7. Return `{ resumed: true, reason: "enter_sent" }`.
  - NOTE: Does NOT optimistically transition status — the next monitor tick reconciles.
- `packages/terminal/src/submit-prompt.ts`:
  - Add `pressEnter(sessionName: string): { ok: boolean; error?: string }` next to `submitPrompt`. Implementation: single `tmux send-keys -t <name> Enter` via `execFileSync`. No paste-buffer, no verification.
- `packages/terminal/src/index.ts`:
  - Re-export `pressEnter`.
- `apps/daemon/src/app.ts`:
  - Wire the new scheduler deps into `startStatusMonitor`'s deps (the monitor invokes the scheduler tick at the end). Resolve `resumeSession` to `resumeRateLimitedSession` bound to the daemon's terminal helpers.

### 6. Typed-helper migration across the repo

Audit and migrate. Each site gets a typed helper. Decisions per site:

| Site | Current literal list | New helper | Rationale |
|------|---------------------|------------|-----------|
| `packages/operations/src/agent-messages.ts:39` `acceptingStates` | `["starting","running","waiting_for_input","idle"]` | `isAcceptingInputStatus` (excludes `rate_limited`) | Operator messages during rate-limit are pointless — agent can't process. |
| `packages/operations/src/index.ts:528` | `["starting","running","waiting_for_input","idle"]` | `isAcceptingInputStatus` | Same gate as above. |
| `packages/operations/src/launch-agent.ts:60` | `s.status === "running"` | Keep as-is (specific to "is there a running session to attach to?") | No behavior change needed; `rate_limited` IS alive but `running` is the actual check here. |
| `apps/web/src/settings-repositories.tsx:117` | `["starting","running","waiting_for_input"]` | `isInteractiveStatus` (excludes `rate_limited`) | This counts "actively engaged" agents — rate-limited agents are blocked. |
| `apps/web/src/workspace-card.tsx:33` | `s.status === "starting" \|\| s.status === "running"` | `isInteractiveStatus(s.status)` | Same as above. |
| `apps/web/src/cockpit.tsx:354` | `s.status === "running"` | **Keep literal `=== "running"`** | Verified by reading L351-356: this drives the collapsed-mini-stack indicator showing whether a workspace has an actively-working agent. `rate_limited` is NOT actively working; the workspace-status-dot already surfaces the attention state via `deriveWorkspaceAgentTone`. Excluding `rate_limited` here is correct. |
| `apps/web/src/cockpit.tsx:462` | `["running","starting","waiting_for_input"]` | `isInteractiveStatus` | Same. |
| `apps/web/src/navigator.tsx:31` | `s.status === "running"` | **Keep literal `=== "running"`** | Verified by reading L25-32: this drives the per-group "running count" badge. Operator wants the number of actively working agents — `rate_limited` is intentionally NOT counted (it has its own attention-tone treatment). |
| `apps/web/src/stage.tsx:153` | `s.status === "running"` → tab pulse | Replace with `agentTonePulseClass(session)` helper returning `cit-pulse-run` (running) / `cit-pulse-bad` (rate_limited, attention) / `cit-pulse-idle` (else) | Pulse needs rate-limit awareness. |
| `apps/web/src/cockpit-readiness.ts:26` | `["starting","running"]` | `isInteractiveStatus` | Readiness predicates — rate-limited is NOT actively running, but IS needing attention; the readiness file's existing `sessionNeedsAttention` consumer picks up `rate_limited` automatically via the core helper. Verify by reading the full file. |
| `apps/daemon/src/readiness.ts:40` | `["starting","running"]` | `isInteractiveStatus` | Same as cockpit-readiness. |
| `packages/core/src/index.ts:73` | `s.status === "running"` | `isInteractiveStatus` | Used in readiness derivation. |

Migration steps:
- Land the typed helpers in `@citadel/contracts` first (with tests).
- Replace each site one-at-a-time; each replacement is a single-file diff with a test update if the file is test-covered.
- A grep CHECK at the end (`grep -rn '\\["starting"' --include="*.ts" --include="*.tsx" apps packages`) confirms no `starting`-prefixed literal lists remain (tests excluded).

### 7. MCP surface

- `packages/mcp/src/index.ts`: grep tool descriptions for the literal seven-value enum or the string "starting, running, waiting_for_input" — any enumeration of agent statuses must be updated to include `rate_limited`. Search pattern: `grep -n "starting.*running.*waiting_for_input\|status.*enum" packages/mcp/src/index.ts`.
- `inspect_status` and `list_agent_sessions` return `session.status` verbatim — those need no code change, but the JSON-schema description strings advertising the enum MUST list `rate_limited`.

### 8. UI surfacing

- `apps/web/src/workspace-card.tsx`: verify `deriveWorkspaceAgentTone` returns `attention` for `rate_limited` (cascades via `sessionNeedsAttention`). Add a test case.
- `apps/web/src/stage.tsx`: introduce `agentTonePulseClass(session)` helper.
- `apps/web/src/cockpit.tsx` and `apps/web/src/navigator.tsx`: confirm running counts exclude `rate_limited` (literal `=== "running"` already does this; verified safe).
- Optional reset-time tooltip on the workspace dot: DEFERRED to a follow-up.

### 9. Schema or contract generation

Not applicable. Citadel does not codegen contracts.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Reducer, monitor hysteresis, scheduler lifecycle, resumer banner-re-confirm guard, parseResetTime timezone discipline, parseRateLimitReason round-trip, DB migration + resumption CRUD, typed helpers, MCP description includes `rate_limited`, workspace-card tone for `rate_limited`, every per-site typed-helper migration where the file has a test. Fixture-driven adapter tests if Scope contingency NOT triggered. |
| E2E (Playwright) | **Not required** | The full flow is hard to drive against a real rate-limited runtime. Equivalent coverage comes from (1) fixture-fed monitor → tone change; (2) daemon HTTP smoke that POSTs a session into `rate_limited` via direct store write and asserts workspace-summary tone; (3) scheduler DI tests for the resume path. |

### New tests to add

- `packages/contracts/src/index.test.ts`: extend AgentSession round-trip to include `rate_limited`. New tests for `isInteractiveStatus`, `isAliveStatus`, `isAcceptingInputStatus` — assert each status enum value lands in the right set.
- `packages/core/src/index.test.ts`: `parseRateLimitReason` round-trip + reject. `sessionNeedsAttention` for `rate_limited` → true.
- `packages/runtimes/src/usage/reset-time.test.ts`: cases for each timezone marker; **NO MARKER → null**; ambiguous "10:00" (no marker) → null; "10:00 (UTC)" → next UTC occurrence; "May 27, 12pm (UTC)" → absolute; "21:32 on 30 May (local)" → local-tz absolute.
- `packages/runtimes/src/status/claude-code.test.ts` and `codex.test.ts`: cases for each rate-limit fixture (if available); fixture mixing AskUserQuestion footer with rate-limit banner → rate-limit wins.
- `packages/operations/src/agent-status.test.ts`: extend with `pane_rate_limited` transitions from every non-terminal prior status; reason-refinement (same status, different reset) case; **ISO-equality robustness case** — two equivalent ISO strings (e.g., `"2026-05-26T10:00:00.000Z"` vs `"2026-05-26T10:00:00Z"`) compare as equal and produce a no-op result.
- `packages/operations/src/status-monitor.test.ts`: extend with (a) `pane_rate_limited` observation forwarded as the right signal; (b) ≥2-tick hysteresis: one tick of non-rate_limited observation does NOT exit `rate_limited`; two consecutive ticks DOES exit.
- `packages/operations/src/rate-limit-scheduler.test.ts` (NEW): (a) no rate_limited sessions → no-op; (b) one rate_limited session with known reset → insert one row at `max(now+60s, reset+60s)`; (c) second rate_limited session appearing while a row is pending → no second row inserted (DB-level unique index); (d) due row, all sessions still rate_limited with `resetAt <= now` → executes, calls `resumeSession` for each, marks executed; (e) due row, one session has `resetAt > now` → that session is skipped; (f) all-unknown-reset → no row inserted; (g) **`scheduled_at` in the past on the FIRST post-boot tick** — every session's `hasCompletedFirstTick` is `false`; the scheduler is a no-op in BOTH schedule and execute phases. (h) After one full tick (so `hasCompletedFirstTick = true`), the same scenario on the next tick executes the pending row. (i) background-session-backed `tmuxSessionName` → skipped from resume.
- `packages/operations/src/rate-limit-resumer.test.ts` (NEW): (a) happy path → `pressEnter` called once, activity event recorded with source `"system"` and `[rate-limit-resumer]` prefix; (b) banner-gone re-confirm → `pressEnter` NOT called, returns `{ resumed: false, reason: "banner_gone" }`; (c) **`input_in_progress` guard** — pane re-capture shows the banner regex still matching but the bottom line is `❯ some user text`; `pressEnter` NOT called; returns `{ resumed: false, reason: "input_in_progress" }`; (d) session not found → error; (e) status not `rate_limited` → error.
- `packages/db/src/migration.test.ts`: new table exists post-migration; re-run is no-op; partial unique index on `pending` rejects a second pending insert. Assert `schema_migrations` max becomes 8.
- `packages/db/src/index.test.ts`: round-trip `rate_limited` session through `insert → list → update`. `insertRateLimitResumption` idempotency (second call with existing pending row returns existing).
- `apps/web/src/workspace-card.test.ts`: extend with `rate_limited` session → `attention` tone.
- `apps/web/src/stage.test.tsx` (NEW or extend existing): `agentTonePulseClass` mapping per status.
- `apps/web/src/cockpit-readiness.test.ts`: any new `rate_limited` case for the readiness predicate (verify after reading the test file).

### Existing tests to update

- `packages/operations/src/status-monitor.test.ts`: `TERMINAL_STATUSES` unchanged; add "processes rate_limited sessions (re-observation, exits with ≥2-tick hysteresis on positive observation)".
- `packages/contracts/src/index.test.ts`: AgentSession round-trip with `rate_limited`.
- Each migrated literal-list site that has a test gets its existing test re-run to confirm no behavioral change for the legacy values.

### Assertions to add/change/tighten

- Claude Code adapter: rate-limit priority strictly ABOVE AskUserQuestion footer in a combined fixture.
- Reducer: `active` signal received while `prev.status === "rate_limited"` returns `null` (no transition).
- Monitor: `consecutiveNonRateLimitedTicks` resets to 0 on every `pane_rate_limited` observation; only triggers exit at ≥2.
- Scheduler: only ONE pending row at a time, enforced by DB partial unique index; `insertRateLimitResumption` is idempotent against a same-shape second call.
- Resumer: re-confirm banner-still-visible BEFORE Enter; suppression test asserts `pressEnter` is never called when the pane no longer shows the rate-limit banner.
- Activity event from the resumer: `source === "system"`, `message.startsWith("[rate-limit-resumer]")`.
- `pressEnter` called with the right `tmuxSessionName`, exactly once per session per resumption.
- `parseResetTime` returns `null` on every string without an explicit timezone marker.
- `acceptingStates` (renamed via `isAcceptingInputStatus`): `rate_limited` rejects with `session_not_accepting_input`.

### TOCTOU window

There is a sub-100ms window between the resumer's `paneCapture()` returning and the subsequent `tmux send-keys Enter` syscall in which the operator could begin typing into the pane. The plan's mitigation is two-layered: (a) the rate-limit banner re-confirm via `detectRateLimit` AND (b) the `lastNonEmptyLine` user-input shape check. Both are evaluated in step 5. A 100% race-free guarantee would require pausing the tmux pane (`tmux send-keys -t … MouseDown1`?) which is invasive and not pursued. Acknowledged in adversarial analysis.

### Failure modes / edge cases / regression risks

- **Banner regex drift.** Mitigation: fixture tests against real captures; the existing chrome-regex+fixture protocol applies.
- **Sticky-state escape false-positive.** Now mitigated by ≥2-tick hysteresis: a single false-negative observation does not exit `rate_limited`.
- **Operator typing mid-keystroke at execute time.** Mitigated by two checks in the resumer: (1) `detectRateLimit` re-confirm against the fresh pane capture; (2) `lastNonEmptyLine` bottom-line shape check. A sub-100ms TOCTOU window remains between capture and Enter syscalls; not closed. If the operator has scrolled the banner off-screen or has typed into the input, at least one of the two checks will fail and Enter is suppressed.
- **Resumer fires Enter into an unrelated mode.** Same mitigation — the banner is the signal.
- **Concurrent reset windows.** First session at 4pm, second at 5pm: row scheduled for 4:01pm; at 4:01pm only the 4pm session resumes (5pm-session is skipped by `resetAt <= now`); next monitor tick schedules a fresh row for 5:01pm.
- **Daemon restart between insertion and execution.** Pending row in SQLite is picked up only after `hasCompletedFirstTick === true` for each candidate session (so the first post-boot tick is a no-op for both schedule and execute phases). Resumer's re-confirm guard handles the case where the runtime already recovered during downtime.
- **Status-monitor pause / re-entry.** Monitor's existing re-entrant guard prevents concurrent monitor ticks; the scheduler runs INSIDE the monitor tick, inheriting the guard.
- **Background scheduled-agent rate-limit.** Background sessions excluded explicitly (AC7) — their runner controls the lifecycle.
- **Schema_migrations gap.** Verified current max is 7; new version is 8.

### Adversarial analysis

- **How could this fail in production?**
  1. Banner text drift in a new runtime version → silent miss. Mitigation: fixture-driven discipline; deferred-detection scope contingency for the initial PR.
  2. `parseResetTime` over-strict timezone discipline → many real banners marked `unknown_reset` → no auto-resume. Acceptable: status still reflects `rate_limited` (UI helps the operator); auto-resume degrades to manual.
  3. Resumer's bare-Enter lands while operator is mid-keystroke → suppressed by banner re-confirm. If the operator's keystroke obscures the banner just before the resumer's capture, no Enter is sent — operator handles manually.
  4. Daemon crash between resuming session A and session B → row marked `executed` only AFTER the loop completes; on restart, next tick re-detects B's rate_limited state and schedules a new row.
- **What user actions trigger unexpected behavior?**
  - Operator manually stops a rate-limited session before scheduled resumption → session transitions to `stopped`; scheduler filter excludes it. Correct.
  - Operator changes runtime config while session is rate_limited → resumer keys off the existing tmux session name, not runtime config. Correct.
  - Operator scrolls the rate-limit banner off-screen → adapter returns null (no banner match); monitor hysteresis kicks in; after 2 ticks the session may exit `rate_limited`. Acceptable: operator interaction overrides automation.
- **What existing behavior could break?**
  - `PaneObservation` discriminated-union refactor: every call site needs to switch on `kind`. TypeScript catches all.
  - `sessionNeedsAttention(rate_limited) === true` → workspace dot tone change. Operator-visible; intentional.
  - `acceptingStates` excluding `rate_limited` → `sendAgentMessage` to a rate-limited session now returns `session_not_accepting_input` instead of attempting paste-then-fail. Behavior is more honest. Documented in the activity event from the resumer.
- **Which tests credibly catch those failures?**
  - Fixture-driven adapter tests catch (1).
  - `parseResetTime` ambiguity test catches (2).
  - Resumer banner re-confirm test catches (3).
  - Scheduler daemon-restart + per-session reset-due tests catch (4).
- **What gaps remain?**
  - No live E2E against a real Claude/Codex binary; acceptable per the fixture-driven discipline.
  - The bare-Enter recovery may not be sufficient for all future runtimes (cursor-agent specifically — inherits the codex adapter). A per-runtime `resumeAfterRateLimit` capability is a follow-up if needed.

## Tests

TDD order — tests come BEFORE the production code in each step:

1. `packages/contracts/src/index.test.ts` — `rate_limited` round-trip; typed helper exhaustiveness.
2. `packages/db/src/migration.test.ts` — new table + version 8 + partial unique index.
3. `packages/db/src/index.test.ts` — store round-trip with `rate_limited` + resumption CRUD + idempotency.
4. `packages/core/src/index.test.ts` — `parseRateLimitReason` + `sessionNeedsAttention`.
5. `packages/runtimes/src/usage/reset-time.test.ts` — strict timezone discipline.
6. `packages/runtimes/src/status/{claude-code,codex}.test.ts` — fixture tests (subject to Scope contingency).
7. `packages/operations/src/agent-status.test.ts` — reducer for `pane_rate_limited`.
8. `packages/operations/src/status-monitor.test.ts` — observation forwarding + hysteresis.
9. `packages/operations/src/rate-limit-scheduler.test.ts` (NEW) — full lifecycle, post-boot gate, per-session reset-due filter, background exclusion.
10. `packages/operations/src/rate-limit-resumer.test.ts` (NEW) — banner re-confirm + activity event.
11. `apps/web/src/workspace-card.test.ts` + `apps/web/src/stage.test.tsx` — tone + pulse class.
12. Each migrated literal-list site's existing test re-runs unchanged.

Then implementation for each layer in the same order. Each commit covers a tight unit.

## Schema or contract generation

Not applicable. Citadel does not codegen contracts.

## Verification

- `make check` — full local gate (arch, size, typecheck, lint, test, coverage, deps, build). REQUIRED before opening the PR.
- `make smoke` — daemon API smoke. REQUIRED — the daemon HTTP serialization now includes a new enum value and a new table.
- `make e2e` — Playwright happy path. RECOMMENDED but not blocking (no UI flow change beyond a status-dot tone).
- `make performance` — NOT required (no startup or hot-path changes).
