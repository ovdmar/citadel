import type { AgentSession } from "@citadel/contracts";
import type { ObservationContext, RuntimeStatusAdapter, SessionAdapterState } from "@citadel/runtimes";
import { type ReducerPrev, type StatusSignal, type StatusUpdate, reduceStatus } from "./agent-status.js";

// Per-session bookkeeping that the monitor maintains across ticks. The
// adapter has its own SessionAdapterState (for runtime-specific internals);
// the monitor owns activity-change tracking which is runtime-agnostic.
export interface MonitorSessionState {
  lastActivityMs: number | null;
  ticksSinceActivityChange: number;
  hasObservedSinceBoot: boolean;
  // Number of consecutive observation ticks where the adapter returned a
  // non-rate_limited PaneObservation while prev.status is rate_limited.
  // Resets to 0 on any pane_rate_limited observation. The exit transition
  // from rate_limited is only forwarded to the reducer at ≥2 — protects
  // against false-positive flips when the banner scrolls off-screen for a
  // single tick.
  consecutiveNonRateLimitedTicks: number;
  // Flips to true at the END of runStatusMonitorTick (after observation +
  // persistence + the rate-limit scheduler tick). Initial false. The
  // rate-limit scheduler gates BOTH schedule and execute phases on this flag
  // so a pending row from a previous daemon run never fires on the very
  // first post-boot tick. See AC8 in .agents/plans/rate-limit-handling.md.
  hasCompletedFirstTick: boolean;
}

export interface SentinelReading {
  live: boolean;
  exitCode: number | null;
  // ISO timestamp of when the .exit file was created (≈ when the agent exited).
  exitedAt: string | null;
}

// Dependencies the tick needs. All I/O is dependency-injected so the tick
// can be tested without real tmux/fs/store. The real daemon wires real
// implementations in apps/daemon/src/app.ts.
export interface MonitorTickDeps {
  now: () => string;
  // Snapshot of non-terminal candidate sessions. The monitor itself filters
  // by status + runtime.
  listSessions: () => AgentSession[];
  // Workspace ids currently in the store. Used to detect "tmux + workspace
  // both gone" and prune the session row.
  listWorkspaceIds: () => Set<string>;
  // Persist a status update. The reducer-derived StatusUpdate is passed
  // verbatim; the store decides which columns to write.
  updateSession: (sessionId: string, update: StatusUpdate) => void;
  // Drop a session row entirely (used by the workspace-membership check).
  deleteSession: (sessionId: string) => void;
  // SSE broadcast. Boot reconcile passes emit=()=>{} so the tick body
  // doesn't need to branch on source.
  emit: (event: string, payload: unknown) => void;
  // Single batched tmux query — map of tmux_session_name → activity ts (ms).
  // Called once per tick regardless of N sessions.
  tmuxActivities: () => Map<string, number>;
  // Capture the visible pane (no scrollback). Called per session.
  paneCapture: (tmuxSessionName: string) => string;
  // Async stat of .live + .exit sentinel files. Called per session in parallel.
  readSentinels: (tmuxSessionName: string) => Promise<SentinelReading>;
  // Adapter selector + state map.
  getAdapter: (runtimeId: string) => RuntimeStatusAdapter;
  adapterStates: Map<string, SessionAdapterState>;
  // Monitor's own state map (activity tracking).
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
    consecutiveNonRateLimitedTicks: 0,
    hasCompletedFirstTick: false,
  };
}

