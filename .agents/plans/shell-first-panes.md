Activate the /implement-task skill first.

# Plan: Shell-first pane lifecycle (eliminate the agent-as-pane-PID wrapper)

## Acceptance Criteria

- [ ] When a new agent session is created, the tmux pane's PID is `bash -l`, not the agent binary. The agent (`claude --resume <uuid>`, `codex`, etc.) runs as a child of the shell, launched via `tmux send-keys` after the shell prompt is ready.
- [ ] No bash wrapper script around the agent. No `EXIT` trap that writes `$?` to disk. No `exec "${SHELL}" -l` post-exit fallback.
- [ ] No `/tmp/citadel-agent-*.live` files are ever created by the daemon.
- [ ] No `/tmp/citadel-agent-*.exit` files are ever created by the daemon.
- [ ] When the agent inside a pane is Ctrl+C'd or exits naturally, the pane stays alive (because the shell is still the PID 1 of the pane). The user sees the agent's last output above the shell prompt.
- [ ] When the tmux server crashes (citadel-tmux.service), no session in the DB is mass-flipped to `stopped`. Sessions transition to `unknown` (tmux unreachable) and recover to their actual status when tmux is back. This invariant must hold across BOTH the periodic status-monitor tick AND the boot-time `reconcileStore` call.
- [ ] `citadel-tmux.service` is `Type=simple` running tmux in foreground (`-F`). A tmux crash is detected by systemd and triggers `Restart=on-failure RestartSec=2`.
- [ ] `citadel.service` declares `Wants=citadel-tmux.service` (not `Requires=`). A tmux restart does not force a daemon restart + boot-restore cascade.
- [ ] The cockpit displays a Restart button on `idle` agent sessions (shell present, agent not running). Clicking it sends the agent command to the existing pane via `tmux send-keys` — no `respawn-pane`, no kill-and-recreate.
- [ ] Status detection reads `pane_current_command` from tmux. Match is **positive** (foreground command == runtime binary name, with `comm` 15-char truncation handled). Runtime adapters continue to derive `waiting_for_input` / `rate_limited` / `usage_limited` from pane content as today.
- [ ] On daemon boot, any pre-existing `/tmp/citadel-agent-*.{live,exit}` files left over from the old architecture are swept clean (one-time migration of the existing ~3,300 files). Sweep is gated against a concurrent old daemon (age-filter + marker file).
- [ ] The "Plain Terminal" runtime (`shell`) and agent runtimes share the same session-creation code path. No special-case branch for "this is a terminal vs this is an agent" — but the status-derivation table treats the `shell` runtime distinctly (no `idle` state for plain terminals, because the shell IS the runtime).
- [ ] `send_agent_message` (MCP) and the cockpit prompt-send path refuse to deliver input when the foreground pane process is a shell binary (i.e., agent is not running). The check is performed at send-time, not just based on cached DB status.
- [ ] Auto-resume's "type a follow-up message into a rate-limited agent" path continues to use `sendAgentMessage` (paste + Enter into the live agent TUI), NOT the new `launchAgentInSession`. Restart is a separate user-triggered affordance.
- [ ] `launch_failed` reducer signals write `status='stopped'` (not `'failed'`). `exited_failed` reducer signals are removed (without sentinels there is no source). The schema retains `'failed'` as a legal value to preserve historical DB rows but the daemon never emits it after this PR.
- [ ] First-boot of the new daemon detects "wrapper-style" sessions left over from the old architecture (pane PID is a `bash -c <wrapper-script>`) and migrates them: kill + re-spawn shell-first with `claude --resume <uuid>`.
- [ ] `make install` only restarts a systemd unit when the unit file content actually changed (idempotency).
- [ ] No file in the diff exceeds the 800-line cap (`scripts/checks/file-size.ts`). New lifecycle helpers (`launchAgentInSession`, `panePidProcess`, `sweepLegacyAgentSentinels`) live in a sibling `packages/terminal/src/pane-lifecycle.ts`, not in the already 736-line `index.ts`.
- [ ] `launchAgentInSession` preserves the full color-env prefix the existing wrapper applies — `env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1 <argv>` (single `env` invocation, byte-for-byte matching `packages/terminal/src/index.ts:131`). Agents render with the same TUI colors as today.
- [ ] When an agent transitions `running → idle` without a recorded user-initiated termination within the prior 5 seconds, the status-monitor labels the session with `statusReason: 'idle_after_unexpected_exit'`. User-initiated terminations are recorded from exactly two sources: (1) the cockpit Restart endpoint, and (2) a new lightweight `POST /api/agent-sessions/:sessionId/user-action` endpoint that the **terminal-key-shim injected into ttyd's iframe page** (`apps/daemon/src/terminal-key-shim.client.js` — already runs in the iframe with full keyboard + same-origin fetch access) hits whenever the operator types Ctrl+C inside the embedded terminal. Fire-and-forget, in parallel with letting the Ctrl+C propagate to xterm/ttyd/PTY as today. Other "stop" paths (Stop endpoint, MCP `stop_agent_session`, restore-routes absorb) delete the session row synchronously and don't need labeling. The cockpit's attention-tone predicate (`sessionNeedsAttention` in `packages/core/src/index.ts`) treats `idle_after_unexpected_exit` as attention-worthy (red pulse). The reason auto-clears to plain `idle` after 30 minutes (keyed off the new `statusReasonAt` field, not `lastStatusAt`) OR on operator Restart.
- [ ] Hybrid-session migration in boot-restore detects wrapper-style sessions via `/proc/<pane_pid>/cmdline` containing `bash -c` (not the scrollback heuristic, which only matches AFTER agent exit). The exit-hint scrollback check is a fallback only.

## Context and problem statement

Citadel's terminal subsystem treats every tmux pane as if its PID is the agent process (`claude`, `codex`, `bash`). To paper over the lifecycle consequences of that assumption, a bash wrapper script was added around every agent that:

1. Writes a `.live` sentinel before exec'ing the agent.
2. Sets an `EXIT` trap that writes `$?` to a `.exit` sentinel.
3. After the agent exits, `exec "${SHELL}" -l` so the pane survives.

The `apps/daemon/src/status-monitor*.ts` family (which wires into the operations-layer `runStatusMonitorTick` in `packages/operations/src/status-monitor.ts`) reads these sentinels alongside tmux's own state to derive the canonical session status. The reconciler in `packages/operations/src/helpers.ts` ALSO reads `isAgentLive` on boot. This works in steady state but has produced two production incidents in a single day:

