import type { TerminalSession } from "@citadel/contracts";
import { vi } from "vitest";

export function clipboardDataMock() {
  return {
    setData: vi.fn(),
  };
}

export function selectTextInside(host: HTMLElement, text: string) {
  const node = document.createTextNode(text);
  host.appendChild(node);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function sessionFixture(): TerminalSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "running",
    transport: "connected",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}
