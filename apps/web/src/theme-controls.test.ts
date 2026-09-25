import { describe, expect, it } from "vitest";
import { CYCLE, STORAGE_KEY, describe as describeTheme, nextInCycle, normalize } from "./theme-controls.js";

describe("theme controls helpers", () => {
  describe("normalize", () => {
    it("accepts the three valid settings", () => {
      expect(normalize("light")).toBe("light");
      expect(normalize("dark")).toBe("dark");
      expect(normalize("system")).toBe("system");
    });

    it("falls back to 'system' for null (no value persisted yet)", () => {
      expect(normalize(null)).toBe("system");
    });

    it("rejects unknown values and falls back to 'system' (stale or hand-edited storage)", () => {
      expect(normalize("midnight")).toBe("system");
      expect(normalize("")).toBe("system");
      expect(normalize("LIGHT")).toBe("system"); // case-sensitive on purpose — matches what we write
    });
  });

  describe("nextInCycle", () => {
    it("cycles Light → Dark → System → Light", () => {
      expect(nextInCycle("light")).toBe("dark");
      expect(nextInCycle("dark")).toBe("system");
      expect(nextInCycle("system")).toBe("light");
    });

    it("returns each state exactly once across one full cycle", () => {
      const start = CYCLE[0] ?? "system";
      const visited = new Set<string>();
      let current = start;
      for (let i = 0; i < CYCLE.length; i += 1) {
        visited.add(current);
        current = nextInCycle(current);
      }
      expect(visited).toEqual(new Set(CYCLE));
      expect(current).toBe(start); // full loop
    });
  });

  describe("describe", () => {
    it("yields user-facing labels suitable for tooltips and aria-label", () => {
      expect(describeTheme("light")).toBe("Light");
      expect(describeTheme("dark")).toBe("Dark");
      expect(describeTheme("system")).toBe("System");
    });
  });

  it("pins the localStorage key so a future rename is a deliberate change, not a silent migration", () => {
    expect(STORAGE_KEY).toBe("citadel.theme");
  });
});
