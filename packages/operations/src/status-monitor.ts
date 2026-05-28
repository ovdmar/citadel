import type { AgentSession } from "@citadel/contracts";
import type {
  ObservationContext,
  PaneObservationResult,
  RuntimeStatusAdapter,
  SessionAdapterState,
} from "@citadel/runtimes";
import {
  IDLE_AFTER_UNEXPECTED_EXIT_AUTO_CLEAR_MS,
  REASON_IDLE_AFTER_UNEXPECTED_EXIT,
  RECENT_USER_ACTION_MS,
  type ReducerPrev,
  type StatusSignal,
  type StatusUpdate,
  reduceStatus,
} from "./agent-status.js";
import { startGuardedInterval } from "./guarded-interval.js";

// Per-session bookkeeping that the monitor maintains across ticks. The
// adapter has its own SessionAdapterState (for runtime-specific internals);
// the monitor owns activity-change tracking + the two-tick debounce for
// running → idle transitions (avoids false flips when claude shells out to
// git/rg briefly).
export interface MonitorSessionState {
  lastActivityMs: number | null;
  ticksSinceActivityChange: number;
  hasObservedSinceBoot: boolean;
  // Number of consecutive ticks observing a shell foreground for an agent
  // runtime that was previously `running`. The transition fires when this
  // reaches 2 (debounce).
  consecutiveShellTicks: number;
  // Number of consecutive ticks where every available probe reported "no
  // pane" for this tmux session. The `tmux_missing` signal only fires when
  // this reaches TMUX_MISSING_DEBOUNCE_TICKS (3). Resets to 0 on ANY
  // confirmed-alive observation (batched pane, per-session probe, or
  // has-session). User-visible invariant: a single 50ms tmux hiccup must
  // never flip a session to `unknown` — durable absence over multiple
  // 2-second ticks is what counts as "really gone".
  consecutiveMissingTicks: number;
}

// Foreground commands that signal "pane is at a shell prompt, not running
// the agent". When the foreground transitions from the agent binary to one
// of these, the status flips to `idle`.
const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "fish", "dash"]);
const RUNNING_TO_IDLE_DEBOUNCE_TICKS = 2;
const CODEX_OPTIMISTIC_SEND_IDLE_SUPPRESS_MS = 10_000;
const CODEX_REASON_STABLE_TIMEOUT = "pane:codex:stable_timeout";
// At 2s/tick this gives ~6 seconds of "every probe is missing" before we
// concede the session is gone. Anything below that is dominated by transient
// tmux load — the journal already shows `[status-monitor] panes failed`
// surfacing under sustained list-panes pressure.
const TMUX_MISSING_DEBOUNCE_TICKS = 3;

// Dependencies the tick needs. All I/O is dependency-injected so the tick
// can be tested without real tmux/fs/store. The real daemon wires real
// implementations in apps/daemon/src/app.ts.
export interface MonitorTickDeps {
  now: () => string;
  listSessions: () => AgentSession[];
  listWorkspaceIds: () => Set<string>;
  updateSession: (sessionId: string, update: StatusUpdate) => void;
  deleteSession: (sessionId: string) => void;
  emit: (event: string, payload: unknown) => void;
  tmuxActivities: () => Map<string, number>;
  paneCapture: (tmuxSessionName: string) => string;
  // Shell-first lifecycle hook: foreground command of the pane (the
  // runtime binary when the agent is running, a shell when it isn't, null
  // when tmux is unreachable). Replaces the legacy `readSentinels` —
  // tmux-native, no /tmp sentinels needed.
  //
  // When `panes` is provided, the tick MUST prefer it over `panePidProcess`
  // — a single batched `tmux list-panes -a` per tick costs one fork instead
  // of N (saw ~270ms of event-loop blocking with 27 sessions before this).
  // `panePidProcess` is retained for legacy callers/tests that don't wire
  // the batched provider.
  panePidProcess: (tmuxSessionName: string) => { command: string; pid: number } | null;
  panes?: () => Map<string, { command: string; pid: number }>;
  // Authoritative single-session probe used as the second opinion before
  // flipping a row to `tmux_missing`. Defaults in the wiring to
  // `tmuxSessionExists` (one `tmux has-session -t <name>` call). Tests can
  // stub. Mandatory now that the batched `panes()` and per-session
  // `panePidProcess()` both silently swallow tmux IO errors as "no pane" —
  // without this double-check, a single failed `tmux list-panes` would mass-
  // flip every session to `unknown` (the 05:49 incident).
  hasTmuxSession?: (tmuxSessionName: string) => boolean;
  // Optional structured-event sink for the diagnostics bundle. Same shape
  // as @citadel/operations DiagnosticsLogger; declared structurally here to
  // keep status-monitor free of an external dep.
  diagnostics?: { log(category: string, event: string, data?: Record<string, unknown>): void };
  // Map runtimeId → binary name expected as the pane's foreground when the
  // agent is running. Null when the runtime is unknown.
  runtimeBinaryFor: (runtimeId: string) => string | null;
  // Optional runtime-native session id repair. Codex cannot be launched with
  // a caller-chosen id, so the daemon discovers it after spawn. If that first
  // discovery misses, the monitor can repair live rows from exact process
  // evidence (for example the Codex process's open rollout file).
  recoverRuntimeSessionId?: (session: AgentSession, pane: { command: string; pid: number } | null) => string | null;
  setRuntimeSessionId?: (sessionId: string, runtimeSessionId: string) => void;
  // Map of sessionId → Date.now() timestamp of the most recent operator-
  // initiated termination (Restart endpoint or xterm Ctrl+C POST). When a
  // running → idle transition fires within RECENT_USER_ACTION_MS of an
  // entry, the reducer clears `statusReason`; otherwise it labels
  // `idle_after_unexpected_exit` for the 30-min attention pulse. Lifecycle
  // is in-memory; cleared on daemon restart (acceptable — the window is
  // shorter than any restart, and boot-restore re-establishes `running`).
  recentUserAction: Map<string, number>;
  getAdapter: (runtimeId: string) => RuntimeStatusAdapter;
  adapterStates: Map<string, SessionAdapterState>;
  monitorStates: Map<string, MonitorSessionState>;
}

