import type { AgentRuntime, RuntimeUsageSummary } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { resolveUsagePillState, selectTopBarUsageRuntimes, usagePillNeedsReload } from "./usage-indicator.js";

function runtime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    args: [],
    health: "healthy",
    healthReason: null,
    capabilities: {
      supportsPrompt: true,
      supportsResume: true,
      supportsModelSelection: true,
      supportsTranscript: true,
      supportsStatusDetection: true,
      supportsNonInteractiveGoal: true,
      supportsShell: true,
      supportsUsage: true,
      supportsTui: true,
    },
    ...overrides,
  };
}

function usage(overrides: Partial<RuntimeUsageSummary> = {}): RuntimeUsageSummary {
  return {
    runtimeId: "claude-code",
    providerId: "usage-unavailable",
    source: "health-gate",
    status: "unavailable",
    reason: "Claude Code rejected a health probe: subscription disabled",
    categories: [],
    checkedAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("top-bar usage runtime selection", () => {
  it("keeps opted-in unhealthy usage runtimes visible so usage can report why unavailable", () => {
    const selected = selectTopBarUsageRuntimes(
      [
        runtime({
          health: "unavailable",
          healthReason: "Claude Code rejected a health probe: subscription disabled",
        }),
      ],
      [{ id: "claude-code", showUsageInTopBar: true }],
    );

    expect(selected.map((entry) => entry.runtime.id)).toEqual(["claude-code"]);
  });

  it("still excludes runtimes without usage support", () => {
    const selected = selectTopBarUsageRuntimes(
      [runtime({ id: "aider", capabilities: { ...runtime().capabilities, supportsUsage: false } })],
      [{ id: "aider", showUsageInTopBar: true }],
    );

    expect(selected).toEqual([]);
  });
});

describe("usagePillNeedsReload", () => {
  it("returns true when summary is undefined", () => {
    expect(usagePillNeedsReload(undefined)).toBe(true);
  });

  it("returns true when status is degraded", () => {
    expect(usagePillNeedsReload(usage({ status: "degraded", reason: "auth required" }))).toBe(true);
  });

  it("returns true when status is unavailable", () => {
    expect(usagePillNeedsReload(usage({ status: "unavailable" }))).toBe(true);
  });

  it("returns true when categories are empty even on a healthy summary", () => {
    expect(usagePillNeedsReload(usage({ status: "healthy", reason: null, categories: [] }))).toBe(true);
  });

  it("returns false on a healthy summary with at least one category", () => {
    expect(
      usagePillNeedsReload(
        usage({
          status: "healthy",
          reason: null,
          categories: [{ label: "Prompts", percentUsed: 12, reset: null, section: null }],
        }),
      ),
    ).toBe(false);
  });
});

describe("usage pill state", () => {
  it("renders an unavailable runtime as a red off pill before usage loads", () => {
    const state = resolveUsagePillState(
      runtime({
        health: "unavailable",
        healthReason: "Claude Code rejected a health probe: subscription disabled",
      }),
      undefined,
      undefined,
    );

    expect(state.tone).toBe("unavailable");
    expect(state.value).toBe("off");
    expect(state.tooltip).toContain("subscription disabled");
  });

  it("renders an unavailable usage summary as off even when runtime health was initially healthy", () => {
    const state = resolveUsagePillState(runtime(), usage(), undefined);

    expect(state.tone).toBe("unavailable");
    expect(state.value).toBe("off");
    expect(state.tooltip).toContain("subscription disabled");
  });
});
