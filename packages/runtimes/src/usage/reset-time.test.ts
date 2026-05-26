import { describe, expect, it } from "vitest";
import { parseResetTime } from "./reset-time.js";

const NOW = new Date("2026-05-26T08:00:00.000Z");

describe("parseResetTime", () => {
  it("returns null without an explicit timezone marker (strict policy)", () => {
    expect(parseResetTime("10:00", NOW)).toBeNull();
    expect(parseResetTime("21:32 on 30 May", NOW)).toBeNull();
    expect(parseResetTime("May 27, 12pm", NOW)).toBeNull();
    expect(parseResetTime("10:10am", NOW)).toBeNull();
  });

  it("resolves 24-hour clock with (UTC) to the next UTC occurrence", () => {
    // 10:00 UTC is later today (now is 08:00 UTC).
    expect(parseResetTime("10:00 (UTC)", NOW)).toBe("2026-05-26T10:00:00.000Z");
    // 07:00 UTC is earlier today → roll forward one day.
    expect(parseResetTime("07:00 (UTC)", NOW)).toBe("2026-05-27T07:00:00.000Z");
  });

  it("resolves 12-hour clock with am/pm", () => {
    expect(parseResetTime("10:10am (UTC)", NOW)).toBe("2026-05-26T10:10:00.000Z");
    expect(parseResetTime("12pm (UTC)", NOW)).toBe("2026-05-26T12:00:00.000Z");
    // 12am is midnight UTC; that's earlier than now → roll forward.
    expect(parseResetTime("12am (UTC)", NOW)).toBe("2026-05-27T00:00:00.000Z");
  });

  it("resolves month-first absolute dates (Claude-style)", () => {
    expect(parseResetTime("May 27, 12pm (UTC)", NOW)).toBe("2026-05-27T12:00:00.000Z");
    expect(parseResetTime("Jan 5, 9am (UTC)", NOW)).toBe("2027-01-05T09:00:00.000Z");
  });

  it("resolves day-first absolute dates (Codex-style)", () => {
    expect(parseResetTime("21:32 on 30 May (UTC)", NOW)).toBe("2026-05-30T21:32:00.000Z");
    expect(parseResetTime("06:47 on 31 May (UTC)", NOW)).toBe("2026-05-31T06:47:00.000Z");
  });

  it("respects (local) marker by interpreting in process local timezone", () => {
    // Verify it returns SOME ISO and doesn't crash. Exact value depends on
    // the test runner's local timezone, so just assert shape.
    const result = parseResetTime("10:00 (local)", NOW);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("returns null on unrecognized shapes even with timezone", () => {
    expect(parseResetTime("nonsense (UTC)", NOW)).toBeNull();
    expect(parseResetTime("(UTC)", NOW)).toBeNull();
    expect(parseResetTime("", NOW)).toBeNull();
    expect(parseResetTime("25:00 (UTC)", NOW)).toBeNull();
    expect(parseResetTime("13pm (UTC)", NOW)).toBeNull();
  });
});
