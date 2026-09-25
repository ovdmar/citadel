// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  parseRegisteredTerminalShortcutMessage,
  parseTerminalShortcutMessage,
  terminalShortcutMatch,
} from "./terminal-shortcut-bridge.js";

describe("parseTerminalShortcutMessage", () => {
  it("accepts known terminal shortcut messages from the current origin", () => {
    const event = new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        source: "citadel-terminal",
        type: "citadel.terminal-shortcut",
        action: "command-palette",
        sessionId: "sess_1",
      },
    });

    expect(parseTerminalShortcutMessage(event)).toEqual({ action: "command-palette", sessionId: "sess_1" });
  });

  it("accepts canonical indexed shortcut messages from the current origin", () => {
    const event = new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        source: "citadel-terminal",
        type: "citadel.terminal-shortcut",
        action: "nav-workspace",
        sessionId: "sess_1",
        index: 2,
      },
    });

    expect(parseTerminalShortcutMessage(event)).toEqual({ action: "nav-workspace", sessionId: "sess_1", index: 2 });
  });

  it("accepts terminal-origin voice dictation messages", () => {
    const event = new MessageEvent("message", {
      origin: window.location.origin,
      data: {
        source: "citadel-terminal",
        type: "citadel.terminal-shortcut",
        action: "voice-dictation",
        sessionId: "sess_1",
      },
    });

    expect(parseTerminalShortcutMessage(event)).toEqual({ action: "voice-dictation", sessionId: "sess_1" });
  });

  it("rejects wrong origins, sources, and actions", () => {
    expect(
      parseTerminalShortcutMessage(
        new MessageEvent("message", {
          origin: "https://example.com",
          data: { source: "citadel-terminal", type: "citadel.terminal-shortcut", action: "command-palette" },
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalShortcutMessage(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { source: "other", type: "citadel.terminal-shortcut", action: "command-palette" },
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalShortcutMessage(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { source: "citadel-terminal", type: "citadel.terminal-shortcut", action: "unknown" },
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalShortcutMessage(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: { source: "citadel-terminal", type: "citadel.terminal-shortcut", action: "command-palette" },
        }),
      ),
    ).toBeNull();
    expect(
      parseTerminalShortcutMessage(
        new MessageEvent("message", {
          origin: window.location.origin,
          data: {
            source: "citadel-terminal",
            type: "citadel.terminal-shortcut",
            action: "nav-workspace",
            sessionId: "sess_1",
            index: -1,
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("parseRegisteredTerminalShortcutMessage", () => {
  it("accepts parsed messages whose session source is registered", () => {
    const event = terminalMessage("voice-dictation", "sess_1");

    expect(parseRegisteredTerminalShortcutMessage(event, (_source, sessionId) => sessionId === "sess_1")).toEqual({
      action: "voice-dictation",
      sessionId: "sess_1",
    });
  });

  it("rejects parsed messages whose session source is not registered", () => {
    const event = terminalMessage("voice-dictation", "sess_1");

    expect(parseRegisteredTerminalShortcutMessage(event, () => false)).toBeNull();
  });
});

describe("terminalShortcutMatch", () => {
  it("maps canonical terminal messages back to cockpit shortcut matches", () => {
    expect(terminalShortcutMatch({ action: "command-palette", sessionId: "sess_1" })?.id).toBe("command-palette");
    expect(terminalShortcutMatch({ action: "nav-workspace", sessionId: "sess_1", index: 2 })).toMatchObject({
      id: "nav-workspace",
      index: 2,
    });
  });

  it("ignores messages that are terminal-only or missing their required index", () => {
    expect(terminalShortcutMatch({ action: "new-workspace", sessionId: "sess_1" })).toBeNull();
    expect(terminalShortcutMatch({ action: "voice-dictation", sessionId: "sess_1" })).toBeNull();
    expect(terminalShortcutMatch({ action: "nav-workspace", sessionId: "sess_1" })).toBeNull();
  });
});

function terminalMessage(action: "command-palette" | "voice-dictation", sessionId: string): MessageEvent {
  return new MessageEvent("message", {
    origin: window.location.origin,
    data: {
      source: "citadel-terminal",
      type: "citadel.terminal-shortcut",
      action,
      sessionId,
    },
  });
}
