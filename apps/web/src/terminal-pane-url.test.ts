// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { parseTerminalSocketMessage, terminalWebSocketUrl } from "./terminal-pane.js";

describe("terminal URL helpers", () => {
  it("builds the primary WebSocket URL", () => {
    const location = { protocol: "https:", host: "citadel.example" } as Location;

    expect(terminalWebSocketUrl("sess 1", location)).toBe("wss://citadel.example/terminal/sess%201");
  });

  it("parses terminal socket messages defensively", () => {
    expect(parseTerminalSocketMessage(JSON.stringify({ type: "output", data: "ok" }))).toEqual({
      type: "output",
      data: "ok",
    });
    expect(parseTerminalSocketMessage("not-json")).toBeNull();
    expect(parseTerminalSocketMessage({ type: "output" })).toBeNull();
  });
});