export interface MonitorTickOptions {
  source: "boot" | "tick";
}

export interface MonitorTickResult {
  sessionsTouched: number;
  deletedSessions: number;
}

const TERMINAL_STATUSES = new Set<AgentSession["status"]>(["stopped", "failed"]);

function makeMonitorState(): MonitorSessionState {
  return {
    lastActivityMs: null,
    ticksSinceActivityChange: 0,
    hasObservedSinceBoot: false,
    consecutiveShellTicks: 0,
    consecutiveMissingTicks: 0,
  };
}

function shouldSuppressCodexOptimisticIdle(
  session: AgentSession,
  observation: PaneObservationResult,
  nowMs: number,
): boolean {
  if (session.runtimeId !== "codex") return false;
  if (session.statusReason !== "optimistic_send") return false;
  if (typeof observation === "string") return false;
  if (observation.observed !== "idle" || observation.reason !== CODEX_REASON_STABLE_TIMEOUT) return false;

  const lastStatusMs = session.lastStatusAt ? new Date(session.lastStatusAt).valueOf() : Number.NaN;
  if (!Number.isFinite(lastStatusMs)) return false;
  return nowMs - lastStatusMs <= CODEX_OPTIMISTIC_SEND_IDLE_SUPPRESS_MS;
}

// Walks non-terminal sessions and applies one round of status detection.
// Lifecycle signals come first (deterministic — exit code, tmux missing,
// pane activity). The runtime adapter is invoked for the pane-derived
// observation. All signals flow through the reducer.
export async function runStatusMonitorTick(
  deps: MonitorTickDeps,
  opts: MonitorTickOptions,
): Promise<MonitorTickResult> {
  // Include shell-runtime sessions so the auto-clear path can run on them
  // too; the per-session derivation below treats them specially.
  const sessions = deps.listSessions().filter((s) => !TERMINAL_STATUSES.has(s.status));
  if (sessions.length === 0) return { sessionsTouched: 0, deletedSessions: 0 };

  const workspaceIds = deps.listWorkspaceIds();
  const tmuxActivities = deps.tmuxActivities();
  // Batched pane snapshot for this tick — one fork instead of N per-session
  // `tmux display-message` calls. Falls back to the per-session callback so
  // tests that haven't wired the batched provider still work.
  const panesByName = deps.panes?.() ?? null;
  // Derive `nowMs` from deps.now() so tests can inject a fixed time and
  // get deterministic behaviour for the recentUserAction window + the
  // 30-min auto-clear elapsed check. Production passes a real ISO.
  const nowMs = new Date(deps.now()).valueOf();

  let sessionsTouched = 0;
  let deletedSessions = 0;

  for (const session of sessions) {
    if (!session.tmuxSessionName) continue;
    const adapter = deps.getAdapter(session.runtimeId);
    let adapterState = deps.adapterStates.get(session.id);
    if (!adapterState) {
      adapterState = adapter.createSessionState();
      deps.adapterStates.set(session.id, adapterState);
    }
    let monitorState = deps.monitorStates.get(session.id);
    if (!monitorState) {
      monitorState = makeMonitorState();
      deps.monitorStates.set(session.id, monitorState);
    }

    const tmuxActivityMs = tmuxActivities.get(session.tmuxSessionName) ?? null;
    // Shell-first lifecycle: pane foreground IS the source of truth for
    // "is the agent running". Prefer the batched snapshot when present;
    // a `null` map means "no batched provider wired"; a missing entry in
    // the map means "tmux server has no such session" — same semantic as
    // panePidProcess returning null.
    const pane = panesByName
      ? (panesByName.get(session.tmuxSessionName) ?? null)
      : deps.panePidProcess(session.tmuxSessionName);
    // Three-strike rule for "tmux is missing". A single probe that says
    // "no pane" is NEVER authoritative — batched `tmux list-panes -a` and
    // per-session probes both silently return empty on tmux IO errors, and
    // the 05:49 incident showed how a single 50ms hiccup mass-flips every
    // cockpit terminal. Pipeline:
    //   1. If we found a pane, the session is alive — reset the counter.
    //   2. If we didn't, try a direct `has-session -t <name>` as second
    //      opinion. If has-session says alive, reset and treat as alive.
    //   3. Only after the counter has crossed TMUX_MISSING_DEBOUNCE_TICKS
    //      (= 3 ticks ≈ 6s of unanimous "gone") does the tick concede and
    //      emit the tmux_missing signal.
    // When `hasTmuxSession` is unwired (legacy tests), step 2 is skipped —
    // the counter alone still gates the flip, so tests that wanted the
    // immediate `unknown` outcome now need to tick three times. The
    // existing regression-pin test pins exactly that progression.
    let tmuxAlive: boolean;
    if (pane !== null) {
      if (monitorState.consecutiveMissingTicks > 0) {
        deps.diagnostics?.log("monitor", "missing-counter.reset", {
          sessionId: session.id,
          tmuxSession: session.tmuxSessionName,
          via: "pane",
          previousCount: monitorState.consecutiveMissingTicks,
        });
      }
      tmuxAlive = true;
      monitorState.consecutiveMissingTicks = 0;
    } else if (deps.hasTmuxSession?.(session.tmuxSessionName) === true) {
      if (monitorState.consecutiveMissingTicks > 0) {
        deps.diagnostics?.log("monitor", "missing-counter.reset", {
          sessionId: session.id,
          tmuxSession: session.tmuxSessionName,
          via: "has-session",
          previousCount: monitorState.consecutiveMissingTicks,
        });
      }
      tmuxAlive = true;
      monitorState.consecutiveMissingTicks = 0;
    } else {
      monitorState.consecutiveMissingTicks += 1;
      tmuxAlive = monitorState.consecutiveMissingTicks < TMUX_MISSING_DEBOUNCE_TICKS;
      const alreadyRecordedMissing =
        session.status === "unknown" &&
        (session.statusReason === "tmux_missing" || session.statusReason === "daemon_restart_indeterminate");
      const crossedMissingThreshold = monitorState.consecutiveMissingTicks === TMUX_MISSING_DEBOUNCE_TICKS;
      const shouldLogMissingProbe = tmuxAlive
        ? !alreadyRecordedMissing
        : !alreadyRecordedMissing && crossedMissingThreshold;
      if (shouldLogMissingProbe) {
        deps.diagnostics?.log("monitor", tmuxAlive ? "missing-counter.bump" : "tmux-missing.fired", {
          sessionId: session.id,
          tmuxSession: session.tmuxSessionName,
          count: monitorState.consecutiveMissingTicks,
          threshold: TMUX_MISSING_DEBOUNCE_TICKS,
          source: opts.source,
          currentStatus: session.status,
          currentStatusReason: session.statusReason,
        });
      }
    }
    const runtimeBinary = deps.runtimeBinaryFor(session.runtimeId);

    if (!session.runtimeSessionId && tmuxAlive && deps.recoverRuntimeSessionId && deps.setRuntimeSessionId) {
      const runtimeSessionId = deps.recoverRuntimeSessionId(session, pane);
      if (runtimeSessionId) {
        deps.setRuntimeSessionId(session.id, runtimeSessionId);
        sessionsTouched += 1;
        deps.emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      }
    }

    // Activity-change tracking. Done BEFORE adapter invocation so the
    // context the adapter sees reflects this tick's bookkeeping.
    const isFirstObservation = monitorState.lastActivityMs === null;
    const activityChanged =
      tmuxActivityMs !== null &&
      (isFirstObservation || (monitorState.lastActivityMs !== null && tmuxActivityMs > monitorState.lastActivityMs));
    if (tmuxActivityMs !== null) {
      if (activityChanged) {
        monitorState.lastActivityMs = tmuxActivityMs;
        monitorState.ticksSinceActivityChange = 0;
      } else {
        monitorState.ticksSinceActivityChange += 1;
      }
    }

    // First-pass lifecycle signals (deterministic). At most one applies.
    const signals: StatusSignal[] = [];

    if (!tmuxAlive) {
      // Workspace-membership check: if the workspace is gone too, prune
      // the session row instead of marking it unknown. Existing reaper
      // semantic preserved.
      if (!workspaceIds.has(session.workspaceId)) {
        deps.diagnostics?.log("monitor", "session.deleted", {
          sessionId: session.id,
          workspaceId: session.workspaceId,
          reason: "workspace-gone+tmux-missing",
          tmuxSession: session.tmuxSessionName,
        });
        deps.deleteSession(session.id);
        deletedSessions += 1;
        deps.adapterStates.delete(session.id);
        deps.monitorStates.delete(session.id);
        continue;
      }
      // tmux unreachable. NEVER `stopped` (the 18:40:57 mass-flip incident
      // was caused by reading exited_failed signals from the wrapper's EXIT
      // trap when tmux died; with the wrapper gone, the only valid response
      // to tmux-missing is `unknown`).
      signals.push({
        type: "tmux_missing",
        reason: opts.source === "boot" ? "daemon_restart_indeterminate" : "tmux_missing",
      });
      monitorState.consecutiveShellTicks = 0;
    } else if (pane && SHELL_BINARIES.has(pane.command) && session.runtimeId !== "shell") {
      // Agent runtime, pane foreground is a shell binary → agent stopped
      // running. Two-tick debounce: claude routinely shells out to git/rg
      // briefly; a single tick of "shell" doesn't constitute "agent exited".
      monitorState.consecutiveShellTicks += 1;
      if (monitorState.consecutiveShellTicks >= RUNNING_TO_IDLE_DEBOUNCE_TICKS) {
        const userActionTs = deps.recentUserAction.get(session.id);
        const recentUserAction = userActionTs !== undefined && nowMs - userActionTs <= RECENT_USER_ACTION_MS;
        signals.push({ type: "pane_idle", recentUserAction, observedAt: deps.now() });
      }
    } else {
      // Agent foreground (or shell runtime with any tmux-alive). Reset the
      // debounce counter so a future running→idle transition starts fresh.
      monitorState.consecutiveShellTicks = 0;
      if (activityChanged && tmuxActivityMs !== null) {
        signals.push({ type: "active", lastOutputAt: new Date(tmuxActivityMs).toISOString() });
      }
    }

    // Auto-clear: previously-labeled idle_after_unexpected_exit beyond the
    // 30-min window with no operator Restart. Driven by `statusReasonAt`,
    // independent of lastStatusAt (which is reset by every benign
    // sub-status flip from runtime adapters).
    if (
      session.status === "idle" &&
      session.statusReason === REASON_IDLE_AFTER_UNEXPECTED_EXIT &&
      session.statusReasonAt
    ) {
      const elapsed = nowMs - new Date(session.statusReasonAt).valueOf();
      if (elapsed > IDLE_AFTER_UNEXPECTED_EXIT_AUTO_CLEAR_MS) {
        signals.push({ type: "idle_after_unexpected_exit_expired" });
      }
    }

    // Adapter observation (pane-derived) — only when the session is alive
    // and we don't already have a tmux_missing or pane_idle signal.
    const liveBranch = tmuxAlive && !signals.some((s) => s.type === "tmux_missing" || s.type === "pane_idle");
    if (liveBranch && tmuxAlive) {
      const observation = adapter.observe(
        adapterState,
        buildContext(deps, session, monitorState, opts, activityChanged),
      );
      monitorState.hasObservedSinceBoot = true;
      if (observation !== null) {
        if (shouldSuppressCodexOptimisticIdle(session, observation, nowMs)) {
          deps.diagnostics?.log("monitor", "codex.optimistic-idle-suppressed", {
            sessionId: session.id,
            tmuxSession: session.tmuxSessionName,
            reason: typeof observation === "string" ? null : observation.reason,
            lastStatusAt: session.lastStatusAt,
          });
        } else if (typeof observation === "string") {
          signals.push({ type: "pane_observation", observed: observation });
        } else {
          signals.push({ type: "pane_observation", observed: observation.observed, reason: observation.reason });
        }
      }
    }

    if (signals.length === 0) continue;

    const originalPrev: ReducerPrev = {
      status: session.status,
      lastOutputAt: session.lastOutputAt,
      statusReason: session.statusReason,
    };
    // Apply each signal in turn, threading the synthetic prev forward so the
    // reducer sees the post-signal state on subsequent signals. Accumulate
    // the net delta and persist a single update at the end — multiple signals
    // per tick (e.g., `active` + `pane_observation`) become one DB write and
    // one SSE event.
    let working: ReducerPrev = originalPrev;
    const merged: StatusUpdate = { status: originalPrev.status };
    let anyChange = false;
    for (const signal of signals) {
      const update = reduceStatus(working, signal, deps.now);
      if (!update) continue;
      anyChange = true;
      merged.status = update.status;
      if (update.reason !== undefined) merged.reason = update.reason;
      if (update.reasonAt !== undefined) merged.reasonAt = update.reasonAt;
      if (update.lastStatusAt !== undefined) merged.lastStatusAt = update.lastStatusAt;
      if (update.lastOutputAt !== undefined) merged.lastOutputAt = update.lastOutputAt;
      if (update.endedAt !== undefined) merged.endedAt = update.endedAt;
      if (update.exitCode !== undefined) merged.exitCode = update.exitCode;
      working = {
        status: update.status,
        lastOutputAt: update.lastOutputAt !== undefined ? update.lastOutputAt : working.lastOutputAt,
        statusReason: update.reason ?? working.statusReason,
      };
    }
    if (anyChange) {
      // Only persist + broadcast when status/reason actually changed.
      // lastOutputAt-only updates would otherwise generate every-2s DB
      // writes + SSE events for every running session — saturating UI
      // invalidations for no rendering benefit. The UI's existing 5s
      // state poll picks up lastOutputAt from the tmux side, and the
      // cockpit-summary endpoint can read it on demand.
      const statusChanged = merged.status !== originalPrev.status;
      // `merged.reason` can legitimately be `null` (clearing a reason after
      // recent user action) — compare against `originalPrev.statusReason`
      // which may also be null, and treat distinct nullable values as a
      // change. `undefined` means "no change to reason in this tick".
      const reasonChanged =
        Object.prototype.hasOwnProperty.call(merged, "reason") && merged.reason !== originalPrev.statusReason;
      if (statusChanged || reasonChanged) {
        deps.updateSession(session.id, merged);
        sessionsTouched += 1;
        deps.emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
        if (merged.status === "stopped" || merged.status === "failed") {
          deps.adapterStates.delete(session.id);
          deps.monitorStates.delete(session.id);
        }
      }
    }
  }

  return { sessionsTouched, deletedSessions };
}