- **2026-05-26 07:16:44** — `citadel-tmux.service` (Main PID 4022755) SEGV'd after the tmux server consumed 29.8 GB. systemd's `Type=forking` + `RemainAfterExit=yes` left the unit "active (exited)" even though the real server was gone. The just-merged PR #35 (`fb-tmux-leak-fixes`) added an orphan-client reaper, a `history-limit 5000` cap, and `/tmp/citadel-pty/` rotation as guardrails on this architecture.
- **2026-05-26 18:40:57** — Same failure mode, this time at 18.61 GB. The new daemon code from PR #35 was running, but the tmux server (started 07:16:47) was the same long-lived process — the guardrails couldn't retroactively fix an already-bloated tmux. When tmux died, every wrapper's `EXIT` trap fired simultaneously, wrote 3,300+ `.exit` files into `/tmp`, and the status-monitor mass-flipped every session in the DB to `stopped` with `statusReason: "exit_code_0"`. The cockpit, which hides stopped sessions, then showed "no sessions in any chat."

Inverting to *shell-as-pane-PID* with the agent as a child of the shell removes the structural reason the wrapper exists. The "no sessions in any chat" symptom becomes structurally impossible: no wrapper traps to fire on tmux crash, no `.exit` files to write, no mass-flip-to-stopped to happen — *provided* the equivalent code path in `reconcileStore` is also updated (this plan does so).

## Spec alignment

The plan touches `specs/B.3-agent-sessions-terminal.md` (primarily) and adjacent specs.

| Spec | Item | Change required | Reason |
|---|---|---|---|
| `specs/A-shared-definitions.md` | #4 (Runtime adapter — "shell-backed agent") | None | Language already correct; the change makes it literal. |
| `specs/B.3-agent-sessions-terminal.md` | #8 (status enum) | **Reserve `failed`** — keep the enum value legal (historical rows preserve forensic value, `launch_failed` reducer signal still meaningful), but document that `failed` is reserved for `launch_failed` only; `exited_failed` is no longer generated. Document the operator-visible consequence: an agent that crashes mid-session shows `idle` afterwards (not `failed`), and the user reads the pane content to see what happened. | Without the `.exit` sentinel, the daemon cannot reliably distinguish "agent exited cleanly" from "agent exited with non-zero." This is an honest signal loss; the spec must call it out. |
| `specs/B.3-agent-sessions-terminal.md` | Terminal #3 | None (still durable tmux sessions, just more accurately) | |
| `specs/B.3-agent-sessions-terminal.md` | Terminal #9 | **Update** — remove sentinel-cleanup language; the daemon no longer writes `/tmp/citadel-agent-*` files (only `/tmp/citadel-pty/` which PR #35 already addressed). Keep the orphan-client reaper language. | Sentinel cleanup is no longer relevant. |
| `specs/B.7-operations-activity-mcp.md` | #8 (`send_agent_message`, `session_not_accepting_input`) | **Update** — the "active status" check must verify at send-time (via `panePidProcess`) that the foreground command is an agent binary, not a shell. Cached DB `status` is not sufficient because `idle` previously meant "agent paused, ready for input" and now means "shell prompt, no agent". | MCP behavior must remain consistent: typing into an idle (shell) pane must not silently inject into a bash prompt. |
| `specs/B.7-operations-activity-mcp.md` | #61 (operative paste + Enter detail) | **Update** — `start_agent_session` is now: spawn shell → wait for shell prompt → send agent command via `send-keys` Enter → wait for agent TUI prompt (positive `runtimeReadyPredicate` matching agent binary, not just "not a shell") → paste initial prompt + Enter. | Same delivery mechanism, just preceded by an agent-launch step with positive predicate. |
| `specs/B.8-ui-performance-quality.md` | #5 (terminal scrollback bound) | None | Already updated in PR #35. |

**Spec updates are step 1** of the implementation steps below.

## Implementation approach

**One pane, one shell, agent as a child.** Every tmux session is created with `bash -l` as its pane process. After the shell prompt settles (existing `waitForTerminalIdle` helper, ~200-500ms), the daemon sends the agent command via `tmux send-keys` with the **full color-env prefix the existing wrapper preserves today** — literally `env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1 <quoted-argv>` (single `env` invocation, byte-for-byte matching `packages/terminal/src/index.ts:131`). All five env tokens are required; dropping any one produces a visible TUI rendering regression in claude / codex. The agent then runs with that env, inherits the shell's PTY and cwd, and is a child of bash. When the agent exits — Ctrl+C, natural exit, crash, or `/quit` — bash receives the exit and returns to its prompt. The pane stays alive because the shell is still PID 1 of the pane.

**Composition with the existing `submitPrompt` helper.** Agent launch and initial-prompt delivery are TWO distinct steps with different timing characteristics. `createAgentSession` becomes the explicit three-step composition:
1. `ensureTmuxSession` — creates the pane with `bash -l` as PID 1.
2. `launchAgentInSession(name, argv)` — `tmux send-keys 'env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1 <quoted-argv>' Enter`, then `waitForPaneCommand` until the foreground is the runtime binary (positive match, not "not a shell").
3. `submitPrompt(name, initialPrompt, …)` (existing helper, unchanged) — bracketed paste + Enter only if the user provided an initial prompt.

**Status detection becomes positive-match.** The runtime adapters continue to do their pane-content regex matching for derived statuses (`waiting_for_input` / `rate_limited` / `usage_limited`), but the bedrock status (running / idle / unknown / stopped) is derived from `pane_current_command`:
- **Per-runtime resolution.** Status-monitor consults the session's `runtimeId` to know which command name to expect.
- For agent runtimes (claude / codex / cursor-agent / pi): foreground command == runtime's `command.slice(0, 15)` → `running`. Foreground command is a shell binary (bash / sh / zsh / fish / dash) → `idle`. `has-session` fails → `unknown`.
- For the `shell` runtime (Plain Terminal, `command: "bash"`): any tmux-alive → `running`. There is no `idle` state for plain terminals; the shell IS the runtime.
- Two-tick debounce: a flip to `idle` requires the shell binary to be observed for two consecutive ticks. This eliminates false transitions caused by claude shelling out briefly to `git`, `rg`, `tsc`, etc.

**send_agent_message accepting-states.** `packages/operations/src/agent-messages.ts:45` currently includes `idle` in `acceptingStates` — that worked when `idle` meant "agent paused, ready for input." In the new world `idle` means "shell prompt." Solution: drop `idle` from the cached `acceptingStates` set AND add a send-time check that runs `panePidProcess` and bounces with `session_not_accepting_input` if the foreground is a shell binary. Belt-and-suspenders because the cached status can race with the actual pane state.

**Restart UX.** The cockpit gains a Restart button on `idle` sessions (shell present, no agent running). Clicking it has the daemon call `launchAgentInSession` against the existing pane — no `respawn-pane`, no kill+recreate. The user sees the agent come back in place, above the same scrollback they were just looking at. The Stop button retains its current semantics (kill the tmux session). Ctrl+C inside the embedded terminal kills the agent in-place; the shell prompt returns.

