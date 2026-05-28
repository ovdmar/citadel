import type { ObservationContext, PaneObservationResult, RuntimeStatusAdapter, SessionAdapterState } from "./index.js";
import { lastNonEmptyLine } from "./index.js";

// Codex v0.130.0+ detection.
//
// Detection anchors:
//   - Any visible `esc to interrupt` / `esc for interrupt` marker → running.
//     This is the strongest Codex running signal and wins over every other
//     pane-derived check, including stale dividers and approval footers.
//   - Sandbox approval footer → waiting_for_input
//   - Spinner line of the form `<bullet> <verb> (<elapsed> • esc to interrupt)`
//     → running. Bullet rotates `•`/`◦` while animating; verbs include
//     "Working", "Thinking", "Cogitated", etc. The distinctive substring is
//     the interrupt marker scanned above. Scanned over
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

// Codex wording has appeared as both "esc to interrupt" and "esc for interrupt".
// Treat either visible marker as authoritative running state.
const ACTIVE_INTERRUPT_REGEX = /\besc\s+(?:to|for)\s+interrupt\)?/i;

// Post-turn separator: `─ Worked for Xm Ys ───────────…`. Replaces the spinner
// the moment the turn finishes. Anchored on `Worked for` preceded by the box-
// drawing line glyph so plain user/agent text mentioning "worked for" doesn't
// match. Acts as a positive idle signal so the transition is immediate; without
// it the adapter would return null until ticksSinceActivityChange ≥ 2, causing
// a brief running → null → idle flicker in the UI.
const POST_TURN_DIVIDER_REGEX = /^─+\s+Worked for\s/;
const USER_PROMPT_REGEX = /^›\s+/;
const PROMPT_HINT_PREFIX = "› Use /skills";

const ACTIVE_SCAN_LINES = 30;

const IDLE_STABLE_TICKS = 2;

export const CODEX_REASON_INTERRUPT = "pane:codex:interrupt";
export const CODEX_REASON_ACTIVITY = "pane:codex:activity";
export const CODEX_REASON_CURRENT_TURN_DIVIDER = "pane:codex:current_turn_divider";
export const CODEX_REASON_STABLE_TIMEOUT = "pane:codex:stable_timeout";
export const CODEX_REASON_SANDBOX_APPROVAL = "pane:codex:sandbox_approval";

function bottomLines(paneCapture: string, n: number): string[] {
  const lines = paneCapture.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function hasActiveInterruptMarker(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, ACTIVE_SCAN_LINES);
  for (const line of lines) {
    if (ACTIVE_INTERRUPT_REGEX.test(line)) return true;
  }
  return false;
}

function currentTurnLines(paneCapture: string): string[] {
  const lines = bottomLines(paneCapture, ACTIVE_SCAN_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trimStart() ?? "";
    if (!USER_PROMPT_REGEX.test(trimmed)) continue;
    if (trimmed.startsWith(PROMPT_HINT_PREFIX)) continue;
    return lines.slice(i + 1);
  }
  return lines;
}

function hasCurrentTurnPostDivider(paneCapture: string): boolean {
  const lines = currentTurnLines(paneCapture);
  for (const line of lines) {
    if (POST_TURN_DIVIDER_REGEX.test(line)) return true;
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

  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservationResult | null {
    state.ticksObserved += 1;

    const bottom = lastNonEmptyLine(ctx.paneCapture);

    // Priority 1: visible interrupt marker → running. This wins over every
    // other pane-derived check because Codex only shows it while a turn can be
    // interrupted.
    if (hasActiveInterruptMarker(ctx.paneCapture)) {
      return { observed: "running", reason: CODEX_REASON_INTERRUPT };
    }

    // Priority 2: sandbox approval footer.
    if (bottom === SANDBOX_APPROVAL_FOOTER) {
      return { observed: "waiting_for_input", reason: CODEX_REASON_SANDBOX_APPROVAL };
    }

    // Priority 3: post-turn divider visible → idle. Positive signal for the
    // turn-just-finished case so we don't flicker through `null` waiting for
    // the activity counter to stabilize.
    if (hasCurrentTurnPostDivider(ctx.paneCapture)) {
      return { observed: "idle", reason: CODEX_REASON_CURRENT_TURN_DIVIDER };
    }

    // Priority 4: pane activity changed → running. Covers TUI changes that
    // happen without the spinner (e.g. tool-result panels rerendering).
    if (ctx.tmuxActivityChangedSinceLastTick) {
      return { observed: "running", reason: CODEX_REASON_ACTIVITY };
    }

    // Priority 5: stable for ≥ IDLE_STABLE_TICKS — idle.
    // Boot suppression: never emit idle on the very first post-boot tick. If
    // the daemon restarted while codex was working, the in-memory state has
    // no prior activity reference and we'd misclassify.
    if (ctx.source === "boot" || !ctx.hasObservedSinceBoot) {
      return null;
    }
    if (ctx.ticksSinceActivityChange >= IDLE_STABLE_TICKS) {
      return { observed: "idle", reason: CODEX_REASON_STABLE_TIMEOUT };
    }

    // Stability of exactly 1 — not yet enough to call idle.
    return null;
  },
};
