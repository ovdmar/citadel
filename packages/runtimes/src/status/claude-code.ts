import type { ObservationContext, PaneObservationResult, RuntimeStatusAdapter, SessionAdapterState } from "./index.js";

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

// Account-wide usage-limit banner. Empirical line:
//   `⎿  You're out of extra usage · resets 7:50am (UTC)`
// followed by `/extra-usage to finish what you're working on.`. The agent
// can't progress until the reset time elapses (or the operator buys extra
// usage). We surface this as `usage_limited` with the parsed reset timestamp
// in statusReason so the auto-resume loop can wait it out globally rather
// than burning per-session backoff attempts that the API will reject anyway.
const USAGE_LIMIT_SUBSTRING = "You're out of extra usage";
const USAGE_LIMIT_RESET_REGEX = /resets\s+(\d{1,2}):(\d{2})(am|pm)\s+\(([A-Z]{2,5})\)/;

export interface UsageLimitDetection {
  // Parsed reset moment as ISO 8601. Always UTC; null when the banner is
  // visible but the time string didn't parse (unknown tz, malformed digits).
  resetAt: string | null;
}

// Exported for testing and for the auto-resume loop's `isAccountRateLimited`
// hook to call directly off any cached pane capture if it needs to.
export function parseUsageLimitReset(line: string, now: Date): string | null {
  const m = USAGE_LIMIT_RESET_REGEX.exec(line);
  if (!m) return null;
  const [, hh, mm, ampm, tz] = m;
  // Only UTC is handled deterministically — other zones would need a tz
  // database to resolve correctly across DST and we'd rather null-out than
  // silently drift by an hour. Banner is empirically always UTC.
  if (tz !== "UTC") return null;
  let hour = Number.parseInt(hh ?? "", 10) % 12;
  if (ampm === "pm") hour += 12;
  const minute = Number.parseInt(mm ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0));
  // If the named time has already passed today, the reset is tomorrow.
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

function detectUsageLimit(paneCapture: string, now: Date): UsageLimitDetection | null {
  const lines = bottomLines(paneCapture, RATE_LIMIT_SCAN_LINES);
  for (const line of lines) {
    if (!line.includes(USAGE_LIMIT_SUBSTRING)) continue;
    return { resetAt: parseUsageLimitReset(line, now) };
  }
  return null;
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

  observe(state: SessionAdapterState, ctx: ObservationContext): PaneObservationResult | null {
    state.ticksObserved += 1;

    // Priority 1: prompt footer (AskUserQuestion picker or free-text confirm)
    // — replaces the normal mode line.
    if (hasPromptFooter(ctx.paneCapture)) {
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

    // Priority 4: account-wide usage limit. Distinct from rate_limited — the
    // agent is out of plan credits until a known wall-clock reset moment. We
    // encode the parsed reset in statusReason so the auto-resume loop can
    // postpone ALL resumes (per-session and account-global) until reset.
    const usageLimit = detectUsageLimit(ctx.paneCapture, (ctx.now ?? (() => new Date()))());
    if (usageLimit !== null) {
      const reason =
        usageLimit.resetAt !== null
          ? `pane:usage_limited:reset=${usageLimit.resetAt}`
          : "pane:usage_limited:reset=unknown";
      return { observed: "usage_limited", reason };
    }

    // Priority 5: server-side rate limit visible AND no active turn. Active
    // turn (priority 2) already wins because Claude Code's internal retries
    // re-arm `esc to interrupt` while they're in flight; we only flag
    // rate_limited when the agent has actually stalled (mode line back to
    // idle/baseline but the error is still on screen).
    if (hasServerRateLimitError(ctx.paneCapture)) {
      return "rate_limited";
    }

    // Priority 6: idle. The auto-mode prefix is present, and (by virtue of
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
