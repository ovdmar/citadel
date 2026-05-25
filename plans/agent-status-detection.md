Activate the /implement-task skill first.

# Plan: Agent Status Detection

## Acceptance Criteria

- [ ] Workspace cards display a small pulsing status icon **before the workspace name**, colored by aggregated agent status:
  - **Green (pulsing)** when at least one agent in the workspace is `running`
  - **Red (pulsing, faster)** when at least one agent in the workspace is `waiting_for_input`
  - **Grey (static)** otherwise (all sessions idle / stopped / failed / unknown / no sessions)
  - Red takes priority over green (a workspace with one running + one waiting → red).
- [ ] **Turn completion is detected** for Claude Code and Codex. The transitions `running → idle` (agent finished a turn) and `running → waiting_for_input` (agent blocked on a question / sandbox approval) both fire `agent.updated` SSE events so a completion sound can be wired to either. **Latency budget**: Claude Code ≤2 seconds (one monitor tick); Codex up to 6 seconds worst case (its `≥2 stable ticks → idle` heuristic at 2s tick interval). Codex's slower latency is documented and explicitly excluded from any sub-5s target — best-effort fallback.
- [ ] **Claude Code background work suppresses turn-completion.** When the pane shows `· N monitor`, `· N shell`, or `· N local agent` (subagent), status stays `running` — no premature completion sound. Captured empirically — see fixture files.
- [ ] **`ScheduleWakeup` / `CronCreate` do NOT suppress completion** — they are fire-and-forget per empirical verification (pane mode line does not surface them). When a wakeup fires, it spawns a new turn that registers normally.
- [ ] When a launched agent CLI process exits (rare — user `/quit`s or it crashes), Citadel records `stopped` or `failed` with `lastStatusAt` and `exitCode` updated from the bash wrapper.
- [ ] `list_agent_sessions` MCP returns each session with canonical status, `statusReason`, `lastStatusAt`, `lastOutputAt`, `endedAt`, `exitCode`.
- [ ] Restart/reload does not erase status; `unknown` is used when Citadel cannot prove liveness.
- [ ] Tests cover the reducer/status transitions, adapter regex matched against captured pane fixtures, and at least one API/MCP path.
- [ ] Existing tests / lint / build pass.

## Context and problem statement

Citadel persists a status on `agent_sessions` today, but it's only updated at session creation and during the 30s reaper. This is insufficient for:

- **Accurate workspace card state** — operators need to see at a glance whether the agent in each workspace is working, idle, or needs their attention.
- **Completion sounds** — fire when the agent finishes a turn (either by going idle or asking the user a question). Sub-5s latency target.
- **MCP `list_agent_sessions`** — clients need canonical status + a machine-readable reason and timestamps.

Three product realities make detection non-trivial:

