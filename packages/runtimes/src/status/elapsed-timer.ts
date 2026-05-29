import type { SessionAdapterState } from "./index.js";

const ACTIVE_TIMER_SCAN_LINES = 30;
const DURATION_TOKEN_REGEX = /(\d+)\s*([hms])/gi;
const PAREN_DURATION_REGEX = /\(([^)]*\d+\s*[hms][^)]*)\)/i;
const ACTIVE_TIMER_HINT_REGEX =
  /(?:\b(?:working|thinking|reasoning|cogitat(?:ing|ed)|pondering|processing|running|executing)\b|…|\.{3}|esc\s+(?:to|for)\s+interrupt|[↑↓]\s*\d+\s+tokens)/i;

export const REASON_ELAPSED_TIMER = "pane:active:elapsed_timer";

type ActiveElapsedTimerSnapshot = {
  seconds: number;
  signature: string;
};

export type ActiveElapsedTimerProbe = {
  present: boolean;
  advanced: boolean;
  stale: boolean;
};

export interface ActiveElapsedTimerSessionState extends SessionAdapterState {
  lastActiveElapsedTimer?: ActiveElapsedTimerSnapshot | null;
}

function bottomLines(paneCapture: string, n: number): string[] {
  const lines = paneCapture.split("\n");
  return lines.slice(Math.max(0, lines.length - n));
}

function durationToSeconds(text: string): number | null {
  let total = 0;
  let matched = false;
  for (const match of text.matchAll(DURATION_TOKEN_REGEX)) {
    const amount = Number.parseInt(match[1] ?? "", 10);
    const unit = (match[2] ?? "").toLowerCase();
    if (!Number.isFinite(amount)) continue;
    matched = true;
    if (unit === "h") total += amount * 60 * 60;
    if (unit === "m") total += amount * 60;
    if (unit === "s") total += amount;
  }
  return matched ? total : null;
}

function normalizeTimerLine(line: string): string {
  return line
    .trim()
    .replace(/^[•◦·✻]\s*/, "timer ")
    .replace(/\(([^)]*\d+\s*[hms][^)]*)\)/i, "(#)")
    .replace(/[•◦]/g, "bullet")
    .replace(/\s+/g, " ");
}

function findActiveElapsedTimer(paneCapture: string): ActiveElapsedTimerSnapshot | null {
  const lines = bottomLines(paneCapture, ACTIVE_TIMER_SCAN_LINES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!ACTIVE_TIMER_HINT_REGEX.test(line)) continue;
    const durationMatch = PAREN_DURATION_REGEX.exec(line);
    if (!durationMatch) continue;
    const seconds = durationToSeconds(durationMatch[1] ?? "");
    if (seconds === null) continue;
    return { seconds, signature: normalizeTimerLine(line) };
  }
  return null;
}

export function observeActiveElapsedTimer(state: SessionAdapterState, paneCapture: string): ActiveElapsedTimerProbe {
  const stateWithTimer = state as ActiveElapsedTimerSessionState;
  const previous = stateWithTimer.lastActiveElapsedTimer ?? null;
  const current = findActiveElapsedTimer(paneCapture);
  stateWithTimer.lastActiveElapsedTimer = current;

  if (current === null) return { present: false, advanced: false, stale: false };
  if (previous === null || previous.signature !== current.signature) {
    return { present: true, advanced: false, stale: false };
  }
  if (current.seconds > previous.seconds) return { present: true, advanced: true, stale: false };
  return { present: true, advanced: false, stale: current.seconds === previous.seconds };
}
