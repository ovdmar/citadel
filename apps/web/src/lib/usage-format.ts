import type { RuntimeUsageCategory } from "@citadel/contracts";

// Stable identifier for a usage category. claude-code labels are unique on
// their own; codex repeats "5h limit" / "Weekly limit" across sections, so we
// prefix with the section. Section-less rows use the bare label.
export function categoryKey(category: { label: string; section: string | null }): string {
  return category.section ? `${category.section}/${category.label}` : category.label;
}

// Pick the category targeted by the operator's "show in top bar" choice.
// Falls back to the first category if the saved key no longer matches any
// row (provider renamed something, model lineup changed, etc).
export function pickTopBarCategory(
  categories: RuntimeUsageCategory[],
  desiredKey: string | undefined,
): RuntimeUsageCategory | null {
  if (categories.length === 0) return null;
  if (desiredKey) {
    const match = categories.find((category) => categoryKey(category) === desiredKey);
    if (match) return match;
  }
  return categories[0] ?? null;
}

// Parse a usage reset string and return the absolute Date the limit resets,
// or null if the string was unparseable. Handles both shapes we see today:
//
//   claude-code:  "10:10am (UTC)" · "11am (UTC)" · "May 27, 12pm (UTC)"
//   codex:        "10:00" · "21:32 on 30 May"
//
// The "(UTC)" marker is load-bearing — without it we assume the local zone.
// When the parsed time is in the past for "today", we roll forward one day
// (claude same-day resets) or to next year (codex "on 30 May" once that date
// has passed). Whole-year inference is best-effort; if a provider ever ships
// a real ISO timestamp we should switch to that.
export function parseResetTime(input: string, now: Date = new Date()): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // UTC flag is the only timezone we recognize; everything else assumes the
  // operator's local zone (matches v1 behavior and what users expect on
  // single-host installs).
  const utcMatch = trimmed.match(/\(\s*UTC\s*\)\s*$/i);
  const isUtc = Boolean(utcMatch);
  const stripped = isUtc ? trimmed.slice(0, utcMatch?.index ?? trimmed.length).trim() : trimmed;

  // "21:32 on 30 May" — codex's dated 24-hour form.
  const codexDated = stripped.match(/^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]+)$/);
  if (codexDated) {
    const [, hh, mm, day, monthName] = codexDated;
    const month = monthIndex(monthName ?? "");
    if (month === null) return null;
    return buildAt(now, {
      year: null,
      month,
      day: Number.parseInt(day ?? "", 10),
      hour: Number.parseInt(hh ?? "", 10),
      minute: Number.parseInt(mm ?? "", 10),
      utc: isUtc,
    });
  }

  // "May 27, 12pm" / "May 27, 12:30am" — claude's dated 12-hour form.
  const claudeDated = stripped.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (claudeDated) {
    const [, monthName, day, hh, mm, meridiem] = claudeDated;
    const month = monthIndex(monthName ?? "");
    if (month === null) return null;
    const hour = to24Hour(Number.parseInt(hh ?? "", 10), meridiem ?? "");
    return buildAt(now, {
      year: null,
      month,
      day: Number.parseInt(day ?? "", 10),
      hour,
      minute: mm ? Number.parseInt(mm, 10) : 0,
      utc: isUtc,
    });
  }

  // "10:10am" / "11am" / "12:30 pm" — claude's same-day 12-hour form.
  const claudeTime = stripped.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (claudeTime) {
    const [, hh, mm, meridiem] = claudeTime;
    const hour = to24Hour(Number.parseInt(hh ?? "", 10), meridiem ?? "");
    return buildAt(now, {
      year: null,
      month: null,
      day: null,
      hour,
      minute: mm ? Number.parseInt(mm, 10) : 0,
      utc: isUtc,
      rollForwardIfPast: true,
    });
  }

  // "10:00" / "21:32" — codex's bare 24-hour same-day form.
  const codexTime = stripped.match(/^(\d{1,2}):(\d{2})$/);
  if (codexTime) {
    const [, hh, mm] = codexTime;
    return buildAt(now, {
      year: null,
      month: null,
      day: null,
      hour: Number.parseInt(hh ?? "", 10),
      minute: Number.parseInt(mm ?? "", 10),
      utc: isUtc,
      rollForwardIfPast: true,
    });
  }

  return null;
}

// Compact two-unit duration: "4d 3h" · "12h 34m" · "34m" · "now".
// Designed for the top-bar pill — never wider than ~6 chars in practice.
export function formatTimeUntilReset(reset: string | null | undefined, now: Date = new Date()): string | null {
  if (!reset) return null;
  const at = parseResetTime(reset, now);
  if (!at) return null;
  const diffMs = at.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 24 * 60) / 60);
  const minutes = totalMinutes - days * 24 * 60 - hours * 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function monthIndex(name: string): number | null {
  const normalized = name.trim().slice(0, 3).toLowerCase();
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const index = months.indexOf(normalized);
  return index === -1 ? null : index;
}

function to24Hour(hour12: number, meridiem: string): number {
  const lower = meridiem.toLowerCase();
  if (lower === "am") return hour12 === 12 ? 0 : hour12;
  if (lower === "pm") return hour12 === 12 ? 12 : hour12 + 12;
  return hour12;
}

type BuildSpec = {
  year: number | null;
  month: number | null;
  day: number | null;
  hour: number;
  minute: number;
  utc: boolean;
  rollForwardIfPast?: boolean;
};

function buildAt(now: Date, spec: BuildSpec): Date | null {
  if (!Number.isFinite(spec.hour) || !Number.isFinite(spec.minute)) return null;
  const year = spec.year ?? (spec.utc ? now.getUTCFullYear() : now.getFullYear());
  const month = spec.month ?? (spec.utc ? now.getUTCMonth() : now.getMonth());
  const day = spec.day ?? (spec.utc ? now.getUTCDate() : now.getDate());
  const date = spec.utc
    ? new Date(Date.UTC(year, month, day, spec.hour, spec.minute, 0, 0))
    : new Date(year, month, day, spec.hour, spec.minute, 0, 0);

  // Same-day forms ("10:00", "11am") that have already elapsed today
  // implicitly mean "tomorrow" — claude-code's session window cycles daily
  // and codex's 5h limit can land in the morning even after midnight.
  if (spec.rollForwardIfPast && date.getTime() <= now.getTime()) {
    date.setDate(date.getDate() + 1);
  }
  // Dated forms without an explicit year ("on 30 May") that have already
  // passed must roll forward to next year.
  if (!spec.rollForwardIfPast && spec.year === null && spec.day !== null && date.getTime() <= now.getTime()) {
    if (spec.utc) date.setUTCFullYear(date.getUTCFullYear() + 1);
    else date.setFullYear(date.getFullYear() + 1);
  }
  return date;
}
