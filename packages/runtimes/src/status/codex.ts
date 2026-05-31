import { REASON_ELAPSED_TIMER, observeActiveElapsedTimer } from "./elapsed-timer.js";
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
//   - An elapsed active timer that advances between captures → running.
//   - The latest Codex turn's assistant output changing while tmux activity
//     advances → running. This covers spinner-less mid-stream captures; the
//     prior-turn fingerprint prevents idle TUI repaints or prompt editing from
//     becoming running signals.
//     tmux activity is deliberately NOT a running signal: focus, prompt
//     edits, and TUI repaints can all bump activity while Codex is idle.
//   - Current-turn post-turn divider → idle. Old dividers above a newer prompt
//     are ignored; otherwise a stale `Worked for` line can mask a running turn.
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
const ACTIVE_INTERRUPT_TIMER_REGEX = /\([^)]*\d+\s*[hms][^)]*\besc\s+(?:to|for)\s+interrupt\)?[^)]*\)/i;
const SPINNER_LINE_PREFIX_REGEX = /^[•◦·]\s*/;

// Post-turn separator: `─ Worked for Xm Ys ───────────…`. Replaces the spinner
// the moment the turn finishes. Anchored on `Worked for` preceded by the box-
// drawing line glyph so plain user/agent text mentioning "worked for" doesn't
// match. Acts as a positive idle signal so the transition is immediate; without
// it the adapter would return null until ticksSinceActivityChange ≥ 2, causing
// a brief running → null → idle flicker in the UI.
const POST_TURN_DIVIDER_REGEX = /^─+\s+Worked for\s/;
const HINT_LINE = "› Use /skills to list available skills";
const MODEL_STATUS_LINE_REGEX = /^\s*gpt-[^\s]+\s+.+\s+·\s+.+$/;
const USER_PROMPT_LINE_REGEX = /^›\s+\S/;
const SANDBOX_CHOICE_LINE_REGEX = /^›\s+\d+\./;
const ASSISTANT_OUTPUT_LINE_REGEX = /^•\s+\S/;

const ACTIVE_SCAN_LINES = 30;

const IDLE_STABLE_TICKS = 2;

export const CODEX_REASON_INTERRUPT = "pane:codex:interrupt";
export const CODEX_REASON_CURRENT_TURN_DIVIDER = "pane:codex:current_turn_divider";
export const CODEX_REASON_STABLE_TIMEOUT = "pane:codex:stable_timeout";
export const CODEX_REASON_SANDBOX_APPROVAL = "pane:codex:sandbox_approval";
export const CODEX_REASON_TURN_OUTPUT_ACTIVITY = "pane:codex:turn_output_activity";

function bottomLines(paneCapture: string, n: number): string[] {
  const lines = paneCapture.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function hasActiveInterruptMarker(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, ACTIVE_SCAN_LINES);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!SPINNER_LINE_PREFIX_REGEX.test(trimmed)) continue;
    if (ACTIVE_INTERRUPT_REGEX.test(trimmed) && ACTIVE_INTERRUPT_TIMER_REGEX.test(trimmed)) return true;
  }
  return false;
}

type CodexTurnSnapshot = {
  fingerprint: string;
  hasAssistantOutput: boolean;
  hasPostTurnDivider: boolean;
};

type CodexTurnProbe = {
  latest: CodexTurnSnapshot | null;
  outputChanged: boolean;
};

function trimCodexChrome(lines: string[]): string[] {
  const trimmed = [...lines];
  for (;;) {
    const last = trimmed[trimmed.length - 1];
    if (last === undefined) return trimmed;
    const normalized = last.trim();
    if (normalized === "" || normalized === HINT_LINE || MODEL_STATUS_LINE_REGEX.test(last)) {
      trimmed.pop();
      continue;
    }
    return trimmed;
  }
}

function isRealUserPromptLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === HINT_LINE) return false;
  if (SANDBOX_CHOICE_LINE_REGEX.test(trimmed)) return false;
  return USER_PROMPT_LINE_REGEX.test(trimmed);
}

