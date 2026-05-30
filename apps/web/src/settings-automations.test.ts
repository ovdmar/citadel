import type { AgentRuntime } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { buildAutomationRuntimeChoices } from "./settings-automations.js";

function runtime(id: string, health: AgentRuntime["health"]): AgentRuntime {
  return {
    id,
    displayName: id,
    command: id,
    args: [],
    health,
    healthReason: health === "healthy" ? null : `${id} is unavailable`,
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

describe("buildAutomationRuntimeChoices", () => {
  it("lists configured agent runtimes with current health and excludes shell", () => {
    const choices = buildAutomationRuntimeChoices(
      [
        { id: "claude-code", displayName: "Claude Code", command: "claude", args: [] },
        { id: "codex", displayName: "Codex", command: "codex", args: [] },
        { id: "shell", displayName: "Shell", command: "bash", args: ["-l"] },
      ],
      [runtime("claude-code", "unavailable"), runtime("codex", "healthy"), runtime("shell", "healthy")],
    );

    expect(choices).toEqual([
      expect.objectContaining({ id: "claude-code", health: "unavailable" }),
      expect.objectContaining({ id: "codex", health: "healthy" }),
    ]);
  });
});
