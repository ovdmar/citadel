import { describe, expect, it } from "vitest";
import { cronMatches, parseCronExpression } from "./cron.js";

describe("parseCronExpression", () => {
  it("parses wildcards, steps, lists, and ranges", () => {
    const everyMinute = parseCronExpression("* * * * *");
    expect(everyMinute.domWild).toBe(true);
    expect(everyMinute.dowWild).toBe(true);
    expect(everyMinute.minute.has(0)).toBe(true);
    expect(everyMinute.minute.has(59)).toBe(true);

    const step = parseCronExpression("*/15 * * * *");
    expect([...step.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);

    const list = parseCronExpression("0,30 9-17 * * 1-5");
    expect([...list.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(list.hour.has(9) && list.hour.has(17)).toBe(true);
    expect([...list.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(list.domWild).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow();
    expect(() => parseCronExpression("* * *")).toThrow();
    expect(() => parseCronExpression("*/0 * * * *")).toThrow();
  });

  it("matches minute floors against expressions", () => {
    const expr = parseCronExpression("30 14 * * *");
    const match = new Date(2025, 4, 22, 14, 30, 0);
    const skip = new Date(2025, 4, 22, 14, 31, 0);
    expect(cronMatches(expr, match)).toBe(true);
    expect(cronMatches(expr, skip)).toBe(false);
  });

  it("honours the cron DOM/DOW OR rule", () => {
    const expr = parseCronExpression("0 0 1 * 0");
    const firstOfMonth = new Date(2025, 0, 1, 0, 0, 0); // Wed
    const sunday = new Date(2025, 0, 5, 0, 0, 0); // Sun
    const otherDay = new Date(2025, 0, 7, 0, 0, 0); // Tue
    expect(cronMatches(expr, firstOfMonth)).toBe(true);
    expect(cronMatches(expr, sunday)).toBe(true);
    expect(cronMatches(expr, otherDay)).toBe(false);
  });
});
