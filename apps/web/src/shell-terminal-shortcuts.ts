import { isRegisteredTerminalMessageSource } from "./terminal-pane.js";
import { parseTerminalShortcutMessage } from "./terminal-shortcut-bridge.js";
import type { VoiceModeContextValue } from "./voice-mode-provider.js";

type ShellTerminalShortcutHandlers = {
  startDictation: VoiceModeContextValue["startDictation"];
  toggleScratchpad: () => void;
};

export function handleShellTerminalShortcutMessage(
  event: MessageEvent,
  handlers: ShellTerminalShortcutHandlers,
): boolean {
  const message = parseTerminalShortcutMessage(event);
  if (!message || !isRegisteredTerminalMessageSource(event.source, message.sessionId)) return false;
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
