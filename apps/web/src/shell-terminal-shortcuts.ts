import { isRegisteredTerminalMessageSource } from "./terminal-pane.js";
import { parseRegisteredTerminalShortcutMessage } from "./terminal-shortcut-bridge.js";
import type { VoiceModeContextValue } from "./voice-mode-provider.js";

type ShellTerminalShortcutHandlers = {
  startDictation: VoiceModeContextValue["startDictation"];
  toggleScratchpad: () => void;
};

export function handleShellTerminalShortcutMessage(
  event: MessageEvent,
  handlers: ShellTerminalShortcutHandlers,
): boolean {
  const message = parseRegisteredTerminalShortcutMessage(event, isRegisteredTerminalMessageSource);
  if (!message) return false;
  if (message.action === "scratchpad-toggle") {
    handlers.toggleScratchpad();
    return true;
  }
  if (message.action === "voice-dictation") {
    handlers.startDictation({ terminalSessionId: message.sessionId });
    return true;
  }
  return false;
}