function buildContext(
  deps: MonitorTickDeps,
  session: AgentSession,
  monitorState: MonitorSessionState,
  opts: MonitorTickOptions,
  activityChanged: boolean,
): ObservationContext {
  return {
    paneCapture: session.tmuxSessionName ? deps.paneCapture(session.tmuxSessionName) : "",
    tmuxActivityChangedSinceLastTick: activityChanged,
    ticksSinceActivityChange: monitorState.ticksSinceActivityChange,
    source: opts.source,
    hasObservedSinceBoot: monitorState.hasObservedSinceBoot,
    now: () => new Date(deps.now()),
  };
}

export interface StatusMonitorHandle {
  stop: () => void;
}

// Periodic driver. Thin wrapper around the shared startGuardedInterval so
// the overlap guard, unref, and clearInterval semantics live in one place
// (also used by startAutoResumeLoop). Behaviour is identical to the prior
// inline setInterval.
export function startStatusMonitor(deps: MonitorTickDeps, intervalMs = 2000): StatusMonitorHandle {
  return startGuardedInterval(() => runStatusMonitorTick(deps, { source: "tick" }), intervalMs, {
    error: (_msg, err) => {
      // eslint-disable-next-line no-console
      console.error("[status-monitor] tick failed:", err);
    },
  });
}
