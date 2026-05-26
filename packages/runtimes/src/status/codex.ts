import {
  lastNonEmptyLine,
  observeIdle,
  observeRunning,
  observeWaitingForInput,
  type ObservationContext,
  type PaneObservation,
  type RuntimeStatusAdapter,
  type SessionAdapterState,
} from "./index.js";

// Codex v0.130.0 detection.
//
// Codex doesn't surface much state in its pane: no animated "thinking"
// indicator, no background-work counters. Detection relies on:
//   - tmux #{session_activity} timestamp via ObservationContext (provided by
//     the monitor — runtime-agnostic)
//   - the sandbox-approval footer for waiting_for_input
//
// Documented limitations:
//   - Codex has Bash run_in_background and Task (subagents) but doesn't
//     visually surface them. Sessions with background work in flight while
//     the main agent is quiet will be classified `idle`. False-positive
//     completion sound; acceptable best-effort.
//   - First post-boot tick suppresses idle to avoid spurious completion
//     sounds for codex sessions that were actually working pre-restart.

const SANDBOX_APPROVAL_FOOTER = "Press enter to confirm or esc to cancel";

const IDLE_STABLE_TICKS = 2;

export interface CodexAdapterState extends SessionAdapterState {
  // Already inherited: ticksObserved, lastPaneHash.
}

export const codexStatusAdapter: RuntimeStatusAdapter = {
  runtimeId: "codex",

  createSessionState(): CodexAdapterState {
    return { ticksObserved: 0, lastPaneHash: null };
  },

  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservation | null {
    state.ticksObserved += 1;

    // Priority 0: rate-limit banner.
    const rateLimit = codexStatusAdapter.detectRateLimit(ctx.paneCapture);
    if (rateLimit !== null) {
      return { kind: "rate_limited", resetAt: rateLimit.resetAt };
    }

    const bottom = lastNonEmptyLine(ctx.paneCapture);

    // Priority 1: sandbox approval footer.
    if (bottom === SANDBOX_APPROVAL_FOOTER) {
      return observeWaitingForInput();
    }

    // Priority 2: pane activity changed → running.
    if (ctx.tmuxActivityChangedSinceLastTick) {
      return observeRunning();
    }

    // Priority 3: stable for ≥ IDLE_STABLE_TICKS — idle.
    // Boot suppression: never emit idle on the very first post-boot tick. If
    // the daemon restarted while codex was working, the in-memory state has
    // no prior activity reference and we'd misclassify.
    if (ctx.source === "boot" || !ctx.hasObservedSinceBoot) {
      return null;
    }
    if (ctx.ticksSinceActivityChange >= IDLE_STABLE_TICKS) {
      return observeIdle();
    }

    // Stability of exactly 1 — not yet enough to call idle.
    return null;
  },

  // Stateless rate-limit detection. STUB during the Scope contingency —
  // real captures + calibrated regex land in a follow-up PR.
  detectRateLimit(_paneCapture: string): { resetAt: string | null } | null {
    return null;
  },
};
