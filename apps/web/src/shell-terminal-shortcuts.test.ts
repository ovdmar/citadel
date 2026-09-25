// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleShellTerminalShortcutMessage } from "./shell-terminal-shortcuts.js";
import { isRegisteredTerminalMessageSource } from "./terminal-pane.js";

vi.mock("./terminal-pane.js", () => ({
  isRegisteredTerminalMessageSource: vi.fn(),
}));

const isRegistered = vi.mocked(isRegisteredTerminalMessageSource);

describe("handleShellTerminalShortcutMessage", () => {
  beforeEach(() => {
    isRegistered.mockReturnValue(true);
  });

  it("starts dictation for registered terminal voice shortcut messages", () => {
    const startDictation = vi.fn(() => true);
    const handled = handleShellTerminalShortcutMessage(terminalMessage("voice-dictation", "sess_1"), {
      startDictation,
      toggleScratchpad: vi.fn(),
    });

    expect(handled).toBe(true);
    expect(startDictation).toHaveBeenCalledWith({ terminalSessionId: "sess_1" });
  });

  it("toggles scratchpad for registered terminal scratchpad messages", () => {
    const toggleScratchpad = vi.fn();
    const handled = handleShellTerminalShortcutMessage(terminalMessage("scratchpad-toggle", "sess_1"), {
      startDictation: vi.fn(() => true),
      toggleScratchpad,
    });

    expect(handled).toBe(true);
    expect(toggleScratchpad).toHaveBeenCalled();
  });

  it("ignores messages from unregistered terminal sessions", () => {
    isRegistered.mockReturnValue(false);
    const startDictation = vi.fn(() => true);
    const handled = handleShellTerminalShortcutMessage(terminalMessage("voice-dictation", "closed"), {
      startDictation,
      toggleScratchpad: vi.fn(),
    });

    expect(handled).toBe(false);
    expect(startDictation).not.toHaveBeenCalled();
  });
});

function terminalMessage(action: "scratchpad-toggle" | "voice-dictation", sessionId: string): MessageEvent {
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
