import type { AgentSession } from "@citadel/contracts";

export const LAST_OUTPUT_DEBOUNCE_MS = 1000;

// Reasons emitted by lifecycle signals (tmux_missing). The same set is
// surfaced on AgentSession.statusReason after the reducer applies the signal.
export type TmuxMissingReason =
  | "tmux_missing"
  | "daemon_restart_indeterminate"
  | "sentinel_missing_no_exit_record"
  | "sentinel_missing_tmux_alive";

export type StatusSignal =
  | { type: "launch_succeeded" }
  | { type: "launch_failed"; reason: string }
  | { type: "tmux_missing"; reason: TmuxMissingReason }
  | { type: "exited_clean"; exitCode: number; endedAt: string }
  | { type: "exited_failed"; exitCode: number; endedAt: string }
  | { type: "active"; lastOutputAt: string }
  | {
      type: "pane_observation";
      observed: "running" | "idle" | "waiting_for_input" | "rate_limited" | "usage_limited";
      reason?: string;
    }
  | { type: "optimistic_send" };

// Subset of AgentSession the reducer needs. Callers can pass the full row.
export type ReducerPrev = Pick<AgentSession, "status" | "lastOutputAt" | "statusReason">;

// Update returned by the reducer. Fields are optional — only set what changed.
// `lastStatusAt` is set ONLY on status-field change. Reason-only refinements
// leave it undefined so the persistence layer can keep the prior timestamp.
export interface StatusUpdate {
  status: AgentSession["status"];
  reason?: string;
  lastStatusAt?: string;
  lastOutputAt?: string | null;
  endedAt?: string | null;
  exitCode?: number | null;
}

type CanonicalStatus = AgentSession["status"];

const TERMINAL_STATUSES: ReadonlySet<CanonicalStatus> = new Set(["stopped", "failed"]);

// Default canonical reason for a pane_observation when the adapter doesn't
// pass an explicit one. Adapters can override via signal.reason.
function defaultPaneReason(
  observed: "running" | "idle" | "waiting_for_input" | "rate_limited" | "usage_limited",
): string {
  if (observed === "rate_limited") return "pane:rate_limited:server";
  if (observed === "usage_limited") return "pane:usage_limited:reset=unknown";
  return `pane:active:${observed}`;
}

function statusUpdate(
  prev: ReducerPrev,
  next: CanonicalStatus,
  reason: string,
  now: string,
  extra: Omit<StatusUpdate, "status" | "reason" | "lastStatusAt"> = {},
): StatusUpdate {
  return {
    status: next,
    reason,
    lastStatusAt: now,
    ...extra,
  };
}

function reasonRefinement(prev: ReducerPrev, sameStatus: CanonicalStatus, newReason: string): StatusUpdate | null {
  // Same-status, different-reason → return update WITHOUT lastStatusAt so the
  // caller preserves the prior status-change timestamp. If reason is identical,
  // it's a true no-op.
  if (prev.statusReason === newReason) return null;
  return { status: sameStatus, reason: newReason };
}

// Pure status reducer. The single point where AgentSession.status mutates.
// Returns null when the signal warrants no persisted change.
export function reduceStatus(prev: ReducerPrev, signal: StatusSignal, now: () => string): StatusUpdate | null {
  const t = now();

  // Terminal-state stickiness: once stopped/failed, only an explicit re-launch
  // transitions out. Everything else short-circuits to null.
  if (TERMINAL_STATUSES.has(prev.status) && signal.type !== "launch_succeeded") {
    return null;
  }

  switch (signal.type) {
    case "launch_succeeded": {
      if (prev.status === "starting") {
        return statusUpdate(prev, "running", "launched", t);
      }
      // Re-launch from a terminal state creates a fresh running row.
      if (TERMINAL_STATUSES.has(prev.status)) {
        return statusUpdate(prev, "running", "relaunched", t);
      }
      // Already running / waiting_for_input / idle / unknown — no-op.
      return null;
    }

    case "launch_failed": {
      if (prev.status === "starting") {
        return statusUpdate(prev, "failed", signal.reason, t, { endedAt: t });
      }
      return null;
    }

    case "tmux_missing": {
      // Reason-refinement when already unknown — caller passes a more specific
      // reason and we update without bumping lastStatusAt.
      if (prev.status === "unknown") {
        return reasonRefinement(prev, "unknown", signal.reason);
      }
      return statusUpdate(prev, "unknown", signal.reason, t);
    }

    case "exited_clean": {
      return statusUpdate(prev, "stopped", "exit_code_0", t, {
        endedAt: signal.endedAt,
        exitCode: signal.exitCode,
      });
    }

    case "exited_failed": {
      return statusUpdate(prev, "failed", `exit_code_${signal.exitCode}`, t, {
        endedAt: signal.endedAt,
        exitCode: signal.exitCode,
      });
    }

    case "active": {
      // Active does NOT transition out of idle/waiting_for_input/rate_limited/
      // usage_limited — those are sticky post-turn states until a positive
      // pane_observation arrives. For unknown, treat as resurrection → running.
      if (prev.status === "unknown") {
        return statusUpdate(prev, "running", "resurrected_by_activity", t, {
          lastOutputAt: signal.lastOutputAt,
        });
      }
      if (prev.status !== "running" && prev.status !== "starting") {
        return null;
      }
      // running / starting: maybe bump lastOutputAt if past the debounce window.
      const prevOutput = prev.lastOutputAt;
      if (prevOutput) {
        const delta = new Date(signal.lastOutputAt).getTime() - new Date(prevOutput).getTime();
        if (delta < LAST_OUTPUT_DEBOUNCE_MS) return null;
      }
      // Status unchanged (still running/starting) — return update WITHOUT
      // lastStatusAt so the persistence layer keeps prior timestamp.
      if (prev.status === "starting") {
        // Activity during starting promotes to running.
        return statusUpdate(prev, "running", "activity", t, { lastOutputAt: signal.lastOutputAt });
      }
      return { status: "running", lastOutputAt: signal.lastOutputAt };
    }

    case "pane_observation": {
      const reason = signal.reason ?? defaultPaneReason(signal.observed);
      const target: CanonicalStatus = signal.observed;
      if (prev.status === target) {
        // Same status. Refine the reason if the adapter is reporting a
        // different one — critical for usage_limited where the reason
        // encodes the parsed reset wall-clock that needs to update as the
        // banner ages past the original reset moment. Identical reasons
        // are no-ops (reasonRefinement returns null), so steady-state
        // sessions don't churn the DB or SSE.
        return reasonRefinement(prev, target, reason);
      }
      return statusUpdate(prev, target, reason, t);
    }

    case "optimistic_send": {
      // Only valid when the agent is post-turn (idle, waiting_for_input,
      // rate_limited, or usage_limited). Stamps a sentinel reason so the
      // completion-sound trigger can guard against firing if the next pane
      // observation shows idle with no activity (i.e., the send didn't
      // actually start a turn). usage_limited is included so the auto-resume
      // loop's wake-after-reset send transitions the dot back to running
      // immediately rather than waiting for the next monitor tick.
      if (
        prev.status === "idle" ||
        prev.status === "waiting_for_input" ||
        prev.status === "rate_limited" ||
        prev.status === "usage_limited"
      ) {
        return statusUpdate(prev, "running", "optimistic_send", t);
      }
      return null;
    }
  }
}
