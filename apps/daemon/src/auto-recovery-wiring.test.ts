import { type CitadelConfig, DEFAULT_FIX_CI_AUTOMATION } from "@citadel/config";
import type { AgentRuntime } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { resolveAutoRecoveryRuntimeId } from "./auto-recovery-wiring.js";

function config(overrides: Partial<CitadelConfig["automations"]["fixCi"]> = {}): CitadelConfig {
  return {
    version: 1,
    dataDir: "/tmp/fake",
    databasePath: "/tmp/fake/db",
    bindHost: "127.0.0.1",
    port: 4010,
    mcp: { enabled: true },
    providers: {
      github: { enabled: false, command: "gh" },
      jira: { enabled: false, command: "jtk", autoTransitions: [] },
    },
    agentRuntimes: [
      { id: "claude-code", displayName: "Claude Code", command: "claude", args: [] },
      { id: "codex", displayName: "Codex", command: "codex", args: [] },
    ],
    agentSessions: { baseSystemPrompt: "" },
    terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    usageProviders: [],
    automations: { fixCi: { ...DEFAULT_FIX_CI_AUTOMATION, ...overrides } },
    repoDefaults: { setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] },
    hooks: [],
    commandPolicy: { hookTimeoutMs: 120_000, allowDestructiveWorkspaceCleanup: false },
    providerRefresh: {
      enabled: true,
      workingHours: { startHour: 9, endHour: 18, weekdaysOnly: true },
      intervals: { prCiMs: 60_000, jiraMs: 5 * 60_000, usageMs: 5 * 60_000 },
      focusRefreshThresholdMs: 30_000,
      maxConcurrentRefreshes: 4,
    },
    scratchpad: {},
  };
}

function runtime(id: string, health: AgentRuntime["health"], command = id): AgentRuntime {
  return {
    id,
    displayName: id,
    command,
    args: [],
    health,
    healthReason: health === "healthy" ? null : `${id} unavailable`,
    capabilities: {
      supportsPrompt: true,
      supportsResume: false,
      supportsModelSelection: false,
      supportsTranscript: false,
      supportsStatusDetection: true,
      supportsNonInteractiveGoal: true,
      supportsShell: true,
      supportsUsage: false,
      supportsTui: true,
    },
  };
}

describe("resolveAutoRecoveryRuntimeId", () => {
  it("uses the configured primary runtime when healthy", () => {
    expect(
      resolveAutoRecoveryRuntimeId(config(), [runtime("claude-code", "healthy"), runtime("codex", "healthy")]),
    ).toBe("claude-code");
  });

  it("falls back to the configured fallback runtime when the primary is not healthy", () => {
    expect(
      resolveAutoRecoveryRuntimeId(config(), [runtime("claude-code", "unavailable"), runtime("codex", "healthy")]),
    ).toBe("codex");
  });

  it("returns null when neither configured automation runtime is healthy", () => {
    expect(
      resolveAutoRecoveryRuntimeId(config(), [runtime("claude-code", "unavailable"), runtime("codex", "degraded")]),
    ).toBeNull();
  });

  it("honors an explicit no-fallback configuration", () => {
    expect(
      resolveAutoRecoveryRuntimeId(config({ fallbackRuntimeId: null }), [
        runtime("claude-code", "unavailable"),
        runtime("codex", "healthy"),
      ]),
    ).toBeNull();
  });

  it("skips healthy shell-like runtimes and falls back to an actual agent runtime", () => {
    expect(
      resolveAutoRecoveryRuntimeId(config({ runtimeId: "bash-debug", fallbackRuntimeId: "codex" }), [
        runtime("bash-debug", "healthy", "/usr/bin/bash"),
        runtime("codex", "healthy", "codex"),
      ]),
    ).toBe("codex");
  });
});