**Auto-resume is unchanged in semantics.** `auto-resume.ts` calls `sendAgentMessage` to type a follow-up prompt ("please continue") into an already-running, rate-limited agent. This plan does NOT change auto-resume to use `launchAgentInSession` — that would kill and relaunch claude, destroying conversation state. Auto-resume's `sendAgentMessage` call site gains the same send-time `panePidProcess` check so it bounces when the agent has actually exited (rather than continuing to type into the shell prompt).

**systemd correctness.**
- `citadel-tmux.service` becomes `Type=simple`, `ExecStart=tmux -L citadel -F`. Foreground tmux. systemd actually tracks the server process. `Restart=on-failure RestartSec=2` fires for the first time on tmux crashes.
- `citadel.service` switches `Requires=citadel-tmux.service` to `Wants=`. Daemon survives tmux restarts; tmux survives daemon restarts.
- `install-systemd.sh` becomes idempotent at the unit-file-content level: hash-compare against the installed unit and only `systemctl restart` when the content changed. Spurious blanket-restarts at install time would trigger the boot-restore cascade we're trying to avoid.

**Boot-restore semantics.** Existing `runBootRestore` (apps/daemon/src/boot-restore.ts) is adapted to the three-step spawn (`ensureTmuxSession` → `launchAgentInSession` → optionally `submitPrompt`). It runs sequentially today (no stagger). The plan retains sequential awaited spawning; with three RPCs per session instead of one (`new-session`, `send-keys`, optional paste) the per-session cost rises modestly. **Perf budget: p95 ≤ 45 s wall time for the full restore of 25 sessions on a developer laptop**, measured via the existing daemon-boot timing log. If exceeded, the implementation must reduce per-step waits before merging.

