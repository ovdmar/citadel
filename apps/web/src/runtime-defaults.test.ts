import type { AgentRuntime } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { defaultAgentRuntimeId } from "./runtime-defaults.js";

const shell: AgentRuntime = {
  id: "shell",
  displayName: "Shell",
  command: "bash",
  args: ["-l"],
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
};

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
    const runtimes = [healthy("codex"), healthy("claude-code"), shell];
    expect(defaultAgentRuntimeId(runtimes)).toBe("claude-code");
  });

  it("falls back to the first healthy non-shell runtime when claude-code is missing", () => {
    const runtimes = [shell, healthy("codex"), healthy("cursor-agent")];
    expect(defaultAgentRuntimeId(runtimes)).toBe("codex");
  });

  it("returns empty string when only the shell runtime is healthy", () => {
    const runtimes = [shell];
    expect(defaultAgentRuntimeId(runtimes)).toBe("");
  });

  it("returns empty string when the runtimes list is empty", () => {
    expect(defaultAgentRuntimeId([])).toBe("");
  });

  it("skips unhealthy runtimes including claude-code if unhealthy", () => {
    const runtimes = [healthy("claude-code", { health: "unavailable" }), healthy("codex"), shell];
    expect(defaultAgentRuntimeId(runtimes)).toBe("codex");
  });
});
