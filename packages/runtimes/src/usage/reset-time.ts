// Shared parser for the "resets at X" strings emitted by Claude Code's
// /usage panel and Codex's /status panel. The parser is INTENTIONALLY strict:
// without an explicit timezone marker (UTC/GMT/local) the input is ambiguous
// and we return null. The scheduler maps null → "unknown_reset" and does NOT
// schedule a resumption — auto-resume degrades to manual.
//
// Accepted shapes (case-insensitive):
//   "10:10am (UTC)"          → next UTC occurrence after `now`
//   "10:00 (UTC)"            → next UTC occurrence after `now`
//   "May 27, 12pm (UTC)"     → absolute UTC moment of next May 27 at 12pm
//   "21:32 on 30 May (UTC)"  → absolute UTC moment of next 30 May at 21:32
//   "10:10am (local)"        → interpreted in the Node process's local timezone
// Without `(UTC)`, `(GMT)`, or `(local)`: return null.

type Tz = "utc" | "local";

// Strip a trailing timezone marker like "(UTC)" / "(GMT)" / "(local)".
// Returns the cleaned text + the timezone, or null when no marker is present.
function extractTimezone(text: string): { cleaned: string; tz: Tz } | null {
  const trimmed = text.trim();
  const match = trimmed.match(/^(.*?)\s*\((utc|gmt|local)\)\s*$/i);
  if (!match) return null;
  const tz: Tz = match[2]?.toLowerCase() === "local" ? "local" : "utc";
  return { cleaned: (match[1] ?? "").trim(), tz };
}

// Parse a clock string like "10:10am", "21:32", "12pm" into {hour, minute}.
// Returns null on unparseable input.
function parseClock(text: string): { hour: number; minute: number } | null {
  // 12-hour with am/pm marker.
  const ampm = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (ampm) {
    let hour = Number.parseInt(ampm[1] ?? "", 10);
    const minute = ampm[2] ? Number.parseInt(ampm[2], 10) : 0;
    const meridiem = (ampm[3] ?? "").toLowerCase();
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12 || minute < 0 || minute > 59) {
      return null;
    }
    if (meridiem === "am" && hour === 12) hour = 0;
    else if (meridiem === "pm" && hour !== 12) hour += 12;
    return { hour, minute };
  }
  // 24-hour clock.
  const hm = text.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const hour = Number.parseInt(hm[1] ?? "", 10);
    const minute = Number.parseInt(hm[2] ?? "", 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      return null;
    }
    return { hour, minute };
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

// Resolve {hour, minute} to the NEXT UTC occurrence after `now`. Used for
// time-of-day-only inputs with (UTC) or (local) markers.
function nextOccurrence(now: Date, hour: number, minute: number, tz: Tz): Date {
  if (tz === "utc") {
    const candidate = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0),
    );
    if (candidate.getTime() <= now.getTime()) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate;
  }
  // local
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

// Try to parse "<month> <day>, <clock>" shape (Claude-style absolute).
function parseAbsoluteMonthFirst(
  text: string,
  now: Date,
  tz: Tz,
): Date | null {
  const match = text.match(/^([A-Za-z]+)\s+(\d{1,2})\s*,\s*(.+)$/);
  if (!match) return null;
  const monthKey = (match[1] ?? "").toLowerCase();
  const day = Number.parseInt(match[2] ?? "", 10);
  const monthIdx = MONTHS[monthKey];
  if (monthIdx === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null;
  const clock = parseClock((match[3] ?? "").trim());
  if (!clock) return null;
  // Year: next occurrence of (month, day, clock) after now. Start with current
  // year; if the result is in the past, roll to next year.
  return resolveAbsolute(now, monthIdx, day, clock.hour, clock.minute, tz);
}

// Try to parse "<clock> on <day> <month>" shape (Codex-style absolute).
function parseAbsoluteDayFirst(
  text: string,
  now: Date,
  tz: Tz,
): Date | null {
  const match = text.match(/^(.+?)\s+on\s+(\d{1,2})\s+([A-Za-z]+)$/i);
  if (!match) return null;
  const clock = parseClock((match[1] ?? "").trim());
  const day = Number.parseInt(match[2] ?? "", 10);
  const monthKey = (match[3] ?? "").toLowerCase();
  const monthIdx = MONTHS[monthKey];
  if (!clock || monthIdx === undefined || !Number.isFinite(day) || day < 1 || day > 31) return null;
  return resolveAbsolute(now, monthIdx, day, clock.hour, clock.minute, tz);
}

function resolveAbsolute(
  now: Date,
  monthIdx: number,
  day: number,
  hour: number,
  minute: number,
  tz: Tz,
): Date {
  if (tz === "utc") {
    let year = now.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, monthIdx, day, hour, minute, 0, 0));
    if (candidate.getTime() <= now.getTime()) {
      year += 1;
      candidate = new Date(Date.UTC(year, monthIdx, day, hour, minute, 0, 0));
    }
    return candidate;
  }
  let year = now.getFullYear();
  let candidate = new Date(year, monthIdx, day, hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    year += 1;
    candidate = new Date(year, monthIdx, day, hour, minute, 0, 0);
  }
  return candidate;
}

/**
 * Parse a runtime-emitted "reset" string into an ISO timestamp.
 *
 * Returns null on:
 *   - missing timezone marker (ambiguous)
 *   - unrecognized shape
 */
export function parseResetTime(text: string, now: Date): string | null {
  const tz = extractTimezone(text);
  if (!tz) return null; // strict policy — no marker, no parse
  const cleaned = tz.cleaned;
  if (!cleaned) return null;
  // Absolute month-day-first ("May 27, 12pm").
  const absMonthFirst = parseAbsoluteMonthFirst(cleaned, now, tz.tz);
  if (absMonthFirst) return absMonthFirst.toISOString();
  // Absolute day-month ("21:32 on 30 May").
  const absDayFirst = parseAbsoluteDayFirst(cleaned, now, tz.tz);
  if (absDayFirst) return absDayFirst.toISOString();
  // Plain clock — "10:00" / "10:10am". Resolve to next occurrence.
  const clock = parseClock(cleaned);
  if (clock) return nextOccurrence(now, clock.hour, clock.minute, tz.tz).toISOString();
  return null;
}
