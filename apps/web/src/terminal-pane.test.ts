import { describe, expect, it } from "vitest";
import { focusActiveTerminal, getTerminalHandle } from "./terminal-pane.js";

describe("focusActiveTerminal", () => {
  it("is a no-op when sessionId is null", () => {
    // Session-less workspace (lifecycle="creating" or no agent started yet).
    // Must not throw, must not access any registry entry.
    expect(() => focusActiveTerminal(null)).not.toThrow();
    expect(() => focusActiveTerminal(undefined)).not.toThrow();
  });

  it("is a no-op when no handle is registered for the sessionId", () => {
    // Active session id stored but its TerminalPane hasn't mounted yet
    // (e.g. cockpit just navigated to the workspace, pane is still being
    // built). Must not throw — we tolerate the lookup miss.
    expect(getTerminalHandle("unknown-session")).toBeUndefined();
    expect(() => focusActiveTerminal("unknown-session")).not.toThrow();
  });
});
