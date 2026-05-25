import { describe, expect, it } from "vitest";
import {
  categoryKey,
  formatLocalReset,
  formatTimeUntilReset,
  parseResetTime,
  pickTopBarCategory,
} from "./usage-format.js";

describe("categoryKey", () => {
  it("prefixes the section when present and falls back to bare label otherwise", () => {
    expect(categoryKey({ label: "5h limit", section: "GPT-5.3-Codex-Spark limit" })).toBe(
      "GPT-5.3-Codex-Spark limit/5h limit",
    );
    expect(categoryKey({ label: "Current session", section: null })).toBe("Current session");
  });
});

describe("pickTopBarCategory", () => {
  const categories = [
    { label: "Current session", percentUsed: 11, reset: null, section: null },
    { label: "Current week (all models)", percentUsed: 18, reset: null, section: null },
  ];

  it("returns the category matching the desired key", () => {
    expect(pickTopBarCategory(categories, "Current week (all models)")?.label).toBe("Current week (all models)");
  });

  it("falls back to the first category when the key is stale", () => {
    expect(pickTopBarCategory(categories, "Removed limit")?.label).toBe("Current session");
  });

  it("returns null on empty input", () => {
    expect(pickTopBarCategory([], "anything")).toBeNull();
  });
});

describe("parseResetTime", () => {
  // All assertions anchor to a fixed `now` so cross-tz CI runs are deterministic.
  const NOW_UTC = new Date(Date.UTC(2026, 4, 25, 9, 0, 0)); // 2026-05-25 09:00 UTC

  it("parses claude same-day 12-hour times in UTC and rolls past times forward a day", () => {
    const after = parseResetTime("10:10am (UTC)", NOW_UTC);
    expect(after?.toISOString()).toBe("2026-05-25T10:10:00.000Z");

    // 8am UTC is BEFORE NOW (09:00 UTC), so it should roll to tomorrow.
    const past = parseResetTime("8am (UTC)", NOW_UTC);
    expect(past?.toISOString()).toBe("2026-05-26T08:00:00.000Z");
  });

  it("parses claude dated forms like 'May 27, 12pm (UTC)'", () => {
    const at = parseResetTime("May 27, 12pm (UTC)", NOW_UTC);
    expect(at?.toISOString()).toBe("2026-05-27T12:00:00.000Z");
  });

  it("parses codex 24-hour bare times and dated forms", () => {
    expect(parseResetTime("21:32 on 30 May", NOW_UTC)?.getDate()).toBe(30);

    // 10:00 UTC is after NOW (09:00 UTC) so the same day applies — but parser
    // assumes local zone without (UTC); we still confirm a Date was returned.
    expect(parseResetTime("10:00", NOW_UTC)).toBeInstanceOf(Date);
  });

  it("returns null when the input is junk", () => {
    expect(parseResetTime("never", NOW_UTC)).toBeNull();
    expect(parseResetTime("", NOW_UTC)).toBeNull();
  });
});

describe("formatTimeUntilReset", () => {
  const NOW_UTC = new Date(Date.UTC(2026, 4, 25, 9, 0, 0));

  it("formats day-scale durations as 'Xd Yh'", () => {
    expect(formatTimeUntilReset("May 27, 9am (UTC)", NOW_UTC)).toBe("2d 0h");
    expect(formatTimeUntilReset("May 27, 12pm (UTC)", NOW_UTC)).toBe("2d 3h");
  });

  it("formats hour-scale durations as 'Xh Ym'", () => {
    expect(formatTimeUntilReset("11:30am (UTC)", NOW_UTC)).toBe("2h 30m");
  });

  it("formats sub-hour durations as 'Xm'", () => {
    expect(formatTimeUntilReset("9:34am (UTC)", NOW_UTC)).toBe("34m");
  });

  it("returns null for unparseable inputs", () => {
    expect(formatTimeUntilReset(null, NOW_UTC)).toBeNull();
    expect(formatTimeUntilReset("never", NOW_UTC)).toBeNull();
  });

  it("rolls a past same-day claude time forward by 24h", () => {
    // 8am UTC < 9am NOW → tomorrow at 8am, so 23 hours away
    expect(formatTimeUntilReset("8am (UTC)", NOW_UTC)).toBe("23h 0m");
  });
});

describe("formatLocalReset", () => {
  const NOW_UTC = new Date(Date.UTC(2026, 4, 25, 9, 0, 0));

  it("returns null for falsy input and the raw string for unparseable input", () => {
    expect(formatLocalReset(null, NOW_UTC)).toBeNull();
    expect(formatLocalReset("", NOW_UTC)).toBeNull();
    // Unparseable strings fall through verbatim so we never lose information.
    expect(formatLocalReset("sometime soon", NOW_UTC)).toBe("sometime soon");
  });

  it("formats a UTC reset using the runtime's local timezone", () => {
    // The exact rendered hour depends on the test runner's local TZ. We
    // verify the structure ("today HH:MM AM/PM") and that the literal "(UTC)"
    // is gone — operators were complaining about UTC noise.
    const out = formatLocalReset("11am (UTC)", NOW_UTC);
    expect(out).toMatch(/^today \d{1,2}:\d{2}(?: | )?(?:AM|PM)$/i);
    expect(out).not.toMatch(/UTC/i);
  });

  it("labels next-day resets as 'tomorrow' and further-out ones with a date", () => {
    // 8am UTC < 9am NOW → rolls forward to May 26 at 08:00 UTC (= tomorrow).
    const tomorrow = formatLocalReset("8am (UTC)", NOW_UTC);
    expect(tomorrow).toMatch(/^tomorrow /);

    // Two-day-out reset → not "today"/"tomorrow"; should include a date phrase.
    const later = formatLocalReset("May 27, 12pm (UTC)", NOW_UTC);
    expect(later).not.toMatch(/^(today|tomorrow) /);
    expect(later).toMatch(/\d{1,2}/);
  });
});
