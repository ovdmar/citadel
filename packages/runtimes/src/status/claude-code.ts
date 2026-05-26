import {
  type ObservationContext,
  type PaneObservation,
  type RuntimeStatusAdapter,
  type SessionAdapterState,
  observeIdle,
  observeRunning,
  observeWaitingForInput,
} from "./index.js";

// Claude Code v2.1.x detection (verified 2026-05-25 against v2.1.133).
//
// Detection anchors:
//   - Prompt footer: line beginning with `Enter to <verb>` and ending with
//     `Esc to cancel`. Covers both the AskUserQuestion picker
//     (`Enter to select · <nav hint> · Esc to cancel` — middle hint has shipped
//     as `↑/↓ to navigate` and `Tab/Arrow keys to navigate`) and the free-text
//     confirm variant (`Enter to confirm · Esc to cancel`, used when the user
//     picks "Type something" or for plain text prompts). Anchored on the stable
//     endpoints with an optional `·`-separated middle so future verbs/hints
//     still classify as waiting. Scanned over the last ~12 visible lines.
//   - Mode line: the bottommost line whose trimmed form starts with `⏵⏵`.
//     This is the unique prefix of Claude Code's mode-line widget. Subagent
//     management panels and other widgets can render BELOW the mode line, so
//     "last non-empty line" alone is not enough.
//
// See `packages/runtimes/src/fixtures/claude-code/*.txt` for the empirical
// captures these regexes were calibrated against.

// Prompt footer — `Enter to <verb> [· <hint>]* · Esc to cancel`. Endpoints
// fixed, middle segments float. The `·` separator is U+00B7 (middle dot).
const PROMPT_FOOTER_REGEX = /^Enter to \S+(?:\s+·\s+.+?)*\s+·\s+Esc to cancel$/;

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

// Server-side rate-limit error surfaced as a tool-result block by Claude Code,
// distinct from the per-account usage limit. Empirical line:
//   `⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited`
// When this is visible AND the mode line shows no active turn, the agent is
// stalled waiting for the server to relent. Scan a wider window than chrome
// because the error is body content above the mode line (and the long
// `✻ Cogitated for Xm Ys` spinner often sits between them).
const RATE_LIMIT_SUBSTRING = "API Error: Server is temporarily limiting requests (not your usage limit)";
const RATE_LIMIT_SCAN_LINES = 40;

function hasServerRateLimitError(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, RATE_LIMIT_SCAN_LINES);
  for (const line of lines) {
    if (line.includes(RATE_LIMIT_SUBSTRING)) return true;
  }
  return false;
}

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

// Find any line whose trimmed form matches the prompt footer shape
// (`Enter to <verb> [· …] · Esc to cancel`).
function hasPromptFooter(paneCapture: string): boolean {
  const lines = bottomLines(paneCapture, CHROME_SCAN_LINES);
  for (const line of lines) {
    if (PROMPT_FOOTER_REGEX.test(line.trim())) return true;
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

    // Priority 1: prompt footer (AskUserQuestion picker or free-text confirm)
    // — replaces the normal mode line.
    if (hasPromptFooter(ctx.paneCapture)) {
      return observeWaitingForInput();
    }

    const modeLine = findModeLine(ctx.paneCapture);
    if (modeLine === null) {
      // No mode line visible — TUI may still be initializing, or the runtime
      // has changed UI. Don't fabricate a status.
      return null;
    }

    // Priority 2: active turn (with or without background work).
    if (modeLine.includes(ESC_TO_INTERRUPT_SUBSTRING)) {
      return observeRunning();
    }

    // Priority 3: background work without an active main turn — still alive.
    if (BACKGROUND_WORK_REGEX.test(modeLine)) {
      return observeRunning();
    }

    // Priority 4: server-side rate limit visible AND no active turn. Active
    // turn (priority 2) already wins because Claude Code's internal retries
    // re-arm `esc to interrupt` while they're in flight; we only flag
    // rate_limited when the agent has actually stalled (mode line back to
    // idle/baseline but the error is still on screen). Server-side stalls
    // carry resetAt=null — the auto-resume scheduler only fires for
    // sessions with a known reset (usage-quota limits, follow-up PR).
    if (hasServerRateLimitError(ctx.paneCapture)) {
      return { kind: "rate_limited", resetAt: null };
    }

    // Priority 5: idle. The auto-mode prefix is present, and (by virtue of
    // priorities 2/3 not having matched) there's no active-turn marker and no
    // background-work suffix. Covers both the bare idle line and the
    // "tasks panel still on screen after Ctrl+C" variant
    // (`<prefix> · ctrl+t to hide tasks`).
    if (modeLine.startsWith(IDLE_MODE_LINE_PREFIX)) {
      return observeIdle();
    }

    // Mode line present but unmatched — runtime UI drift. No opinion.
    return null;
  },

  // Stateless rate-limit detection. Returns the parsed reset time when a
  // rate-limit banner is visible in the pane (or null resetAt when the banner
  // text is present but unparseable / no known reset window). Returns null
  // overall when no banner is visible.
  //
  // Currently detects only the server-side transient stall (no reset time).
  // The usage-quota detection with parsed reset time depends on real captures
  // and lands in a follow-up PR — see the plan's "Scope contingency" section.
  detectRateLimit(paneCapture: string): { resetAt: string | null } | null {
    if (hasServerRateLimitError(paneCapture)) {
      return { resetAt: null };
    }
    return null;
  },
};
