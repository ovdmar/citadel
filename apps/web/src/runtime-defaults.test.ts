import type { AgentRuntime } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { defaultAgentRuntimeId } from "./runtime-defaults.js";

const healthy = (id: string, overrides: Partial<AgentRuntime> = {}): AgentRuntime => ({
  id,
  displayName: id,
  command: id,
  args: [],
  health: "healthy",
  healthReason: null,
  capabilities: {
    supportsPrompt: true,
    supportsResume: false,
    supportsModelSelection: false,
    supportsTranscript: false,
    supportsStatusDetection: false,
    supportsNonInteractiveGoal: false,
    supportsShell: true,
    supportsUsage: false,
    supportsTui: false,
  },
  ...overrides,
});

describe("defaultAgentRuntimeId", () => {
  it("prefers claude-code when present and healthy", () => {
    const runtimes = [healthy("codex"), healthy("claude-code")];
    expect(defaultAgentRuntimeId(runtimes)).toBe("claude-code");
  });

  it("falls back to the first healthy runtime when claude-code is missing", () => {
    const runtimes = [healthy("codex"), healthy("cursor-agent")];
    expect(defaultAgentRuntimeId(runtimes)).toBe("codex");
  });

  it("returns empty string when no runtime is healthy", () => {
    const runtimes = [healthy("codex", { health: "unavailable" })];
    expect(defaultAgentRuntimeId(runtimes)).toBe("");
  });

  it("returns empty string when the runtimes list is empty", () => {
    expect(defaultAgentRuntimeId([])).toBe("");
  });

  it("skips unhealthy runtimes including claude-code if unhealthy", () => {
    const runtimes = [healthy("claude-code", { health: "unavailable" }), healthy("codex")];
    expect(defaultAgentRuntimeId(runtimes)).toBe("codex");
  });
});