function latestCodexTurnSnapshot(paneCapture: string): CodexTurnSnapshot | null {
  const lines = trimCodexChrome(paneCapture.split("\n"));
  let promptIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRealUserPromptLine(lines[i] ?? "")) {
      promptIndex = i;
      break;
    }
  }
  if (promptIndex === -1) {
    const hasPostTurnDivider = lines.some((line) => POST_TURN_DIVIDER_REGEX.test(line));
    if (!hasPostTurnDivider) return null;
    return {
      fingerprint: lines
        .map((line) => line.trimEnd())
        .join("\n")
        .trim(),
      hasAssistantOutput: false,
      hasPostTurnDivider,
    };
  }

  const turnLines = lines.slice(promptIndex);
  const responseLines = turnLines.slice(1);
  const hasAssistantOutput = responseLines.some((line) => ASSISTANT_OUTPUT_LINE_REGEX.test(line.trim()));
  const hasPostTurnDivider = responseLines.some((line) => POST_TURN_DIVIDER_REGEX.test(line));
  const fingerprint = turnLines
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return { fingerprint, hasAssistantOutput, hasPostTurnDivider };
}

function observeLatestTurn(state: CodexAdapterState, paneCapture: string, activityChanged: boolean): CodexTurnProbe {
  const previousFingerprint = state.lastCodexTurnFingerprint ?? null;
  const latest = latestCodexTurnSnapshot(paneCapture);
  state.lastCodexTurnFingerprint = latest?.fingerprint ?? null;

  const outputChanged =
    activityChanged &&
    latest !== null &&
    previousFingerprint !== null &&
    previousFingerprint !== latest.fingerprint &&
    latest.hasAssistantOutput &&
    !latest.hasPostTurnDivider;

  return { latest, outputChanged };
}

export interface CodexAdapterState extends SessionAdapterState {
  // Already inherited: ticksObserved, lastPaneHash.
  lastCodexTurnFingerprint?: string | null;
}

export const codexStatusAdapter: RuntimeStatusAdapter = {
  runtimeId: "codex",

  createSessionState(): CodexAdapterState {
    return { ticksObserved: 0, lastPaneHash: null, lastCodexTurnFingerprint: null };
  },

  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservationResult | null {
    const codexState = state as CodexAdapterState;
    codexState.ticksObserved += 1;

    const bottom = lastNonEmptyLine(ctx.paneCapture);
    const activeTimer = ctx.activeElapsedTimer ?? observeActiveElapsedTimer(state, ctx.paneCapture);
    const latestTurn = observeLatestTurn(codexState, ctx.paneCapture, ctx.tmuxActivityChangedSinceLastTick);

    // Priority 0: any runtime-visible elapsed timer that has advanced since
    // the previous capture is the cheapest positive running signal. It covers
    // Codex panes whose TUI timer moves even when tmux's activity timestamp
    // or the browser-focused terminal view lag behind.
    if (activeTimer.advanced) {
      return { observed: "running", reason: REASON_ELAPSED_TIMER };
    }

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
    if (latestTurn.latest?.hasPostTurnDivider) {
      return { observed: "idle", reason: CODEX_REASON_CURRENT_TURN_DIVIDER };
    }

    // Priority 4: current assistant turn output changed while tmux activity
    // advanced. This is narrower than "tmux activity means running": prompt
    // edits and idle TUI repaints do not change a previously observed
    // assistant-output turn fingerprint.
    if (latestTurn.outputChanged) {
      return { observed: "running", reason: CODEX_REASON_TURN_OUTPUT_ACTIVITY };
    }

    // A newly-seen active timer is not enough to prove running until it
    // advances, but it is enough to avoid the weak stable-timeout idle
    // fallback for one tick. If it stays frozen, the next tick can call it
    // stale and fall through to the normal idle heuristic.
    if (activeTimer.present && !activeTimer.stale) {
      return null;
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