// Walks non-terminal sessions and applies one round of status detection.
// Lifecycle signals come first (deterministic — exit code, tmux missing,
// pane activity). The runtime adapter is invoked for the pane-derived
// observation. All signals flow through the reducer.
export async function runStatusMonitorTick(
  deps: MonitorTickDeps,
  opts: MonitorTickOptions,
): Promise<MonitorTickResult> {
  const sessions = deps.listSessions().filter((s) => !TERMINAL_STATUSES.has(s.status) && s.runtimeId !== "shell");
  if (sessions.length === 0) return { sessionsTouched: 0, deletedSessions: 0 };

  const workspaceIds = deps.listWorkspaceIds();
  const tmuxActivities = deps.tmuxActivities();

  // Parallel sentinel reads.
  const sentinelByName = new Map<string, SentinelReading>();
  await Promise.all(
    sessions.map(async (s) => {
      if (!s.tmuxSessionName) return;
      const reading = await deps.readSentinels(s.tmuxSessionName);
      sentinelByName.set(s.tmuxSessionName, reading);
    }),
  );

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
    const tmuxAlive = tmuxActivityMs !== null;
    const sentinel = sentinelByName.get(session.tmuxSessionName);

    // Activity-change tracking. Done BEFORE adapter invocation so the
    // context the adapter sees reflects this tick's bookkeeping.
    // The first observation of a session is also "activity changed" — there
    // was no prior reference; we're freshly observing it.
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

    if (sentinel && sentinel.exitCode !== null && sentinel.exitedAt) {
      if (sentinel.exitCode === 0) {
        signals.push({ type: "exited_clean", exitCode: 0, endedAt: sentinel.exitedAt });
      } else {
        signals.push({ type: "exited_failed", exitCode: sentinel.exitCode, endedAt: sentinel.exitedAt });
      }
    } else if (!tmuxAlive) {
      // Workspace-membership check: if the workspace is gone too, prune
      // the session row instead of marking it unknown. Existing reaper
      // semantic preserved.
      if (!workspaceIds.has(session.workspaceId)) {
        deps.deleteSession(session.id);
        deletedSessions += 1;
        deps.adapterStates.delete(session.id);
        deps.monitorStates.delete(session.id);
        continue;
      }
      signals.push({
        type: "tmux_missing",
        reason: opts.source === "boot" ? "daemon_restart_indeterminate" : "tmux_missing",
      });
    } else if (sentinel && !sentinel.live) {
      // tmux is alive but the bash wrapper's .live sentinel is gone and
      // no .exit was recorded. /tmp got cleared, or the wrapper crashed.
      signals.push({ type: "tmux_missing", reason: "sentinel_missing_tmux_alive" });
    } else if (activityChanged && tmuxActivityMs !== null) {
      signals.push({ type: "active", lastOutputAt: new Date(tmuxActivityMs).toISOString() });
    }

    // Adapter observation (pane-derived) — only when the session is alive
    // and we don't already have a lifecycle terminal signal pending.
    const liveBranch =
      signals.length === 0 ||
      (signals[0]?.type !== "exited_clean" &&
        signals[0]?.type !== "exited_failed" &&
        signals[0]?.type !== "tmux_missing");
    if (liveBranch && tmuxAlive) {
      const observation = adapter.observe(
        adapterState,
        buildContext(deps, session, monitorState, opts, activityChanged),
      );
      monitorState.hasObservedSinceBoot = true;
      if (observation !== null) {
        if (observation.kind === "rate_limited") {
          signals.push({ type: "pane_rate_limited", resetAt: observation.resetAt });
          monitorState.consecutiveNonRateLimitedTicks = 0;
        } else {
          // Exit-from-rate_limited hysteresis: only forward the pane_observation
          // signal to the reducer when the counter reaches ≥2 consecutive
          // non-rate_limited ticks while prev.status is rate_limited.
          const exitingRateLimited = session.status === "rate_limited";
          if (exitingRateLimited) {
            monitorState.consecutiveNonRateLimitedTicks += 1;
          } else {
            monitorState.consecutiveNonRateLimitedTicks = 0;
          }
          if (!exitingRateLimited || monitorState.consecutiveNonRateLimitedTicks >= 2) {
            signals.push({ type: "pane_observation", observed: observation.kind });
          }
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
      const reasonChanged = merged.reason !== undefined && merged.reason !== originalPrev.statusReason;
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
  };
}

export interface StatusMonitorHandle {
  stop: () => void;
}

// Periodic driver. Hidden behind a thin wrapper so apps/daemon can `.unref()`
// and clear on server close.
export function startStatusMonitor(deps: MonitorTickDeps, intervalMs = 2000): StatusMonitorHandle {
  let running = false;
  const handle = setInterval(() => {
    if (running) return; // skip if previous tick still in flight
    running = true;
    runStatusMonitorTick(deps, { source: "tick" })
      .catch((err) => {
        // Best-effort log; don't crash the daemon on a single bad tick.
        // eslint-disable-next-line no-console
        console.error("[status-monitor] tick failed:", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return {
    stop: () => clearInterval(handle),
  };
}
