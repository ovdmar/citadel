import { FORWARDABLE_SHORTCUT_IDS, type ShortcutId } from "./shortcuts.js";

export type TerminalShortcutAction = ShortcutId | "scratchpad-toggle" | "new-workspace";
export type TerminalShortcutMessage = {
  action: TerminalShortcutAction;
  sessionId: string;
  index?: number;
};

const TERMINAL_SHORTCUT_SOURCE = "citadel-terminal";
const TERMINAL_SHORTCUT_TYPE = "citadel.terminal-shortcut";
const EXTRA_TERMINAL_SHORTCUT_ACTIONS = new Set<TerminalShortcutAction>(["scratchpad-toggle", "new-workspace"]);

function isTerminalShortcutAction(action: unknown): action is TerminalShortcutAction {
  if (typeof action !== "string") return false;
  return (
    FORWARDABLE_SHORTCUT_IDS.has(action as ShortcutId) ||
    EXTRA_TERMINAL_SHORTCUT_ACTIONS.has(action as TerminalShortcutAction)
  );
}

export function parseTerminalShortcutMessage(event: MessageEvent): TerminalShortcutMessage | null {
  if (typeof window !== "undefined" && event.origin !== window.location.origin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.source !== TERMINAL_SHORTCUT_SOURCE || candidate.type !== TERMINAL_SHORTCUT_TYPE) return null;
  const action = candidate.action;
  const sessionId = candidate.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (!isTerminalShortcutAction(action)) return null;
  if (candidate.index === undefined) return { action, sessionId };
  if (typeof candidate.index !== "number" || !Number.isInteger(candidate.index) || candidate.index < 0) return null;
  return { action, sessionId, index: candidate.index };
}
