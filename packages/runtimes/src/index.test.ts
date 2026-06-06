import { beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesForRuntime,
  clearRuntimeHealthProbeCache,
  listRuntimeHealth,
  probeClaudeCodeHealth,
  shellQuote,
} from "./index.js";

describe("runtime health", () => {
  beforeEach(() => {
    clearRuntimeHealthProbeCache();
  });

  it("marks available commands as healthy", () => {
    const runtimes = listRuntimeHealth([{ id: "node", displayName: "Node", command: "node", args: [] }]);

    expect(runtimes[0]?.health).toBe("healthy");
    expect(runtimes[0]?.capabilities.supportsShell).toBe(true);
  });

  it("marks missing commands as unavailable", () => {
    const runtimes = listRuntimeHealth(
      [{ id: "novel", displayName: "Novel", command: "definitely-missing-runtime", args: [] }],
      { commandExists: () => false },
    );

    expect(runtimes[0]?.health).toBe("unavailable");
    expect(runtimes[0]?.healthReason).toBe("Command not found on PATH: definitely-missing-runtime");
  });

  it("marks Claude Code unavailable when its noninteractive probe reports subscription access is disabled", () => {
    const runtimes = listRuntimeHealth(
      [{ id: "claude-code", displayName: "Claude Code", command: "claude", args: [] }],
      {
        commandExists: () => true,
        probeClaudeCode: () => ({
          health: "unavailable",
          healthReason:
            "Claude Code rejected a health probe: Your organization has disabled Claude subscription access for Claude Code",
        }),
      },
    );

    expect(runtimes[0]?.health).toBe("unavailable");
    expect(runtimes[0]?.healthReason).toContain("disabled Claude subscription access");
  });

  it("parses Claude Code JSON health probe failures as unavailable when auth or billing blocks execution", () => {
    const result = probeClaudeCodeHealth("claude", {
      runner: () => ({
        status: 1,
        stdout: JSON.stringify({
          type: "result",
          is_error: true,
          api_error_status: 403,
          result:
            "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead",
        }),
        stderr: "",
      }),
    });

    expect(result.health).toBe("unavailable");
    expect(result.healthReason).toContain("disabled Claude subscription access");
  });

  it("treats successful Claude Code JSON probe output as healthy", () => {
    const result = probeClaudeCodeHealth("claude", {
      runner: () => ({
        status: 0,
        stdout: JSON.stringify({ type: "result", is_error: false, result: "OK" }),
        stderr: "",
      }),
    });

    expect(result).toEqual({ health: "healthy", healthReason: null });
  });

  it("treats the probe's own max-budget limit as healthy because auth passed", () => {
    const result = probeClaudeCodeHealth("claude", {
      runner: () => ({
        status: 1,
        stdout: JSON.stringify({
          type: "result",
          is_error: true,
          result: "Maximum budget exceeded for this request",
        }),
        stderr: "",
      }),
    });

    expect(result).toEqual({ health: "healthy", healthReason: null });
  });

  it("quotes shell command names safely", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("differentiates capabilities per runtime id", () => {
    const claude = capabilitiesForRuntime({
      id: "claude-code",
      displayName: "Claude Code",
      command: "claude",
      args: [],
    });
    const codex = capabilitiesForRuntime({
      id: "codex",
      displayName: "Codex",
      command: "codex",
      args: [],
    });
    const unknown = capabilitiesForRuntime({
      id: "novel",
      displayName: "Novel",
      command: "novel",
      args: [],
    });
    expect(claude.supportsModelSelection).toBe(true);
    expect(claude.supportsTranscript).toBe(true);
    expect(codex.supportsModelSelection).toBe(false);
    expect(codex.supportsResume).toBe(true);
    expect(unknown.supportsPrompt).toBe(false);
  });

  it("honors operator-specified supports* overrides", () => {
    const overridden = capabilitiesForRuntime({
      id: "claude-code",
      displayName: "Claude Code",
      command: "claude",
      args: [],
      supportsModelSelection: false,
    });
    expect(overridden.supportsModelSelection).toBe(false);
  });
});