1. **Agent CLIs don't exit between turns.** Claude Code / Codex / cursor-agent are long-lived TUIs. The bash wrapper's exit code only fires when the user actually `/quit`s the CLI. `stopped`/`failed` are session-lifecycle events, not turn-completion events.
2. **Two distinct turn-completion modes** — both fire sounds: `idle` (turn ended on the agent's initiative) and `waiting_for_input` (agent invoked a question / sandbox approval tool).
3. **Claude Code has in-turn background work** — `Monitor`, background `Bash` (`run_in_background:true`), subagents (`Task` tool). When the main turn ends while any of these are in flight, the session is still alive; treating that as "turn complete" would fire false completion sounds.

## Design choice: pane-based over hook-based

The plan's earlier draft used Claude Code's native hooks (`Stop` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse`) for deterministic turn detection. That approach was rejected as too complex:

- Required an HTTP endpoint exposed on the daemon for each hook event
- Required per-session settings-file injection with a spike for the mechanism (`CLAUDE_CONFIG_DIR` / `--settings` / `.claude/settings.local.json` merge with sentinel comments)
- Required port re-templating on daemon restart, orphan sweep, etc.
- Required spikes for: (a) hook injection mechanism, (b) wakeup→UserPromptSubmit assumption, (c) question-tool name
- Per-session stateful adapter with `backgroundCount`, `questionAsked`, `suppressedStop`

**Pane-based detection is preferred** because it provides all the same information visible to the operator. We've empirically verified — by launching real Claude Code and Codex sessions and capturing pane content — that every relevant state is visually distinguishable:

- Running: bottom mode line ends with `· esc to interrupt`
- Idle (truly done): bottom mode line is bare `⏵⏵ auto mode on (shift+tab to cycle)`
- Background work in flight: bottom mode line shows `· N (monitor|shell|local agent) · ↓ to manage`
- AskUserQuestion (Claude): footer `Enter to select · ↑/↓ to navigate · Esc to cancel`
- Codex sandbox approval: footer `Press enter to confirm or esc to cancel`

**Trade-off accepted**: pane-based detection is brittle when the runtime's TUI changes (a UI update to Claude Code or Codex can break regex matching). Mitigated by:
- Capturing real pane samples as fixture files committed to the repo
- Regex unit tests asserting against fixtures (any UI change → test failure with concrete diff)
- Failure mode is "no completion sound fires" (under-detection) rather than wrong status — never wrong-direction errors

This is the right reliability-vs-complexity trade for v1. Hooks remain in the design history for a future iteration if pane brittleness becomes an actual problem in practice.

## Spec alignment

`specs/B.3-agent-sessions-terminal.md` declares related items as unchecked. The plan's **first step** updates B.3 to lock the canonical status set (`starting, running, waiting_for_input, idle, stopped, failed, unknown`), define each precisely, and note the pane-based detection mechanism per runtime.

## Implementation approach

1. **Pane-based detection for all runtimes.** A stateful per-session adapter analyzes the pane on each monitor tick and returns one of: `running`, `idle`, `waiting_for_input`, or `null` (no opinion).
2. **Empirical fixture-driven regex.** Capture real pane outputs for each scenario, commit as fixtures under `packages/runtimes/src/fixtures/<runtime>/<state>.txt`, write regex unit tests against fixtures. When a runtime UI changes, the test diff is the concrete evidence; the fix is updating both the fixture and the regex.
3. **Reducer with stickiness.** Lifecycle signals (`tmux_missing`, `exited_*`) come from the monitor; adapter observations come from the per-runtime adapter; both flow through the reducer which enforces terminal-state stickiness, reason refinement on `unknown`, and `lastOutputAt` debouncing.
4. **2-second monitor tick** for non-terminal sessions, skipping `shell` runtime. Single batched `tmux list-sessions` per tick.
5. **Workspace-level UI aggregation** — derived from per-agent statuses in the existing `agent_sessions` table.

## Alternatives considered

1. **Native Claude Code hooks** (the rejected v2 design). More reliable in principle, but several spikes deep and adds significant infrastructure surface area. Not needed once we verified empirically that all states surface in the pane.
2. **Separate `@citadel/supervisor` wrapping each spawn as a Node child_process.** Rejected — would break tmux session durability across daemon restarts (spec B.3.9).
3. **`fs.watch` on the sentinel file for sub-second exit detection.** Deferred — 2s polling is adequate for the completion-sound UX.
4. **Pidstat / cgroup CPU activity as the running signal.** Rejected — pane is the right abstraction; we already have to capture it for `read_agent_output`.

## Implementation steps

### 1. Spec update (first step, before any code)

- Edit `specs/B.3-agent-sessions-terminal.md`:
  - Lock the canonical status set: `starting, running, waiting_for_input, idle, stopped, failed, unknown`.
  - Define semantics precisely: `idle` = turn ended on agent's initiative; `waiting_for_input` = agent blocked on a question / sandbox-approval tool; `stopped`/`failed` = CLI process actually exited.
  - Note pane-based detection mechanism with per-runtime adapters.
  - Add an item documenting the pulsing icon on workspace cards: green = at-least-one running, red = at-least-one waiting_for_input, grey = otherwise.

### 2. Contract & schema changes

- `packages/contracts/src/index.ts`:
  - Replace `AgentSessionStatusSchema` values with `["starting", "running", "waiting_for_input", "idle", "stopped", "failed", "unknown"]`.
  - Extend `AgentSessionSchema` with: `lastStatusAt: string`, `lastOutputAt: z.string().nullable()`, `endedAt: z.string().nullable()`, `exitCode: z.number().int().nullable()`, `statusReason: z.string().nullable()`.

- `packages/db/src/index.ts`:
  - Migration wrapped in `BEGIN IMMEDIATE ... COMMIT`:
    - Add columns: `last_status_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'`, `last_output_at TEXT`, `ended_at TEXT`, `exit_code INTEGER`, `status_reason TEXT`.
    - Backfill `last_status_at = updated_at` for existing rows.
    - Map status values: `waiting → running` (reason `migrated_from_waiting`), `orphaned → unknown` (reason `migrated_from_orphaned`). `idle` preserved as-is (semantic aligns with new meaning), but stamp `status_reason='migrated_legacy_idle'` so any pre-existing `idle` row is traceable. Confirmed by grep that no current code path writes `idle`; the stamp catches any legacy rows.
  - Replace `updateSessionStatus(id, status)` with `updateSessionStatus(id, { status, reason, lastStatusAt, lastOutputAt?, endedAt?, exitCode? })`.

#### Migration table

| Operation | Class | Reversible? |
|---|---|---|
| `ALTER TABLE agent_sessions ADD COLUMN last_status_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'` | additive | yes |
| `ALTER TABLE agent_sessions ADD COLUMN last_output_at TEXT` | additive | yes |
| `ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT` | additive | yes |
| `ALTER TABLE agent_sessions ADD COLUMN exit_code INTEGER` | additive | yes |
| `ALTER TABLE agent_sessions ADD COLUMN status_reason TEXT` | additive | yes |
| `UPDATE agent_sessions SET last_status_at = updated_at` | data backfill | n/a (idempotent) |
| `UPDATE agent_sessions SET status='running', status_reason='migrated_from_waiting' WHERE status='waiting'` | data rename | recorded in `status_reason` |
| `UPDATE agent_sessions SET status='unknown', status_reason='migrated_from_orphaned' WHERE status='orphaned'` | data rename | recorded in `status_reason` |

### 3. Wrapper script: capture exit code without breaking fallback shell

`packages/terminal/src/index.ts` `terminalCommand()`:

- Add `agentExitSentinelPath(sessionName) = /tmp/citadel-agent-{name}.exit`.
- Keep the documented fallback-shell behavior. Use a **trap that captures the exit code on signal-death** AND explicit write before `exec` for the happy path:
  ```
  touch LIVE ; trap 'rc=$?; echo $rc > EXIT; rm -f LIVE' EXIT ; <agent> ; rc=$? ; echo $rc > EXIT ; rm -f LIVE ; printf EXITHINT ; exec "${SHELL:-/bin/bash}" -l
  ```
  - **Happy path** (`<agent>` exits naturally): the explicit `rc=$?; echo $rc > EXIT; rm -f LIVE` runs after `<agent>`; then `exec` replaces the bash process so the trap never fires. `.exit` contains the agent's exit code.
  - **Signal path** (`tmux kill-session` or bash receives SIGTERM): the trap fires before reaching the explicit lines. `$?` at trap time reflects the killed agent's status (typically 130 for SIGINT, 143 for SIGTERM). `.exit` is written by the trap. Status becomes `failed` (non-zero exit), not `unknown`.
  - **`<agent>` not found** (e.g., `claude` not on PATH): `rc=127` per bash convention. Captured correctly by the explicit write.
- Add helpers `agentExitSentinelPath`, `readAgentExitCode(sessionName) → number | null`.
- `killTmuxSession` rms both `.live` and `.exit`.

### 4. Status reducer + signals

`packages/operations/src/agent-status.ts` (new):

```ts
export type StatusSignal =
  | { type: "launch_succeeded" }
  | { type: "launch_failed", reason: string }
  | { type: "tmux_missing", reason: "tmux_missing" | "daemon_restart_indeterminate" | "sentinel_missing_no_exit_record" | "sentinel_missing_tmux_alive" }
  | { type: "exited_clean", exitCode: number, endedAt: string }
  | { type: "exited_failed", exitCode: number, endedAt: string }
  | { type: "active", lastOutputAt: string }
  | { type: "pane_observation", observed: "running" | "idle" | "waiting_for_input" }
  | { type: "optimistic_send" };  // emitted by sendAgentMessage to optimistically transition idle/waiting_for_input → running

export type StatusUpdate = {
  status: AgentSessionStatus;
  reason: string;
  lastStatusAt: string;
  lastOutputAt?: string | null;
  endedAt?: string | null;
  exitCode?: number | null;
};

export function reduceStatus(
  prev: Pick<AgentSession, "status" | "lastOutputAt" | "statusReason">,
  signal: StatusSignal,
  now: () => string,
): StatusUpdate | null;
```

#### Three-case return rule

1. **Status changes** → return non-null update with `lastStatusAt = now`, plus carried fields.
2. **Status same, reason different** (vs `prev.statusReason`) → return non-null update with `statusReason` set, `lastStatusAt` unchanged. Required for refining `unknown` reasons.
3. **Status same, reason same, no other field change** → return `null` (idempotent — no DB write, no SSE emit).

Special carve-outs:
- `active` signal counts as a "field change" only if new `lastOutputAt` exceeds `prev.lastOutputAt + LAST_OUTPUT_DEBOUNCE_MS` (constant = 1000ms).
- Terminal states (`stopped`, `failed`) are sticky: `active` / `pane_observation` signals after exit produce `null`. Only `launch_succeeded` may transition out (i.e., explicit re-launch).
- **`pane_observation` overwrites `statusReason` to a canonical value** when the status field changes: `pane:claude-code:ask-user-question` for `waiting_for_input`, `pane:claude-code:bg-monitor`/`pane:claude-code:bg-shell`/`pane:claude-code:bg-local-agent`/`pane:claude-code:active` for `running` (the specific subcategory captured by the adapter), `pane:claude-code:idle` for `idle`. Same scheme for codex (`pane:codex:sandbox-approval`, `pane:codex:active`, `pane:codex:idle`). This way a session never carries a stale reason like `migrated_from_orphaned` after the adapter has positively observed a fresh state.
- **`optimistic_send`** is a dedicated signal type (NOT `pane_observation`) so the reducer can stamp a distinct `statusReason: "optimistic_send"`. Without this carve-out, calling `pane_observation(running)` from `sendAgentMessage` would overwrite the reason to `pane:claude-code:active` and the Step 9 spurious-sound guard would never trigger. The reducer applies `optimistic_send` only when `prev.status ∈ {idle, waiting_for_input}` → transitions to `running` with `statusReason = "optimistic_send"`. On the next monitor tick, a real `pane_observation(running)` overwrites the reason to the canonical pane-derived value — the guard window is exactly one tick (~2s).

#### Transition matrix

`pane_observation(X)` reads as: adapter says status should be `X`. The reducer applies it with stickiness; for non-terminal `prev`, status becomes `X`.

| prev \ signal | launch_succeeded | launch_failed | tmux_missing(r) | exited_clean | exited_failed | active | pane_observation(running) | pane_observation(idle) | pane_observation(waiting_for_input) | optimistic_send |
|---|---|---|---|---|---|---|---|---|---|---|
| (none/insert) | starting | failed | — | — | — | — | — | — | — | — |
| starting | running | failed | unknown(r) | stopped | failed | running | running | idle | waiting_for_input | — |
| running | — | — | unknown(r) | stopped | failed | running (debounced lastOutputAt only) | — | idle | waiting_for_input | — |
| waiting_for_input | — | — | unknown(r) | stopped | failed | — | running | idle | — | running (reason: `optimistic_send`) |
| idle | — | — | unknown(r) | stopped | failed | — | running | — | waiting_for_input | running (reason: `optimistic_send`) |
| stopped | running (on re-launch) | — | — (sticky) | — | — | — (sticky) | — | — | — | — |
| failed | running (on re-launch) | — | — (sticky) | — | — | — (sticky) | — | — | — | — |
| unknown | — | — | unknown(r) — **reason refinement** | stopped | failed | running | running | idle | waiting_for_input | — |

Notes:
- For `idle` and `waiting_for_input`, a raw `active` signal does NOT transition. The user could be typing in the input area (lots of tmux activity) but that's not "agent working". Only a positive `pane_observation` from the adapter moves status. For runtimes without rich pane signals (codex/cursor), the adapter itself decides when activity counts as `running` (see Step 5).

### 5. Per-runtime status adapter (pane-based, fixture-driven)

`packages/runtimes/src/status-adapter.ts` (new):

```ts
export interface RuntimeStatusAdapter {
  runtimeId: string;
  createSessionState(): SessionAdapterState;
  // Inspect the pane and decide status. Returns null if no opinion.
  // The reducer applies it with stickiness/debouncing.
  observe(state: SessionAdapterState, ctx: ObservationContext):
    "running" | "idle" | "waiting_for_input" | null;
}

export interface ObservationContext {
  paneCapture: string;       // last ~50 lines from tmux capture-pane -p
  paneCaptureSnapshot: string; // alternate-screen-aware visible snapshot (ESC stripped)
  tmuxActivityChangedSinceLastTick: boolean;
  ticksSinceActivityChange: number;
}

export interface SessionAdapterState {
  // Runtime-specific. Default base interface has just these:
  ticksObserved: number;
  lastPaneHash: string | null;
}
```

#### Claude Code adapter

Detection uses **only the visible pane window** (`tmux capture-pane -p` without `-S`, no scrollback). Within that window, regexes are anchored to specific structural positions to avoid false-positives on agent output that contains chrome-like strings.

Capture two values from the visible pane:
- **`lastNonEmptyLine`**: the bottom-most line containing non-whitespace text. This is the chrome line — mode line for Claude, status line for codex.
- **`bottomBlock`**: the last ~10 lines of the visible pane (for matching multi-line UI like AskUserQuestion).

Priority order matches the reducer matrix:

1. **`waiting_for_input`** — `lastNonEmptyLine` is exactly `Enter to select · ↑/↓ to navigate · Esc to cancel`. **Anchored to the last line of the visible pane** — agent output containing that string elsewhere in the body does NOT match. The footer is rendered by Claude Code's question UI as the absolute final visible row.

2. **`running`** — `lastNonEmptyLine` contains ` esc to interrupt`. Anchored to the mode line; agent output that says "esc to interrupt" upstream does not match.

3. **`running` (background work in flight, treated identically to active turn)** — `lastNonEmptyLine` matches:
   ```
   · \d+ (monitor|shell|local agent) · ↓ to manage
   ```
   No `esc to interrupt`. Captured empirically: this is the suffix when the main turn ended but Monitor, background-Bash, or subagent (`Task` tool) is still running. Treated as `running` so the spinner stays and no completion sound fires.

   Note: rule 2 and rule 3 can co-match — when the main turn is ALSO active alongside background work, the mode line is e.g. `⏵⏵ auto mode on · 1 local agent · esc to interrupt · ↓ to manage` (verified in `running-with-local-agent.txt`). Both rules yield `running`; priority order is benign.

4. **`idle`** — `lastNonEmptyLine` matches the bare baseline:
   ```
   ⏵⏵ auto mode on (shift+tab to cycle)
   ```
   (No `esc to interrupt`, no `· N <noun>` indicator.)

5. **`null`** — none of the above match. The reducer treats this as no change. Should only occur briefly during initial spawn before the TUI renders the first frame.

**False-positive coverage** — the fixture suite under `plans/artifacts/agent-status-detection/claude-code/` (and the prod copies in `packages/runtimes/src/fixtures/`) includes a deliberate **negative-case fixture** `false-positive-prompt-text.txt` containing all four chrome strings *as agent output body content* — the regex tests assert the adapter returns `null` or the correct OTHER state for those captures, never `waiting_for_input` from `Enter to select` text appearing in a response.

Note: `ScheduleWakeup` / `CronCreate` are confirmed NOT to produce any persistent indicator in the mode line (empirically verified). When a scheduled wakeup later fires, the pane shows `✻ Claude resuming /loop wakeup (...)` as the new turn begins — at which point `esc to interrupt` reappears and detection naturally classifies as `running`.

#### Codex adapter

Codex doesn't surface most state in the pane. Detection is simpler but more heuristic:

1. **`waiting_for_input`** — `lastNonEmptyLine` is `Press enter to confirm or esc to cancel`. Anchored — same false-positive guard as Claude Code's footer.

2. **`running`** — tmux `#{session_activity}` changed since the previous tick AND `ticksSinceActivityChange === 0`.

3. **`idle`** — `ticksSinceActivityChange >= 2` (≥4s of pane inactivity at 2s tick) AND no `waiting_for_input` match.

4. **`null`** — `ticksSinceActivityChange === 1` (exactly one tick of stability — not yet enough to call idle).

**Latency budget for codex** (specifically excluded from the sub-5s target in Acceptance Criterion that applies to Claude Code):
- Worst case from turn-end to `running → idle` transition: tick `t≤2s` observes final activity → status stays `running`; tick `t≤4s` sees stability=1 → returns `null`; tick `t≤6s` sees stability=2 → emits `idle`. Total: **up to 6 seconds**. Documented as the cost of codex's lack of rich pane indicators.

**Documented codex limitations**:
- Codex has background `Bash` and subagent (`Task`) tools, but does NOT surface them in the pane. A session with background work in flight while the main agent is quiet will be classified `idle` (false-positive completion sound). Acceptable trade-off for v1 — best-effort fallback runtime.
- **Daemon-boot codex idle suppression**: on first post-boot tick for a codex session, the in-memory adapter state has `ticksSinceActivityChange = 0` and no prior activity reference. The adapter MUST NOT emit `idle` on the first tick after `source: "boot"` — gate the `ticksSinceActivityChange >= 2` branch behind `source === "tick" && hasObservedSinceBoot`. Otherwise a daemon restart while a codex session is actively working briefly fires a false completion sound.

#### Cursor-agent / shell / unknown

- **`cursor-agent`**: explicitly wired to use the codex-fallback adapter (`getAdapter(runtimeId)` returns the codex adapter when `runtimeId === "cursor-agent"` until a dedicated cursor adapter is written). Acceptance: a cursor-agent session goes through the same `running` / `idle` / `waiting_for_input` (if the sandbox footer matches) detection path as codex. Binary not installed on the dev machine → adapter behavior verified only against codex fixtures in v1; cursor-specific fixtures captured later. Document as a known limitation.
- **`shell`**: monitor skips this runtime entirely (see Step 6). Status set at launch, never re-evaluated.
- **Unknown runtime**: same fallback as codex.

#### Fixture-driven regex tests

**Seed fixtures already captured and committed** under `plans/artifacts/agent-status-detection/` (see that directory's README for source/version info). These are the byte-for-byte starting point; implementation step 3 copies them into `packages/runtimes/src/fixtures/<runtimeId>/<state>.txt`. After commit, never edit a fixture without re-running the empirical spike to verify the new capture is genuinely from a current runtime.

Plus a deliberate **negative-case fixture** `false-positive-prompt-text.txt` to be captured during impl: launch a Claude Code session, paste agent output that mentions all four chrome strings (`esc to interrupt`, `Enter to select · ↑/↓ to navigate · Esc to cancel`, `· 1 monitor · ↓ to manage`, `Press enter to confirm or esc to cancel`) into a prompt or response, capture the pane; assert the adapter returns the appropriate non-false-positive status. This pins the regex anchoring against future regressions.

Pane captures committed under `packages/runtimes/src/fixtures/<runtimeId>/<state>.txt` (copied byte-for-byte from `plans/artifacts/agent-status-detection/`):

```
packages/runtimes/src/fixtures/
├── claude-code/
│   ├── idle.txt
│   ├── running-mid-stream.txt
│   ├── running-with-monitor.txt
│   ├── running-with-shell.txt
│   ├── running-with-local-agent.txt
│   ├── waiting-for-input-ask-question.txt
│   ├── wakeup-resuming.txt
│   └── ... (one per distinct state)
└── codex/
    ├── idle.txt
    ├── running-mid-stream.txt
    ├── waiting-for-input-sandbox.txt
    └── ...
```

Each adapter has unit tests that load each fixture and assert the adapter's `observe()` returns the expected status. When a runtime's UI changes, the fixture-update + regex-update is one concrete PR.

### 6. Status monitor loop

`packages/operations/src/status-monitor.ts` (new):

- Exports `runStatusMonitorTick(deps, opts: { source: "boot" | "tick" })` and `startStatusMonitor(deps, intervalMs = 2000)`.
- A tick:
  1. List non-terminal sessions: `store.listSessions().filter(s => !["stopped","failed"].includes(s.status) && s.runtimeId !== "shell")`. **Shell sessions are skipped.** **`unknown` is NOT skipped** — re-evaluated each tick so reason can refine.
  2. Single `tmux list-sessions -F '#{session_name} #{session_activity}'` (epoch seconds × 1000 → ms).
  3. Parallel `fs.promises.stat` on `.live` and `.exit` for each session.
  4. For each session, derive lifecycle signals (deterministic, runtime-agnostic):
     - `.exit` present → `exited_clean` (0) or `exited_failed` (non-zero), `endedAt = stat.ctime.toISOString()`
     - `.live` present + tmux present + activity > `prev.lastOutputAt` → `active`
     - tmux missing → `tmux_missing(reason: "tmux_missing")` (or `"daemon_restart_indeterminate"` when `source==="boot"`)
     - `.live` missing + `.exit` missing + tmux present → `tmux_missing(reason: "sentinel_missing_tmux_alive")`
  5. Capture the pane (`tmux capture-pane -p -t <session>` — last 50 lines) for each non-terminal session. Call the runtime adapter's `observe()` with the capture, the activity-since-last-tick boolean, and the stable-tick counter. Adapter returns `"running" | "idle" | "waiting_for_input" | null`. Non-null wrapped as `{ type: "pane_observation", observed: ... }`.
  6. Pass every signal through `reduceStatus`. Each non-null update → `store.updateSessionStatus` + `emit("agent.updated", { workspaceId, sessionId })`.

`apps/daemon/src/app.ts`:
- After server start, start the 2s status monitor (gated by `CITADEL_DISABLE_STATUS_MONITOR !== "1"`).

`packages/operations/src/helpers.ts` `reconcileStore()`:

The existing function returns `{ sessions, workspaces, repos, deletedSessions }` and does THREE things: (a) session status reconciliation, (b) workspace lifecycle reconciliation (worktree-dir-missing → `failed`), (c) repo archiving + root-workspace backfill. The plan replaces ONLY part (a). The wrapper code structure:

1. Call `const sessionResult = runStatusMonitorTick(deps, { source: "boot", emit: () => {} })`. Returns `{ sessionsTouched, deletedSessions }`.
2. **The workspace-membership check lives INSIDE `runStatusMonitorTick`**, not in the reconcileStore wrapper. On every tick (both `source: "boot"` and `source: "tick"`), when a `tmux_missing` signal would be emitted for a session, the tick body first calls `store.listWorkspaces().some(w => w.id === session.workspaceId)`; if false, it calls `store.deleteSession(session.id)` and increments `deletedSessions` instead of emitting the reducer signal. This means workspace deletion mid-session is cleaned up on the next 2s tick, not only at boot. The reconcileStore wrapper just consumes the counts.
3. Keep the existing workspace+repo loops (parts b and c) unchanged after the monitor tick.
4. Return shape unchanged: `{ sessions: sessionResult.sessionsTouched, workspaces, repos, deletedSessions: sessionResult.deletedSessions }`.

Boot threads `emit = () => {}` (no-op — emit fn doesn't exist at module-load time, no SSE clients connected; UI's first `["state"]` fetch sees post-reconcile state).

### 7. Launch-path + send-message updates

`packages/operations/src/create-agent-session.ts`:

- Insert session row with `status: "starting"`, `lastStatusAt: nowIso()`, `lastOutputAt: null`, `statusReason: null`.
- After `ensureTmuxSession` + `waitForTerminalIdle` resolve, call `reduceStatus(prev, { type: "launch_succeeded" }, now)`. Persist the resulting update (`status → running`). Emit `agent.updated`.
- Initialize the adapter session state via `runtimeAdapter.createSessionState()` in an in-memory Map keyed by `sessionId`.
- If `ensureTmuxSession` throws: do NOT insert a session row (matches existing behavior; tests rely on it). Surface failure via the operation/HTTP response.

`packages/operations/src/agent-messages.ts` `sendAgentMessage`:
- After a successful `submitPrompt` (the tmux paste + Enter), if `prev.status === "idle" || prev.status === "waiting_for_input"`, **optimistically transition to `running`** via `reduceStatus(prev, { type: "optimistic_send" }, now)` (the dedicated signal type from Step 4 — NOT `pane_observation`, so the reducer can stamp `statusReason: "optimistic_send"`) and emit `agent.updated`. The next monitor tick will reconcile: a real `pane_observation(running)` overwrites the reason to `pane:claude-code:active`. This eliminates the ~2s lag between submit and the pulsing-green dot appearing.

**Spurious-sound guard**: if the paste failed silently (rare — tmux race, alternate-screen flush eats Enter, agent crashed mid-send), the optimistic `running` is followed by the next tick observing `idle` again — `running → idle` transition. Without a guard, this fires a completion sound for a turn that never happened. **Guard**: the completion-sound trigger (Step 9) suppresses the sound when the immediately-preceding `running` carried `statusReason === "optimistic_send"` AND `prev.lastOutputAt === next.lastOutputAt` (no pane activity occurred during the supposed turn). If pane activity DID occur, the turn was real and the sound fires normally. The UI computes this from the `agent.updated` payload (which carries the new `statusReason` and `lastOutputAt`) by comparing against the cached prior session state.

`packages/operations/src/index.ts` session-lifecycle paths:
- When a session is deleted (`deleteSession`) OR transitions to a terminal state (`stopped` / `failed` / `unknown` for >30s), **evict the adapter-state Map entry** to prevent unbounded growth. The eviction is a no-op for terminal states that may re-emit signals; the next non-terminal transition (re-launch) will call `createSessionState()` again.

**No settings-file injection. No `CLAUDE_CONFIG_DIR` env vars. No hook endpoints. No spikes.** The launch path is unchanged except for the new `status`/`lastStatusAt` write, adapter-state initialization, and the optimistic message-send transition.

### 8. Workspace card pulsing icon

A new visual indicator showing aggregated agent status at the workspace level.

#### Aggregation logic

`apps/web/src/workspace-card.tsx` (or extracted helper):

```ts
type WorkspaceAgentTone = "attention" | "running" | "idle";

const TMUX_GONE_REASONS = new Set([
  "tmux_missing",
  "sentinel_missing_tmux_alive",
  "migrated_from_orphaned",
]);

function deriveWorkspaceAgentTone(sessions: AgentSession[]): WorkspaceAgentTone {
  const agentSessions = sessions.filter(s => s.runtimeId !== "shell");
  // Red ("attention") covers: explicit waiting_for_input AND unknown sessions
  // where Citadel proved the agent is missing (per-session indicator would
  // also flag "Agent needs attention" — workspace dot must match).
  if (agentSessions.some(s =>
    s.status === "waiting_for_input" ||
    (s.status === "unknown" && s.statusReason && TMUX_GONE_REASONS.has(s.statusReason)) ||
    s.status === "failed"
  )) return "attention";
  if (agentSessions.some(s => ["starting", "running"].includes(s.status))) return "running";
  return "idle"; // includes idle, stopped, indeterminate-unknown, and no-sessions
}
```

Priority: `attention` (red) > `running` (green) > `idle` (grey). The `attention` tone covers any session that needs the operator: explicit `waiting_for_input`, `failed`, and `unknown` with a reason indicating "agent was supposed to be there and isn't" (tmux-gone reasons). Indeterminate `unknown` (e.g., `daemon_restart_indeterminate`) stays in `idle` — neutral, not alarming.

#### Rendering

Render a small (~10px diameter) circular dot **before the workspace name** on the workspace card.

```tsx
<div className="workspace-card-title">
  <span
    className={`workspace-status-dot status-${tone}`}
    aria-hidden="true"
  />
  <span className="workspace-card-name">{workspace.name}</span>
</div>
```

Accessibility:
- The dot itself is `aria-hidden="true"` (decorative); the workspace card's outer `<button>` already carries the workspace name, and its `aria-label` is augmented to include the tone status: e.g., `aria-label={\`Open workspace \${workspace.name}\${tone === "attention" ? ", needs attention" : tone === "running" ? ", agent running" : ""}\`}`. Screen readers announce status once, on the button, not separately on the dot.
- `pointer-events: none` on the dot so it cannot intercept clicks targeting the workspace name button.

#### CSS

`apps/web/src/workspace-card.css` (or co-located). Uses a pseudo-element with GPU-composited `transform: scale()` for the pulse halo (rather than `box-shadow`, which triggers paint and can degrade scroll perf on cards with many workspaces).

```css
.workspace-status-dot {
  position: relative;
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 8px;
  vertical-align: middle;
  flex-shrink: 0;
  pointer-events: none;
}

.workspace-status-dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  opacity: 0;
  will-change: transform, opacity;
}

.workspace-status-dot.status-running {
  background: var(--color-green-600, #16a34a); /* darker variant — passes 3:1 against the card surface */
}
.workspace-status-dot.status-running::after {
  background: rgba(34, 197, 94, 0.5);
  animation: pulse-halo 2s ease-out infinite;
}

.workspace-status-dot.status-attention {
  background: var(--color-red-600, #dc2626);
}
.workspace-status-dot.status-attention::after {
  background: rgba(239, 68, 68, 0.6);
  animation: pulse-halo 1.2s ease-out infinite;
}

.workspace-status-dot.status-idle {
  background: var(--color-grey-500, #64748b); /* darker than 400 — passes 3:1 against card */
  /* No pseudo-element animation — static */
}

@keyframes pulse-halo {
  0%   { transform: scale(1);   opacity: 0.6; }
  70%  { transform: scale(2.5); opacity: 0; }
  100% { transform: scale(2.5); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-status-dot::after { animation: none !important; opacity: 0; }
}
```

Accessibility / robustness checklist:
- Dot is decorative (`aria-hidden="true"`); status surfaced in parent button label.
- `pointer-events: none` on the dot — no accidental click interception.
- `prefers-reduced-motion` disables the halo.
- Dot colors use darker `600` / `500` greys to meet WCAG AA 3:1 contrast for non-text UI against the workspace-card background. If existing CSS variables don't define `--color-*-600`, the literal hex fallback is used; verify against actual card background in the smoke test.
- Pulse uses pseudo-element transform/opacity (GPU-composited) instead of `box-shadow` (paint-triggering). 30+ pulsing workspace cards stay under 60fps scroll budget.

#### Coexistence with existing card UI

The existing `deriveAgentState()` function (per-session-level spinner/icon shown elsewhere on the card) stays. The new dot is a **separate, workspace-level summary** rendered before the name. Both can coexist; we may simplify later by removing the older per-session indicator if the new dot subsumes it.

### 9. Completion sound trigger

Sound playback (the audio element wiring in the cockpit) is a follow-up UI task. In scope here: the canonical transitions fire `agent.updated` SSE events reliably so the UI can hook a sound to them.

Trigger logic (consumed by the UI):
- `prev.status === "running"` AND `next.status ∈ {"idle", "waiting_for_input"}` → play sound, **UNLESS** the spurious-send guard applies:
  - `prev.statusReason === "optimistic_send"` AND `prev.lastOutputAt === next.lastOutputAt` → skip the sound (the optimistic transition was followed by no pane activity, so the turn never actually happened — paste likely failed silently).
- UI keeps the previous status per session (React Query cache already does this) and compares on update.

Acceptance test: a real Claude Code session run through two turn cycles (prompt → response → prompt → response) fires exactly two `running → idle` transitions, exactly two SSE `agent.updated` events with this transition.

### 10. UI & MCP reader updates (enumerated)

| File:line | Today's filter | New filter | Why |
|---|---|---|---|
| `apps/web/src/workspace-card.tsx:deriveAgentState` | tone tree on `starting`/`waiting`/`failed`/`orphaned` | tone tree on canonical 7 (see below) | Per-session indicator (keep alongside new dot) |
| `apps/web/src/cockpit-readiness.ts:25` | `["starting","waiting"]` → "Working" | `["starting","running"]` | Only actively-working bucket as Working. `idle` and `waiting_for_input` are attention states, not "active work". |
| `apps/web/src/settings-repositories.tsx:136` | `["starting","running","waiting","idle"]` | `["starting","running"]` | Drop dead `waiting`; `idle`/`waiting_for_input` excluded |
| `apps/daemon/src/readiness.ts:39` | `["starting","waiting"]` | `["starting","running"]` | Same as cockpit-readiness |
| `apps/daemon/src/readiness.ts:41` (failed-tone) | `["failed","orphaned"]` | `["failed"]` | Drop `orphaned`; `unknown` handled via `statusReason` |
| `packages/operations/src/index.ts:492` | `["starting","running","waiting","idle"]` | `["starting","running"]` | Readiness summary |
| `packages/operations/src/agent-messages.ts:38` `acceptingStates` | `["starting","running","waiting","idle"]` | `["starting","running","waiting_for_input","idle"]` | **Must accept `waiting_for_input` AND `idle`** — sending a message to an agent at an input prompt or freshly idle is the operator's workflow |
| `packages/core/src/index.ts:52` (`activeSession`) | `["running","waiting"]` | `["running"]` | Active = actively working |
| `packages/mcp/src/index.ts` `list_agent_sessions` payload | adds new fields | adds new fields | MCP contract |

**Per-session tone mapping in `deriveAgentState`** (existing UI surface, separate from the new dot):

| Canonical status | Tone | Spinner? | Label |
|---|---|---|---|
| starting | starting | yes | Agent starting |
| running | running | yes | Agent working |
| waiting_for_input | failed | no | Agent waiting for input |
| idle | failed | no | Turn complete |
| stopped | stopped | no | Agent stopped |
| failed | failed | no | Agent needs attention |
| unknown + reason `tmux_missing` or `migrated_from_orphaned` or `sentinel_missing_tmux_alive` | failed | no | Agent missing (tmux gone) |
| unknown + reason `daemon_restart_indeterminate` or `sentinel_missing_no_exit_record` | stopped | no | Agent status unknown |

Tone union unchanged: `"starting" | "running" | "stopped" | "failed"`.

`packages/mcp/src/index.ts` `list_agent_sessions`:
- Include `status`, `statusReason`, `lastStatusAt`, `lastOutputAt`, `endedAt`, `exitCode` in the per-session payload. Update the tool's output schema description.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|---|---|---|
| BE unit | Required | Reducer (highest-value test target). Adapters with fixture-driven regex. Migration round-trip. Wrapper script exit-code capture. |
| FE unit | Required | `deriveAgentState` mapping table. `deriveWorkspaceAgentTone` table. CSS smoke test (snapshot or computed-style assertion that pulsing classes apply). |
| Integration | Required | Daemon-level test spawning fake agents (`bash -c 'exit N'`) and asserting status reaches `stopped`/`failed` with `exitCode`. Real Claude Code / Codex sessions to validate adapter regexes against live pane output. MCP `list_agent_sessions` shape test. |
| E2E | Not required | UI rendering change covered by FE unit + visual smoke (Playwright snapshot of workspace card with each tone). Adding real-agent E2E would be flaky. |

### Pane fixture capture (mandatory before regex commits)

Before adapter code lands, run real sessions and capture pane outputs for each scenario per runtime. Commit fixtures to `packages/runtimes/src/fixtures/<runtime>/<state>.txt`. The captures from the empirical spike already done in this conversation are the seed set.

Per Claude Code:
- `idle.txt` — bare `⏵⏵ auto mode on (shift+tab to cycle)` with recent `✻ [VerbPast] for [N]s`
- `running-mid-stream.txt` — `· esc to interrupt` in mode line
- `running-with-monitor.txt` — `· 1 monitor · ↓ to manage`
- `running-with-shell.txt` — `· 1 shell · ↓ to manage`
- `running-with-local-agent.txt` — `· 1 local agent · ↓ to manage` (subagent)
- `waiting-for-input-ask-question.txt` — `Enter to select · ↑/↓ to navigate · Esc to cancel`
- `wakeup-resuming.txt` — `✻ Claude resuming /loop wakeup (...)`

Per Codex:
- `idle.txt` — `<model> default · <cwd>` status line, no recent activity
- `running-mid-stream.txt` — same visual + tmux activity recent
- `waiting-for-input-sandbox.txt` — `Press enter to confirm or esc to cancel`

### New tests to add

- `packages/operations/src/agent-status.test.ts`:
  - Reducer matrix — every cell.
  - Stickiness: prev=`stopped`, signal=`active` → null.
  - Debounce: prev=`running` lastOutputAt=t, signal=`active` at t+500ms → null. At t+1100ms → update.
  - `lastStatusAt` advances only on status-field change.
  - Reason refinement: prev=`unknown(daemon_restart_indeterminate)`, signal=`tmux_missing(tmux_missing)` → update with new reason, `lastStatusAt` unchanged.

- `packages/runtimes/src/claude-code-adapter.test.ts`:
  - Each fixture file → assert adapter `observe()` returns the documented status.
  - Cursor in scrollback (e.g., AskUserQuestion footer in old captures higher up) does NOT match — only the last 5 lines of the visible pane drive detection.

- `packages/runtimes/src/codex-adapter.test.ts`:
  - Each fixture file → assert correct status.
  - Activity-timestamp stub test: `ticksSinceActivityChange < 2` → null; `>= 2` → idle.

- `packages/operations/src/status-monitor.test.ts`:
  - Mock lifecycle signal sources + adapter `observe()`. Tick through sequence: launch → active → adapter says running → ... → adapter says idle. Assert correct `updateSessionStatus` + `emit` calls.
  - Single `tmux list-sessions` per tick regardless of N.
  - `tmux #{session_activity}` parsed as seconds × 1000.

- `packages/terminal/src/wrapper.test.ts`:
  - Launch through `terminalCommand` with `bash -c 'exit 7'`. Assert `.exit` file contains `7`. Assert pane is still alive (fallback shell). Regression for the wrapper's primary purpose.

- `packages/db/src/migration.test.ts`:
  - Pre-migration `waiting`, `orphaned`, `idle` rows → post-state. Crash injection between ALTER and UPDATE → rollback intact.

- `apps/web/src/workspace-card.test.ts`:
  - `deriveWorkspaceAgentTone` table: every combination of session statuses → expected aggregated tone. Priority: red > green > grey.
  - CSS class application: workspace card with one running agent renders `.status-running` on the dot.
  - `prefers-reduced-motion` query disables animation.

- `apps/daemon/src/agent-status.integration.test.ts`:
  - `bash -c 'sleep 0.3 ; exit 0'` → `status === "stopped"`, `exitCode === 0`, `endedAt` set.
  - `exit 7` → `status === "failed"`, `exitCode === 7`.
  - tmux killed externally → `status === "unknown"`, `statusReason === "tmux_missing"`.
  - Real Claude Code spawn: launch, wait ~5s, assert `status === "idle"` after first prompt completes. Run a second turn, assert second `idle` transition fires `agent.updated`.

### Existing tests to update

- `apps/daemon/src/app.test.ts` "inspects a path, lists branches, refreshes provider caches, and reconciles ghost state" — update `orphaned` → `unknown` + `statusReason='tmux_missing'`.
- `apps/web/src/cockpit-readiness.test.ts` — assert new filter set.
- `apps/daemon/src/readiness.test.ts` — same.
- `packages/operations/src/agent-messages.test.ts` — assert `send_agent_message` accepts `waiting_for_input` and `idle`.
- Any test asserting literal `"waiting"` / `"orphaned"` → update.

### Assertions to tighten

- `endedAt` set iff `.exit` file was observed (independent of status — `unknown` with `.exit` present is impossible by construction, but the assertion should reference the observation, not the status).
- `exitCode` set iff `.exit` file was readable.
- `lastStatusAt` advances iff status field changes; reason-only refinement does NOT advance it.

### Failure modes / edge cases

- **Adapter false negative** (regex misses a state): worst case is "no completion sound fires" or "spinner stuck on". Tests fail when fixtures drift. Never wrong-direction (we don't fabricate completions).
- **Adapter false positive on `waiting_for_input`** (codex sandbox prompt regex matches text in agent output): graceful — operator sees a red dot, looks at pane, sees nothing to answer, the next tick reverts to `running` or `idle`.
- **Codex background work not surfaced**: documented limitation. Best-effort fallback runtime.
- **Daemon restart while agent mid-turn**: adapter state (the per-session Map) is wiped. First tick after restart re-evaluates from pane — naturally re-converges.
- **/tmp cleared while session alive**: `.live` + `.exit` both missing while tmux alive → `unknown(sentinel_missing_tmux_alive)`. Adapter still observes the pane and may emit `running`/`idle`; reducer applies. Honest degradation.
- **Terminal-state resurrection**: prev=`stopped`, user types in fallback shell → tmux activity bumps; reducer's stickiness keeps status `stopped`.
- **Shell runtime**: monitor skips it.

### Adversarial analysis

- **How could this fail in production?** Regex matches the wrong line (e.g., a user types `esc to interrupt` into their prompt area). Mitigation: detection uses only the last few lines of the visible pane (mode line region), not scrollback.
- **What user actions trigger unexpected behavior?** User types `Enter to select · ↑/↓ to navigate · Esc to cancel` into the prompt → matched as `waiting_for_input`. Acceptable false positive — operator sees the red dot, checks the pane, dismisses; next tick reverts.
- **What existing behavior could break?** Reader filters checking literal `"waiting"` / `"orphaned"`. Enumerated in Step 10.
- **Which tests credibly catch failures?** Reducer matrix + fixture-driven adapter tests + integration test with real Claude/Codex spawns.
- **What gaps remain?** New Claude Code UI in future releases breaks regexes silently until the next test run picks it up. Cursor-agent not exercised in v1 (binary unavailable).

## Tests (TDD order)

1. `packages/operations/src/agent-status.test.ts` — reducer matrix.
2. `packages/operations/src/agent-status.ts` — implementation.
3. Capture pane fixtures from real sessions; commit under `packages/runtimes/src/fixtures/`.
4. `packages/runtimes/src/claude-code-adapter.test.ts` — fixture-driven.
5. `packages/runtimes/src/codex-adapter.test.ts` — fixture-driven.
6. `packages/runtimes/src/status-adapter.ts` + `claude-code.ts`, `codex.ts`, `cursor-agent.ts`, `shell.ts` until adapter tests pass.
7. `packages/operations/src/status-monitor.test.ts`.
8. `packages/operations/src/status-monitor.ts`.
9. `packages/db/src/migration.test.ts` — migration + crash injection.
10. Update `packages/contracts/src/index.ts` (enum + new fields).
11. Update `packages/db/src/index.ts` (`updateSessionStatus` signature, `mapSessionRow` new fields).
12. Update `packages/operations/src/helpers.ts` `reconcileStore()` to delegate to monitor body.
13. Update `packages/operations/src/create-agent-session.ts` (launch path via reducer; no row on spawn failure).
14. Update wrapper script in `packages/terminal/src/index.ts` + `packages/terminal/src/wrapper.test.ts`.
15. `apps/daemon/src/agent-status.integration.test.ts` (write first), then wire monitor into `apps/daemon/src/app.ts`.
16. Update `packages/mcp/src/index.ts` and MCP shape test.
17. `apps/web/src/workspace-card.test.ts` (write first), then implement `deriveWorkspaceAgentTone` + pulsing-dot rendering in `workspace-card.tsx` + CSS.
18. Update every reader listed in Step 10's table.
19. Three-part enum-removal gate.

## Schema or contract generation

No codegen step. SQLite migrations hand-written and run on boot. Zod schemas source of truth. `make check` validates architecture boundaries.

**File-size watch**: claude-code adapter (regex + state + fixture-loading) is the largest new file. If it approaches the 500-line ceiling, split into `claude-code-adapter.ts` + `claude-code-regex.ts` along the natural seam.

**MCP versioning**: adding fields to `list_agent_sessions` is non-breaking for clients that ignore unknown fields. If a schema version is exposed today, bump it; confirm during impl.

**User-visible label change**: `apps/web/src/cockpit-readiness.ts` filter change means plain `running` agents are now bucketed as "Working" where they weren't before. Document in release notes.

## Verification

From repo root:
- `pnpm typecheck` — passes
- `pnpm lint` — passes (Biome)
- `pnpm test` — passes (Vitest unit + integration)
- `pnpm run check:arch` / `:size` / `:deps` — pass
- `pnpm build` — passes
- `make check` runs the full pipeline.
- **Three-part enum-removal gate**: (1) `pnpm typecheck` clean; (2) Step 10's enumerated reader-table sweep applied; (3) advisory `grep -rnE '"waiting"|"orphaned"' apps/ packages/ scripts/` produces no results outside migration code / reducer-test fixtures.
- (Optional smoke before merge) `make dev`, launch a Claude session, observe pulsing-green dot on workspace card; trigger `AskUserQuestion`, observe red dot; complete the question, observe green dot return; close the agent CLI, observe grey dot.
