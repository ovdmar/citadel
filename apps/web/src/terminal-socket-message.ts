import type { TerminalPaneKey } from "./terminal-pane.js";

export type TerminalSocketMessage = {
  type?: string;
  data?: string;
  key?: TerminalPaneKey;
  lines?: number;
};

export function parseTerminalSocketMessage(raw: unknown): TerminalSocketMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as TerminalSocketMessage;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
