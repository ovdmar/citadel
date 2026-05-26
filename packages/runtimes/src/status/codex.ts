import type { ObservationContext, PaneObservation, RuntimeStatusAdapter, SessionAdapterState } from "./index.js";
import { lastNonEmptyLine } from "./index.js";

// Codex v0.130.0+ detection.
//
// Detection anchors:
//   - Sandbox approval footer → waiting_for_input
//   - Spinner line of the form `<bullet> <verb> (<elapsed> • esc to interrupt)`
//     → running. Bullet rotates `•`/`◦` while animating; verbs include
//     "Working", "Thinking", "Cogitated", etc. The distinctive substring is
//     `esc to interrupt)` (closing paren is unique to the spinner format
//     and absent from the sandbox footer's "esc to cancel"). Scanned over
//     the last ~30 lines because the spinner sits a few lines above the
//     "› Use /skills…" hint and the model status footer.
//   - tmux #{session_activity} timestamp via ObservationContext as a
//     secondary running signal (covers TUI changes that don't include the
//     spinner — e.g. tool-result re-renders).
//   - The model status line (`gpt-5.5 …`) and the tmux status bar live below
//     the spinner, so the bottom-most non-empty line is NOT a useful anchor
//     for running detection. Only the sandbox footer is bottom-anchored.
//
// Documented limitations:
//   - Codex has Bash run_in_background and Task (subagents) but doesn't
//     visually surface them. Sessions with background work in flight while
//     the main agent is quiet will be classified `idle`. False-positive
//     completion sound; acceptable best-effort.
//   - First post-boot tick suppresses idle to avoid spurious completion
//     sounds for codex sessions that were actually working pre-restart.

const SANDBOX_APPROVAL_FOOTER = "Press enter to confirm or esc to cancel";

// Closing paren is the disambiguator vs the sandbox footer's "esc to cancel".
const ACTIVE_SPINNER_SUBSTRING = "esc to interrupt)";

const ACTIVE_SCAN_LINES = 30;

const IDLE_STABLE_TICKS = 2;

function bottomLines(paneCapture: string, n: number): string[] {
  const lines = paneCapture.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function hasActiveSpinner(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, ACTIVE_SCAN_LINES);
  for (const line of lines) {
    if (line.includes(ACTIVE_SPINNER_SUBSTRING)) return true;
  }
  return false;
}

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

    const bottom = lastNonEmptyLine(ctx.paneCapture);

    // Priority 1: sandbox approval footer.
    if (bottom === SANDBOX_APPROVAL_FOOTER) {
      return "waiting_for_input";
    }

    // Priority 2: active spinner with `esc to interrupt)` visible → running.
    // This is the positive signal we need when codex sits computing for
    // minutes without redrawing — tmux activity alone goes stale and we'd
    // misclassify as idle.
    if (hasActiveSpinner(ctx.paneCapture)) {
      return "running";
    }

    // Priority 3: pane activity changed → running. Covers TUI changes that
    // happen without the spinner (e.g. tool-result panels rerendering).
    if (ctx.tmuxActivityChangedSinceLastTick) {
      return "running";
    }

    // Priority 4: stable for ≥ IDLE_STABLE_TICKS — idle.
    // Boot suppression: never emit idle on the very first post-boot tick. If
    // the daemon restarted while codex was working, the in-memory state has
    // no prior activity reference and we'd misclassify.
    if (ctx.source === "boot" || !ctx.hasObservedSinceBoot) {
      return null;
    }
    if (ctx.ticksSinceActivityChange >= IDLE_STABLE_TICKS) {
      return "idle";
    }

    // Stability of exactly 1 — not yet enough to call idle.
    return null;
  },
};
