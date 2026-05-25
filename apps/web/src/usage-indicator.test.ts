import type { RuntimeUsageSummary } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { usagePillNeedsReload } from "./usage-indicator.js";

function makeSummary(overrides: Partial<RuntimeUsageSummary> = {}): RuntimeUsageSummary {
  return {
    runtimeId: "claude-code",
    providerId: "usage-claude-code",
    source: "claude-code-runtime",
    status: "healthy",
    reason: null,
    categories: [{ label: "Prompts", percentUsed: 12, reset: null, section: null }],
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("usagePillNeedsReload", () => {
  it("returns true when summary is undefined (loading or never fetched)", () => {
    expect(usagePillNeedsReload(undefined)).toBe(true);
  });

  it("returns true when status is degraded", () => {
    expect(usagePillNeedsReload(makeSummary({ status: "degraded", reason: "auth required" }))).toBe(true);
  });

  it("returns true when status is unavailable", () => {
    expect(usagePillNeedsReload(makeSummary({ status: "unavailable" }))).toBe(true);
  });

  it("returns true when categories is empty even on a healthy summary", () => {
    expect(usagePillNeedsReload(makeSummary({ categories: [] }))).toBe(true);
  });

  it("returns false on a healthy summary with at least one category", () => {
    expect(usagePillNeedsReload(makeSummary())).toBe(false);
  });
});
