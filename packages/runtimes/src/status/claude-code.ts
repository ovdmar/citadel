import type { ObservationContext, PaneObservation, RuntimeStatusAdapter, SessionAdapterState } from "./index.js";

// Claude Code v2.1.x detection (verified 2026-05-25 against v2.1.133).
//
// Detection anchors:
//   - AskUserQuestion: footer line beginning with `Enter to select` and ending
//     with `Esc to cancel`, separated by a navigation hint. Claude Code has
//     shipped at least two phrasings of that middle segment (`↑/↓ to navigate`
//     in older builds, `Tab/Arrow keys to navigate` in newer ones), so we
//     anchor on the stable endpoints and let the middle float. Scanned over
//     the last ~12 visible lines (the question UI sits between separators and
//     may have rows below it, but the footer is unique enough that whole-window
//     scan is safe).
//   - Mode line: the bottommost line whose trimmed form starts with `⏵⏵`.
//     This is the unique prefix of Claude Code's mode-line widget. Subagent
//     management panels and other widgets can render BELOW the mode line, so
//     "last non-empty line" alone is not enough.
//
// See `packages/runtimes/src/fixtures/claude-code/*.txt` for the empirical
// captures these regexes were calibrated against.

// AskUserQuestion footer — endpoints fixed, navigation hint floats across
// Claude Code releases. The `·` separator is U+00B7 (middle dot).
const ASK_USER_QUESTION_FOOTER_REGEX = /^Enter to select\s+·\s+.+?\s+·\s+Esc to cancel$/;

// Mode-line prefix — distinctive unicode glyph pair, very unlikely to appear
// in agent output body.
const MODE_LINE_PREFIX = "⏵⏵";

// "esc to interrupt" as a substring of the mode line. May co-occur with bg.
const ESC_TO_INTERRUPT_SUBSTRING = " esc to interrupt";

// Background work suffix on the mode line when the main turn ended but
// Monitor / background-Bash / subagent (Task) are still alive.
const BACKGROUND_WORK_REGEX = /·\s+\d+\s+(monitor|shell|local agent)\s+·\s+↓\s+to manage/;

// Bare idle mode line — exactly this string after trim.
const IDLE_MODE_LINE = "⏵⏵ auto mode on (shift+tab to cycle)";

// Post-interrupt suffix: Claude Code keeps the task panel chrome visible
// after Ctrl+C if tasks were on screen. The mode line then reads
// `<IDLE_MODE_LINE> · ctrl+t to hide tasks` with NO `esc to interrupt`.
// We treat anything that starts with IDLE_MODE_LINE and has no active-turn
// or background-work indicator as idle (see priority-4 below).
const IDLE_MODE_LINE_PREFIX = IDLE_MODE_LINE;

// How many bottom lines to scan for chrome anchors. Subagent panels add a few
// rows below the mode line; the AskUserQuestion UI has a similar footprint.
const CHROME_SCAN_LINES = 12;

function bottomLines(paneCapture: string, n: number): string[] {
  const lines = paneCapture.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

// Find the bottommost line whose trimmed form starts with the mode-line prefix.
// Returns the trimmed line, or null if no mode line is visible in the scan window.
function findModeLine(paneCapture: string): string | null {
  const lines = bottomLines(paneCapture, CHROME_SCAN_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed.startsWith(MODE_LINE_PREFIX)) return trimmed;
  }
  return null;
}

// Find any line whose trimmed form matches the AskUserQuestion footer shape.
function hasAskUserQuestionFooter(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, CHROME_SCAN_LINES);
  for (const line of lines) {
    if (ASK_USER_QUESTION_FOOTER_REGEX.test(line.trim())) return true;
  }
  return false;
}

export const claudeCodeStatusAdapter: RuntimeStatusAdapter = {
  runtimeId: "claude-code",

  createSessionState(): SessionAdapterState {
    return { ticksObserved: 0, lastPaneHash: null };
  },

  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservation | null {
    state.ticksObserved += 1;

    // Priority 1: AskUserQuestion footer — replaces the normal mode line.
    if (hasAskUserQuestionFooter(ctx.paneCapture)) {
      return "waiting_for_input";
    }

    const modeLine = findModeLine(ctx.paneCapture);
    if (modeLine === null) {
      // No mode line visible — TUI may still be initializing, or the runtime
      // has changed UI. Don't fabricate a status.
      return null;
    }

    // Priority 2: active turn (with or without background work).
    if (modeLine.includes(ESC_TO_INTERRUPT_SUBSTRING)) {
      return "running";
    }

    // Priority 3: background work without an active main turn — still alive.
    if (BACKGROUND_WORK_REGEX.test(modeLine)) {
      return "running";
    }

    // Priority 4: idle. The auto-mode prefix is present, and (by virtue of
    // priorities 2/3 not having matched) there's no active-turn marker and no
    // background-work suffix. Covers both the bare idle line and the
    // "tasks panel still on screen after Ctrl+C" variant
    // (`<prefix> · ctrl+t to hide tasks`).
    if (modeLine.startsWith(IDLE_MODE_LINE_PREFIX)) {
      return "idle";
    }

    // Mode line present but unmatched — runtime UI drift. No opinion.
    return null;
  },
};