**Hybrid-session migration.** On the first boot after this PR ships, existing tmux sessions still have wrapper-style panes (`bash -c <wrapper-script>` as PID 1, with claude as a subprocess). Boot-restore detects this (`panePidProcess(session).command` is `bash` AND scrollback at top contains the wrapper's exit-hint sentinel) and migrates them: kill the tmux session, re-spawn shell-first with `launchAgentInSession`. Migration is a one-time cost; subsequent daemon restarts find clean shell-first sessions and reattach without respawn.

**One-time `/tmp/citadel-agent-*` sweep with cross-daemon safety.** On daemon boot, sweep `/tmp/citadel-agent-*.{live,exit}` files older than 1 hour (so a concurrent old daemon's active wrappers aren't disturbed). Write a marker `/tmp/.citadel-sentinel-swept-v1` after a successful sweep; subsequent boots no-op if the marker exists. Count safeguard: bail if > 50,000 candidate files (log and skip).

## Alternatives considered

1. **Status quo + further guardrails** (the PR #35 path extended). Add a tmux server watchdog, sentinel rotation, cgroup memory limits to force-OOM-kill tmux before it SEGVs. **Rejected** because every new failure mode needs a new guardrail. The user's framing — "we overcomplicated this" — is correct.

2. **Agent-as-pane with `remain-on-exit on`** (the architecture I floated earlier). When the agent exits, tmux marks the pane "dead" but keeps the last screen visible, and `respawn-pane` is used to restart. **Rejected** because it preserves the agent ≡ pane lifecycle equivalence that's the actual problem. Killing the agent still kills the pane PID; the wrapper or its equivalent is still needed somewhere.

3. **Shell-first (chosen).** Bash is the pane. Agent is a child. No coupling between agent lifecycle and pane lifecycle. Makes the symptom structurally impossible.

4. **In-process PTY (no tmux at all).** Daemon owns the PTYs directly via `node-pty`. **Rejected** because it would lose tmux's session durability across daemon restarts, require us to re-implement scrollback, reconnect, alt-screen, and key passthrough, and remove operator escape-hatch debugging via `tmux attach`.

## Implementation steps

### 1. Spec updates (first, before code)

- `specs/B.3-agent-sessions-terminal.md` — update item #8 (reserve `failed` for `launch_failed` only; document operator-visible signal loss for crashed agents); update Terminal #9 to drop sentinel-cleanup language.
- `specs/B.7-operations-activity-mcp.md` — update item #8 / operative section #61 with send-time `panePidProcess` check and the positive `runtimeReadyPredicate`.

### 2. Contracts (`packages/contracts/src/index.ts` / extracted module)

- Retain `'failed'` in `AgentSessionStatusSchema` (no value removed — preserves historical rows and the `launch_failed` reducer output).
- Add JSDoc above the schema documenting the new derivation rules (per-runtime, positive match, send-time re-check for input acceptance).
- **Add field `statusReasonAt: z.string().nullable().optional()`** to `AgentSessionSchema`. Drives the 30-minute auto-clear of `idle_after_unexpected_exit` independently of `lastStatusAt` (which is reset by every benign sub-status update like runtime-adapter `waiting_for_input ↔ idle` flips). The reducer sets `statusReasonAt` only when it WRITES a new `statusReason`, not on every status touch.
- **One additive SQLite schema operation** (see §14). This is the only schema delta in the plan.

### 3. Terminal package: lifecycle helpers in a new sibling module

**Create `packages/terminal/src/pane-lifecycle.ts`** (sibling pattern matching `pipe-pane-log.ts`, `submit-prompt.ts`). Houses:
- `launchAgentInSession(sessionName, runtimeBinary, argv: string[]): Promise<void>` — calls `waitForTerminalIdle`, composes the send-keys string as `env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1 <quoted-argv>` (single `env` invocation, byte-for-byte matching the existing wrapper at `packages/terminal/src/index.ts:131`), dispatches via `tmux send-keys -t <session> '<cmd>' Enter`, then `waitForPaneCommand` with the **positive predicate** (`(cmd) => cmd === runtimeBinary.slice(0, 15)`) until the foreground matches.
- `panePidProcess(sessionName): { command: string; pid: number }` — wraps `tmux display-message -p '#{pane_current_command} #{pane_pid}'`. Throws `TmuxSessionMissing` on `has-session` failure.
- `sweepLegacyAgentSentinels(opts: { maxAgeMs?: number; markerPath?: string; safeguardCount?: number }): { scanned: number; removed: number; skipped: 'marker' | 'safeguard' | null }` — sweep with age filter (default 1 hr), marker file (default `/tmp/.citadel-sentinel-swept-v1`), and the 50 k count safeguard.

**Modify `packages/terminal/src/index.ts`:**
- **Delete** `terminalCommand` (the bash-wrapper script generator).
- **Delete** `agentLiveSentinelPath`, `agentExitSentinelPath`, `isAgentLive`, `readAgentExitCode`.
- **Simplify** `ensureTmuxSession` to construct only the shell-as-PID-1 pane. Drop the `command`/`args` parameters from its signature (agent argv no longer flows through here).
- **Update** `ensureTmuxSessionRaw` (background run path) — this still needs to run a hook command to exit. Keep it as a separate, narrower helper that DOES exec the command as the pane process; the rationale is that hook commands ARE expected to exit and don't need a long-lived shell. Document the divergence in a code comment.
- Re-export the new helpers from `pane-lifecycle.ts`.

### 4. Operations: `createAgentSession` + the three-step composition

- `packages/operations/src/create-agent-session.ts`: compose `ensureTmuxSession` → `launchAgentInSession(name, runtime.command, [...runtime.args, ...resumeArg, ...promptArg])` → `submitPrompt(name, initialPrompt, …)` only when the caller supplied an `initialPrompt`.
- Add a small `runtimeBinaryFor(runtimeId, config)` helper (also used by status-monitor) that returns the runtime's `command` from config. Lives in the operations package or a shared util.

### 5. Operations: status-monitor tick body

**Target `packages/operations/src/status-monitor.ts`** (not just the daemon wiring):
- Remove `readSentinels: () => Promise<Map<string, SentinelReading>>` from `MonitorTickDeps`. Remove the `SentinelReading` type.
- Add `panePidProcess: (sessionName: string) => { command: string; pid: number } | null` to `MonitorTickDeps` (null on session missing).
- Add `runtimeBinaryFor: (runtimeId: string) => string | null` to `MonitorTickDeps` for the per-runtime status derivation.
- Rewrite the tick body:
  - For each session: `pane = panePidProcess(s.tmuxSessionName)`. If `null` → emit `signal: 'tmux_missing'`; reducer → `unknown` (NEVER `stopped`).
  - Otherwise: derive bedrock status per the per-runtime rules in §Implementation approach. Two-tick debounce on `running → idle` transitions.
  - **`running → idle` labeling.** When the transition fires and the session has no recorded user-initiated termination in the last 5 seconds (a small `recentUserAction: Map<sessionId, timestamp>` held in the status-monitor's existing in-memory state), label the transition `statusReason: 'idle_after_unexpected_exit'` and write `statusReasonAt = new Date().toISOString()`. **If a user action IS recent, clear both fields: `statusReason: null, statusReasonAt: null` (no label). The previously-considered `'idle_user_action'` reason is intentionally dropped — no UI predicate consumed it and `null` is the simpler signal.** On the next tick (and subsequent ticks), if `statusReason === 'idle_after_unexpected_exit'` AND `(Date.now() - new Date(statusReasonAt).valueOf()) > 30 * 60 * 1000`, clear to plain `idle` (null statusReason, null statusReasonAt). On operator Restart, the explicit endpoint clears statusReason as part of writing the `running` transition.

  - **Auto-clear runs in the same tick body.** The implementer must confirm that `runStatusMonitorTick`'s candidate-session selection (the "non-terminal candidate sessions" filter at `packages/operations/src/status-monitor.ts:27`) includes `idle` sessions — they should, because `idle` is not in the terminal-status set, but the implementer should verify and add an explicit re-include condition if needed. Cross-boot scenario: session has `statusReason='idle_after_unexpected_exit'` and `statusReasonAt` > 30 min in the past, daemon boots fresh (empty in-memory `recentUserAction` map; `statusReasonAt` survives on the DB row), first post-boot tick must auto-clear to plain `idle`. Pinned by a regression test.

  - **`recentUserAction` write sites.** Intentionally NARROW — only two paths actually need this map; everything else is no-op because the session row is deleted before the next tick. Both paths must `recentUserAction.set(sessionId, Date.now())` BEFORE performing the mutation:
    1. **`POST /api/agent-sessions/:sessionId/restart` (§8).** Restart kills the agent's foreground process (which today doesn't happen automatically — see §8 defensive 409 check) AND/OR runs `launchAgentInSession` on an already-idle pane. In either case the operator's intent is recorded as a recent user action so that any subsequent `running → idle` tick clears `statusReason` instead of labeling it unexpected.
    2. **`POST /api/agent-sessions/:sessionId/user-action` with body `{ reason: 'ctrl_c' }`.** New tiny endpoint added in §8. The trigger is **the terminal-key-shim already injected into ttyd's iframe page** (`apps/daemon/src/terminal-key-shim.client.js`, wired via `apps/daemon/src/terminal-key-shim.ts:injectKeyShim`). The shim already runs in the iframe before ttyd's bundle, already wraps `window.WebSocket`, already registers a capture-phase `document.addEventListener('keydown', ...)`. Adding the user-action POST is ~10 LOC inside its existing `onKeydown`: when `event.ctrlKey && key === 'c' && !event.shiftKey && !event.altKey && !event.metaKey`, fire `fetch('/api/agent-sessions/<sessionId>/user-action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{\"reason\":\"ctrl_c\"}' }).catch(() => {})`. Derive `<sessionId>` from `location.pathname` (the iframe loads from `/terminals/<sessionId>/` — same shape as the proxy's basePath at `packages/terminal/src/ttyd.ts:147`). **Critical: do NOT call `consume(event)` for Ctrl+C** — let the event propagate normally so xterm sends 0x03 over the WebSocket as today. The POST runs in parallel with the native keystroke delivery, not in place of it. The React cockpit (`apps/web/src/`) has no role here because the xterm.js instance lives inside the iframe served by ttyd; the React app only renders an `<iframe src={ttyd-url}>`.

  - **Not in the enumeration (and why).** Stop endpoint (`DELETE /api/agent-sessions/:sessionId`), MCP `stop_agent_session`, MCP `start_agent_session` (creates a fresh session with a new ID — does NOT kill+recreate; verified at `apps/daemon/src/daemon-mcp-tool.ts:99-113` and `packages/operations/src/create-agent-session.ts:51`), and `absorbEmptyCandidateSessions` in restore-routes all delete the session row synchronously. The next monitor tick sees no candidate, so no `running → idle` transition can fire. These paths intentionally do NOT write `recentUserAction`. The narrow enumeration is the correct invariant.

  - **Window-size calibration.** 5 seconds is chosen to cover typical xterm-keystroke-to-daemon-POST latency (50-200ms in normal operation, up to ~1s under daemon backpressure) PLUS one status-monitor tick interval (2s) PLUS headroom. Larger windows risk mis-labeling unrelated user actions; smaller windows risk false `idle_after_unexpected_exit` labels on slow networks. The constant lives in `packages/operations/src/status-monitor.ts` as `RECENT_USER_ACTION_MS = 5_000` for future tuning.

  - **`recentUserAction` lifecycle.** In-memory only; lost on daemon restart. This is acceptable because the 5-second window is shorter than any restart, AND because a daemon restart is itself a "user/operator action" that we don't want to mis-label sessions for — boot-restore's spawn re-establishes `running` cleanly. Document this in the helper's JSDoc.
  - Continue invoking the runtime adapter's `analyzePaneText` for derived statuses (unchanged).
- Remove `StatusSignal: 'exited_clean' | 'exited_failed'` emissions from the tick. Keep the reducer accepting them for now (dead code path — schedule removal in a follow-up to keep this PR scoped) so no test fixtures break.
- **Preserve `launch_failed` reducer path.** `launch_failed` is emitted by `createAgentSession` when `tmux new-session` itself errors before the pane is alive. The reducer continues to turn that into `status: 'failed'`. Pinned by an explicit test (see Tests §).

**Daemon wiring** (`apps/daemon/src/status-monitor-wiring.ts`):
- Pass the new dep functions (`panePidProcess`, `runtimeBinaryFor`) wired to the real implementations.
- Remove `readSentinels` wire-up.

### 6. Operations: `reconcileStore` (the second mass-flip path — surfaced by reviewer)

**Target `packages/operations/src/helpers.ts:reconcileStore`**:
- Remove the `if (!isAgentLive(...)) updateSessionStatus({ status: 'stopped', statusReason: 'exit_code_0' })` branch.
- Replace with: query `panePidProcess(s.tmuxSessionName)`. If session missing → mark `unknown` (`statusReason: 'tmux_missing'`); if foreground is a shell binary → mark `idle`; if foreground is the runtime binary → preserve existing `running`-class status (let the status-monitor tick handle nuanced status).
- Tests in `packages/operations/src/helpers.test.ts` (or sibling) updated: the regression-pin scenario — "reconcileStore with all sessions whose tmux is alive but no `.live` sentinel exists" — must assert status preserved (not flipped to `stopped`).

### 7. send_agent_message accepting-states + send-time check

**Target `packages/operations/src/agent-messages.ts`**:
- Drop `'idle'` from `acceptingStates`.
- Before paste, call `deps.panePidProcess(session.tmuxSessionName)`. If the foreground is a shell binary, return `{ ok: false, error: 'session_not_accepting_input', detail: 'agent_not_running' }`.
- Unit test: cached DB status `running` but live pane shows `bash` → returns `session_not_accepting_input`.

### 8. Daemon: restart endpoint

**New `POST /api/agent-sessions/:sessionId/restart`** in `apps/daemon/src/terminal-routes.ts`:
- Records `recentUserAction.set(sessionId, Date.now())` BEFORE any mutation.
- **Defensive check:** call `panePidProcess(sessionName)`. If the foreground command IS the runtime binary already (agent is running, stale UI or race), return `409 agent_already_running` and do NOT touch the pane. Without this guard, `launchAgentInSession` would type `env … claude …` INTO the live claude TUI, sending it as a user message.
- Resolves session + runtime → composes argv (with `--resume <uuid>` when `runtimeSessionId` present) → calls `ensureTmuxSession` (idempotent — no-op if alive) → `launchAgentInSession`.
- Explicitly clears `statusReason` and `statusReasonAt` on the session row as part of the transition (the next tick will see foreground=agent and label `running`, but clearing here avoids a one-tick stale `idle_after_unexpected_exit` label).
- 202 + emits `agent.updated` event.

**New `POST /api/agent-sessions/:sessionId/user-action`** in `apps/daemon/src/terminal-routes.ts`:
- Request body: `{ reason: 'ctrl_c' | 'stop' | 'restart' | <other> }` (extensible; only `ctrl_c` is consumed initially).
- Records `recentUserAction.set(sessionId, Date.now())`. Returns 204.
- **No rate-limit needed.** The write is in-memory `Map.set` — O(1), no DB, no I/O. A Ctrl+C-spamming operator could hit it 10+/sec for a few seconds; that's still cheap. Comment in the endpoint code documents this so a future reviewer doesn't add a throttle.
- This is the BLOCKER-1 fix from round 4. The terminal-key-shim (running inside ttyd's iframe) issues this POST in parallel with letting Ctrl+C propagate to ttyd as today. Fire-and-forget — the shim does NOT block keystroke delivery on the POST response.

**`respawnTmux` in `apps/daemon/src/app.ts:148-154`** (reviewer-found): update to the same three-step composition. Today it calls the old `ensureTmuxSession({...command, args})` form, which after this PR no longer accepts a command. Without this update, operator reconnect-after-tmux-gone would create a shell but never launch the agent.

### 9. Daemon: auto-resume unchanged in shape (clarification)

`apps/daemon/src/auto-resume-wiring.ts` continues to call `operations.sendAgentMessage`. No change. The send-time `panePidProcess` check from §7 makes auto-resume safe when the agent has actually exited (returns `session_not_accepting_input` and the auto-resume loop logs + backs off rather than typing into a shell prompt).

### 10. Daemon: boot-restore + hybrid migration

**`apps/daemon/src/boot-restore.ts`:**
- Restored sessions go through the three-step path: `ensureTmuxSession` (shell) → `launchAgentInSession` (`claude --resume <uuid>`) → (no initial prompt during restore — that was the original session's launch concern).
- The recency window (24h), sequential spawn, status-emission remain. (No "5-min stagger" — that was a phantom in the prior draft.)
- **Hybrid-session migration:** before the spawn loop, detect existing sessions whose pane is a wrapper invocation. Primary detection: read `/proc/<pane_pid>/cmdline` and split on `\0`; the wrapper's invocation matches when argv[0] is `bash` AND argv[1] is `-c` (the current `terminalCommand` always invokes `bash -c <script>`, verified at `packages/terminal/src/index.ts:158`). **On any IO error reading `/proc/<pid>/cmdline` (ENOENT — wrapper exited between `tmux display-message` and the read; EACCES — privilege change; ENOTDIR — `/proc` not mounted, common in some test containers), treat as "not wrapper" and fall through to the scrollback fallback. Never throw out of the detection path; boot-restore must not bail because of a transient `/proc` read failure.** **PID-reuse guard:** after reading cmdline, re-fetch `tmux display-message -p '#{pane_pid}'`. If the PID changed between the two reads (the original wrapper process exited and the kernel reused the PID for an unrelated process), discard the cmdline read and fall through to the scrollback fallback. This guards against the silent-miss case where a reused PID's cmdline (`firefox\0`, `sshd\0`, etc.) doesn't match `bash -c` and we'd otherwise skip a wrapper session that should have been migrated. Secondary fallback for already-exited wrapper sessions: scrollback contains the wrapper's exit-hint string `[citadel] Agent exited.`. For each matching session, `tmux kill-session -t <name>` then proceed with the normal restore. **Log a structured activity event** with `type: 'agent.migrated.hybrid'`, `source: 'daemon'`, `message: 'Migrated wrapper-style session to shell-first'`, linked to the affected workspaceId. The boot-restore hybrid-migration test asserts this event is recorded.
- Perf assertion: log total restore wall time. CI smoke fails if total > 45 s for 25 sessions (test-only threshold; production budget).

### 11. Daemon: one-time sentinel sweep

`sweepLegacyAgentSentinels` (defined in §3) wired into the daemon startup. Single-shot per process. Age filter (default 1 hr) protects against cross-daemon races. Marker file (`/tmp/.citadel-sentinel-swept-v1`) makes subsequent boots no-ops. Bounded by 50 k safeguard.

### 12. Cockpit UI

- `apps/web/src/...`: Restart button on `idle` sessions (POST `/api/agent-sessions/:sessionId/restart`). Optimistic UI flips to `starting`; next SSE flips to `running`.
- **xterm Ctrl+C interceptor: lives in the iframe-injected shim, NOT the React app.** The cockpit React app only renders `<iframe src={ttyd-url}>`; the xterm.js instance and WebSocket live inside the iframe as part of ttyd's bundled page. The hook point is the existing `apps/daemon/src/terminal-key-shim.client.js`, injected by `apps/daemon/src/terminal-key-shim.ts:injectKeyShim`. In the shim's existing `onKeydown` handler: when `event.ctrlKey && event.key === 'c' && !event.shiftKey && !event.altKey && !event.metaKey`, issue `fetch('/api/agent-sessions/<sessionId>/user-action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reason":"ctrl_c"}' }).catch(() => {})` and **do not call `consume(event)`** — Ctrl+C must continue propagating to xterm so 0x03 reaches the PTY as today. Derive `<sessionId>` from `location.pathname` (the iframe loads from `/terminals/<sessionId>/`). Failure of the POST is silently swallowed (the worst case is a single mis-labeled `idle_after_unexpected_exit`, which auto-clears in 30 min). Apart from this addition, the React app needs no changes for the Ctrl+C signal capture.
- Stop button retains current semantics (kill tmux session). Ctrl+C inside the embedded terminal kills the agent in-pane (no UI change needed; xterm already routes Ctrl+C).
- Status pill: `failed` rendering is preserved (historical rows still surface it correctly). The pill for `idle` with `statusReason: 'idle_after_unexpected_exit'` renders with the attention tone (red pulse) so a crashed agent is still operator-visible.
- `deriveWorkspaceAgentTone` (`apps/web/src/workspace-card.tsx`): **needs change**. Today (verified `packages/core/src/index.ts:21-26`) `sessionNeedsAttention` returns true ONLY for `status === 'failed'` OR `status === 'unknown'` with specific reasons (`tmux_missing`, `sentinel_missing_tmux_alive`, `migrated_from_orphaned`). After this PR a crashed agent shows `idle` — without an attention extension it would surface as green/idle, silently losing the "your agent died" signal. **Extend `sessionNeedsAttention`** to also return true for `status === 'idle' && statusReason === 'idle_after_unexpected_exit'`. Add `'idle_after_unexpected_exit'` to whatever attention-reason set the function uses. Add a unit test in the same file (or its existing test). The cockpit's status-pill renderer maps the same predicate to the red pulse, so no separate UI change is needed.

### 13. systemd units (`scripts/install-systemd.sh` + the two unit files)

- `citadel-tmux.service`: `Type=simple`. `ExecStart=/home/linuxbrew/.linuxbrew/bin/tmux -L citadel -F`. `Restart=on-failure RestartSec=2`. Remove `RemainAfterExit=yes` and the keepalive `new-session 'sleep infinity'`.
- `citadel.service`: `Requires=citadel-tmux.service` → `Wants=citadel-tmux.service`. Keep `After=citadel-tmux.service`.
- `install-systemd.sh`: hash-compare the rendered unit content against the installed file (`systemd-analyze cat-config` or `diff`); only restart that unit if the content changed. Same idempotency for both units.
- **Reaper compatibility (PR #35):** the orphan-client reaper reads `tmux list-clients` — server-state, not unit-state. `Type=simple` doesn't affect it; reaper continues to work unchanged.

### 14. Migration strategy (one additive schema change)

**Schema operation:** `ALTER TABLE agent_sessions ADD COLUMN status_reason_at TEXT` (nullable, no default — new rows + historical rows both start as NULL; reducer writes the ISO timestamp when it sets a new `statusReason`).

**Classification:** Additive. Safe for already-deployed operator databases. Existing rows get NULL for the new column; existing reads tolerate the missing/null value.

**`schema_migrations` row:** declare `(<next version>, 'add_status_reason_at_column', <now>)`. Implementer reads the current max version from `packages/db/src/index.ts` and increments. Wrapped in a single transaction with the `ALTER TABLE`.

**`PRAGMA foreign_keys = ON;`:** unchanged. No FK constraint added.

**Operator data implications:** every existing install runs the schema on startup; the `ADD COLUMN` is a no-op once applied, idempotent across restarts via `schema_migrations` gate. Status display for rows with `status_reason_at = NULL` is unaffected (the auto-clear logic only fires when both `statusReason === 'idle_after_unexpected_exit'` AND `statusReasonAt !== null` — historical rows never had that statusReason, so no auto-clear opportunity exists).

`AgentSessionStatusSchema` itself is unchanged (we retain `failed` for historical rows + `launch_failed` reducer output).

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|---|---|---|
| Unit (Vitest) | **Required** | New tests in `packages/terminal/src/`, `packages/operations/src/`, `apps/daemon/src/`. Cover the new lifecycle helpers, the rewritten status-monitor tick body, the reconcileStore rewrite, the send_agent_message send-time check, and the absence of sentinel writes during session creation. Three regression-pin scenarios for the mass-flip invariant. |
| E2E (Playwright) | **Required** | New `e2e/shell-first-lifecycle.spec.ts` covering user-visible journey + a regression spec for "tmux crash doesn't blank the cockpit." |

No separate integration layer (per the Citadel extension).

### Three regression-pin scenarios (the headline invariant — "tmux failure must not mass-flip sessions to stopped")

All three live in `packages/operations/src/status-monitor.test.ts` (or extend the existing file):

1. **Status-monitor tick with `panePidProcess` throwing tmux-missing for all sessions** — assert every session DB row transitions to `unknown` (with `statusReason: 'tmux_missing'`). NEVER `stopped`. NEVER `failed`.
2. **Status-monitor tick where legacy `.live` / `.exit` files exist on disk for all sessions** — assert the tick ignores them (does NOT call `readSentinels`, which doesn't exist anymore in `MonitorTickDeps`). Status preserved from previous tick.
3. **Boot-time `reconcileStore` call with sessions whose tmux is alive but no `.live` sentinel exists on disk** — assert status preserved (not flipped to `stopped`). This pins the BLOCKER 1 fix.

### Other new tests to add

**Unit (`packages/terminal/src/`):**
- `pane-lifecycle.test.ts` (new):
  - `launchAgentInSession sends the agent argv via send-keys with full color-env prefix as a single env -u NO_COLOR invocation (TERM=xterm-256color, COLORTERM=truecolor, FORCE_COLOR=1, CLICOLOR_FORCE=1)`. Assert the literal `env -u NO_COLOR ` prefix and all four KEY=VALUE assignments present in the captured send-keys string (byte-for-byte match with the existing wrapper's env line).
  - `launchAgentInSession waitForPaneCommand uses POSITIVE predicate (matches runtime binary, NOT 'not a shell')`.
  - `launchAgentInSession handles 15-char comm truncation (long binary names match correctly)`.
  - `panePidProcess parses tmux output into { command, pid }; throws TmuxSessionMissing on has-session failure`.
- `pane-lifecycle.test.ts` (sweep — same file or sibling):
  - `sweepLegacyAgentSentinels removes files older than maxAgeMs; keeps fresh ones (cross-daemon-race safety)`.
  - `sweepLegacyAgentSentinels is a no-op when the marker file exists`.
  - `sweepLegacyAgentSentinels bails when count exceeds safeguard`.
- `index.test.ts` (extend):
  - `ensureTmuxSession creates a durable session whose pane PID is bash -l (no longer accepts command/args)`.
  - `does not write any /tmp/citadel-agent-* files during full create + launch + Ctrl+C cycle`.

**Unit (`packages/operations/src/`):**
- `status-monitor.test.ts` (extend with the 3 regression-pin scenarios above, plus):
  - `derives running when pane_current_command matches the session's runtimeBinary (positive)`.
  - `derives idle when pane_current_command is a shell binary AND runtimeId is not 'shell'`.
  - `derives running for shell runtime regardless of pane_current_command (any tmux-alive)`.
  - `two-tick debounce: single-tick flip-to-bash does not flip status to idle`.
  - `running → idle WITHOUT recent user action labels statusReason='idle_after_unexpected_exit' AND writes statusReasonAt`.
  - `running → idle WITH recent user action (Restart endpoint or user-action POST in last 5s) clears statusReason/statusReasonAt to null (no label)`.
  - `POST /api/agent-sessions/:sessionId/user-action with reason=ctrl_c records recentUserAction; subsequent running → idle is NOT mis-labeled as unexpected`. Placed in the daemon's terminal-routes test file.
  - `terminal-key-shim Ctrl+C handler issues the user-action POST and does NOT consume the event (0x03 still reaches the PTY)` — placed in `apps/daemon/src/terminal-key-shim.test.ts` (or a sibling test file colocated with the shim). NOT in `apps/web/src/` — the shim runs in the iframe, not in the React app.
  - `POST /api/agent-sessions/:sessionId/restart returns 409 agent_already_running when panePidProcess shows the runtime binary as foreground (defensive guard against typing the launch command into a live TUI)`.
  - `idle_after_unexpected_exit auto-clears to plain idle after 30 min as measured by statusReasonAt (NOT lastStatusAt) — sub-status updates that touch lastStatusAt do not reset the 30-min clock`.
  - `operator Restart explicitly clears statusReason / statusReasonAt as part of the running transition`.
  - `launch_failed signal still produces status='failed'` — pins that the §5 cleanup didn't trim the reducer branch.
- `helpers.test.ts` (extend):
  - `reconcileStore does NOT mass-flip sessions to stopped when sentinels are absent`. — pins BLOCKER 1.
- `agent-messages.test.ts` (extend):
  - `sendAgentMessage returns session_not_accepting_input when live pane shows shell (even if DB status is running)`. — pins BLOCKER 3.
- `create-agent-session.test.ts` (extend):
  - `composes ensureTmuxSession → launchAgentInSession → submitPrompt only when initialPrompt is provided`.

**Unit (`apps/daemon/src/`):**
- `terminal-routes.test.ts` (extend or app.test.ts):
  - `POST /api/agent-sessions/:id/restart calls launchAgentInSession with the runtime's argv`.
  - `POST /api/agent-sessions/:id/restart with --resume includes runtimeSessionId in argv`.
  - `POST /api/agent-sessions/:id/restart returns 404 for unknown sessions`.
- `boot-restore.test.ts` (extend):
  - `restored sessions go through three-step spawn (ensureTmuxSession → launchAgentInSession)`.
  - `hybrid migration: existing wrapper-style sessions detected via /proc cmdline ('bash -c') are killed and re-spawned shell-first`.
  - `hybrid migration falls back to scrollback exit-hint when /proc detection fails (e.g., agent has already exited and bash has reaped the wrapper)`.
  - `hybrid migration swallows ENOENT / EACCES / ENOTDIR from /proc read and falls through to scrollback fallback (does NOT throw)`.
  - `hybrid migration handles PID-reuse race: cmdline read for old PID returns wrong process, but second pane_pid fetch mismatches → fall through to scrollback fallback (does NOT silently skip the wrapper session)`.
  - `perf assertion: 25-session restore completes within 45s wall time (test threshold)`.
- `app.test.ts` (extend):
  - `respawnTmux uses the three-step composition (not the old single-step ensureTmuxSession with command)`.
  - `CITADEL_DISABLE_TERMINAL_REAPER=1 still disables the reaper (PR #35 invariant preserved)`.

**E2E (`e2e/`):**
- `shell-first-lifecycle.spec.ts` (new):
  - `start a claude agent, observe running, Ctrl+C, observe shell prompt, click Restart, observe claude back`.
  - `kill the tmux server mid-test, observe sessions transition to unknown (NOT stopped), wait for systemd restart, observe sessions reattach without mass-flip`. — this is the **headline regression-pin in user-visible form**.

### Existing tests to update

- `apps/daemon/src/boot-restore.test.ts` — current assertions about the one-step `claude --resume` spawn become three-step. Update fixtures.
- `packages/operations/src/status-monitor.test.ts` — remove all sentinel-file-based test setup; switch to `panePidProcess` stubs (matches the new `MonitorTickDeps` shape).
- `packages/operations/src/helpers.test.ts` — `reconcileStore` test fixtures dropping `isAgentLive` stubs.
- `packages/operations/src/agent-messages.test.ts` — drop `idle` from "expected accepting states" fixtures.
- `packages/terminal/src/index.test.ts` — the `pane survives the agent exiting and drops back into a usable shell` test changes shape (pane survives because shell IS the pane, not because of `exec ${SHELL}`).
- `apps/daemon/src/app-terminal-reaper-wiring.test.ts` (added in PR #35) — confirm the reaper wiring still passes unchanged.
- `packages/core/src/index.test.ts` (or the existing test file for `sessionNeedsAttention`) — add: positive case `sessionNeedsAttention({ status: 'idle', statusReason: 'idle_after_unexpected_exit' })` returns `true`; negative case `sessionNeedsAttention({ status: 'idle', statusReason: null })` returns `false` (this is the "recent user action cleared the label" case). Also extend existing attention cases (`tmux_missing`, `sentinel_missing_tmux_alive`, `migrated_from_orphaned`) to still pass.

### Terminal-completeness gate coverage

Per the gate, explicit tests for each dimension:

| Dimension | Coverage |
|---|---|
| Raw input | Existing `bridges tmux sessions over WebSocket input/output/resize messages` (index.test.ts) — verify it still passes after the shell-first change. |
| Control sequences | `Ctrl+C` (E2E + agent-messages unit), `Ctrl+D` at shell prompt — new test asserting it does NOT kill the pane (per adversarial #2 in prior draft, now explicit), `Ctrl+Z` (suspend) — new unit test asserting agent suspends as bash child, pane survives. |
| Paste (bracketed) | Existing `pasteText` / `submitPrompt` tests verify bracketed-paste; ensure they still pass with shell-as-PID-1. Add: **large paste (>10 KB)** via `submitPrompt` to verify no chunking regression. |
| Resize | Existing resize tests in `index.test.ts` — verify SIGWINCH propagation when shell is foreground (no agent running) vs agent is foreground. New test asserts pane size matches request in both states. |
| Long output | Covered by the `history-limit 5000` cap from PR #35 plus the existing `captureTmux` tests. |
| Alternate screen | Existing `captures active alternate-screen output when an interactive program switches screens` — verify it still passes. New test: alt-screen TUI exits, returns to shell, pane displays the agent's last alt-screen contents (not just a fresh shell prompt). |
| Reconnect | Existing `keeps WebSocket output isolated across sessions and supports reconnect scrollback` — verify it still passes. New test: `respawnTmux` reconnect uses the three-step composition. |
| Cross-session isolation | Existing isolation test in `index.test.ts` — verify still passing. New test: status-monitor's `panePidProcess` calls are correctly scoped per session (no cross-talk). |

### Adversarial analysis

- **How could this fail in production?**
  - (a) `pane_current_command` race during agent subprocess execution (`git`, `rg`, etc.) — mitigated by two-tick debounce, regression-tested.
  - (b) Positive-predicate false negative if a custom runtime's binary name truncates strangely under Linux's 15-char `comm` limit — mitigated by `comm.slice(0, 15)` matching, explicitly tested for long binary names.
  - (c) Cross-daemon sentinel-sweep race during install — mitigated by age filter (1 hr) and marker file.
  - (d) `reconcileStore` regression — pinned by dedicated test.
  - (e) Auto-resume firing `launchAgentInSession` instead of `sendAgentMessage` would relaunch claude on every rate-limit recovery — pinned by §9 clarification + auto-resume test still asserting `sendAgentMessage` call.
- **What user actions trigger unexpected behavior?**
  - User types `exit` at the shell prompt → DOES kill the pane → tmux session ends → daemon detects → status becomes `unknown`. UI shows `stopped` after the next reconcile. Test the path explicitly.
  - User runs `claude` themselves at the shell prompt (bypassing the cockpit) → status-monitor sees `claude` as foreground → flips to `running` even though the user-initiated claude has no `runtimeSessionId`. Acceptable; document.
- **What existing behavior could break?**
  - `failed` status pill: historical rows show `failed`; new sessions never emit `failed` after `exited_failed`. Acceptable signal loss; documented in B.3.
  - Initial prompt sequencing: tested with the four-step composition (shell idle → send agent cmd → wait positive predicate → paste initial via `submitPrompt`).
  - Operator-typed `exit` at shell → pane dies → session ends. Same as today's "stop" semantics.
- **Which tests credibly catch those failures?**
  - The three regression-pin scenarios pin the mass-flip invariant.
  - The E2E "tmux crash mid-test" pins the user-visible journey.
  - The auto-resume unit test pins the "auto-resume must still call sendAgentMessage" invariant.
  - The perf assertion pins the boot-restore budget.
- **What gaps remain?**
  - Cross-daemon sentinel-sweep is age-based — a worktree dev daemon spawning a fresh wrapper-style session within the 1-hr window would have its sentinels swept. Documented as an accepted limitation (worktree dev daemons should not run wrapper-style code after this PR ships; if they do, the sweep's age filter is the safety net).
  - Hybrid-migration detection looks for the exit-hint string in scrollback — a session that scrolled past the hint won't be detected as wrapper-style and will be reattached as-is. Acceptable: such sessions still work (the wrapper's `exec ${SHELL}` keeps the pane alive); they just won't be migrated to clean shell-first until restarted.

## Tests

Files to create / modify (TDD order — tests first):

1. `packages/terminal/src/pane-lifecycle.test.ts` (new) — lifecycle helpers + sweep.
2. `packages/operations/src/status-monitor.test.ts` (extend) — three regression-pin scenarios + new positive-predicate cases + two-tick debounce.
3. `packages/operations/src/helpers.test.ts` (extend) — `reconcileStore` regression-pin.
4. `packages/operations/src/agent-messages.test.ts` (extend) — send-time `panePidProcess` check.
5. `packages/operations/src/create-agent-session.test.ts` (extend) — three-step composition.
6. `packages/terminal/src/index.test.ts` (extend) — ensureTmuxSession signature change, no-sentinel-writes assertion, terminal-completeness additions.
7. `apps/daemon/src/boot-restore.test.ts` (extend) — three-step spawn, hybrid migration, perf assertion.
8. `apps/daemon/src/terminal-routes.test.ts` (extend) — restart endpoint.
9. `apps/daemon/src/app.test.ts` (extend) — respawnTmux composition.
10. `e2e/shell-first-lifecycle.spec.ts` (new) — full user journey + tmux-crash invariant.

## Schema or contract generation

No artifact regeneration. `@citadel/contracts` IS the source for typed cross-package contracts; the JSDoc update + `statusReasonAt` field flow through `pnpm typecheck` to consumers. The one SQLite schema change (§14) is hand-written inline DDL with a `schema_migrations` row, per the repo's existing migration pattern in `packages/db/src/index.ts`.

## Verification

Before opening the PR, run:

- `make check` — full local gate (`check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage`, `check:deps`, `build`).
- `make e2e` — Playwright; required because we add a new spec and modify a user journey.
- `make smoke` — daemon HTTP smoke; required because we change `send_agent_message` accepting-states, add the restart endpoint, and modify auto-resume's send-time check.
- Manual: `make install`, confirm the unit-file hash-diff suppresses unnecessary restarts. Then `systemctl --user kill citadel-tmux.service` — confirm systemd brings it back within 2-3 seconds, confirm the daemon detects tmux-gone and re-spawns sessions, confirm no DB row was flipped to `stopped` (query via `mcp__citadel__list_agent_sessions`).
