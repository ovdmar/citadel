import { describe, expect, it } from "vitest";
import { capabilitiesForRuntime, listRuntimeHealth, shellQuote } from "./index.js";

describe("runtime health", () => {
  it("marks available commands as healthy", () => {
    const runtimes = listRuntimeHealth([{ id: "node", displayName: "Node", command: "node", args: [] }]);

    expect(runtimes[0]?.health).toBe("healthy");
    expect(runtimes[0]?.capabilities.supportsShell).toBe(true);
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
