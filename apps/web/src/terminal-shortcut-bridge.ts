export type TerminalShortcutAction = "command-palette" | "scratchpad-toggle" | "new-workspace";

const TERMINAL_SHORTCUT_SOURCE = "citadel-terminal";
const TERMINAL_SHORTCUT_TYPE = "citadel.terminal-shortcut";

export function parseTerminalShortcutMessage(event: MessageEvent): TerminalShortcutAction | null {
  if (typeof window !== "undefined" && event.origin !== window.location.origin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.source !== TERMINAL_SHORTCUT_SOURCE || candidate.type !== TERMINAL_SHORTCUT_TYPE) return null;
  const action = candidate.action;
  return action === "command-palette" || action === "scratchpad-toggle" || action === "new-workspace" ? action : null;
}
