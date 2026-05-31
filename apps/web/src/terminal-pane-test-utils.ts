import type { AgentSession } from "@citadel/contracts";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { vi } from "vitest";

export const FakeWebSocket = class TerminalPaneFakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TerminalPaneFakeWebSocket[] = [];
  readyState = TerminalPaneFakeWebSocket.CONNECTING;
  binaryType = "";
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    TerminalPaneFakeWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = TerminalPaneFakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = TerminalPaneFakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  closeFromServer(code = 1006, reason = "") {
    this.readyState = TerminalPaneFakeWebSocket.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    this.dispatchEvent(event);
  }
};

export const roots: Root[] = [];

const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

export class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

export function installAnimationFrameMock() {
  frameCallbacks.clear();
  nextFrameId = 1;
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      frameCallbacks.set(id, callback);
      return id;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: vi.fn((id: number) => frameCallbacks.delete(id)),
  });
}

export async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

export const flushReact = async (callback: () => void | Promise<void>) => {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
};

export function installLocalStorageMock() {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
}

export function decodeBinarySent(sent: unknown[]): string[] {
  return sent
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((item) => new TextDecoder().decode(item));
}

export function resizeMessages(
  ws: InstanceType<typeof FakeWebSocket>,
): Array<{ type: string; cols: number; rows: number }> {
  return ws.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => parseJsonObject(item))
    .filter(
      (item): item is { type: string; cols: number; rows: number } =>
        item?.type === "resize" && typeof item.cols === "number" && typeof item.rows === "number",
    );
}

export function flushAnimationFrames() {
  const callbacks = [...frameCallbacks.entries()];
  frameCallbacks.clear();
  for (const [id, callback] of callbacks) callback(performance.now() + id);
}

export function untrackRoot(root: Root) {
  const index = roots.indexOf(root);
  if (index !== -1) roots.splice(index, 1);
}

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

export function sessionFixture(): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "shell",
    displayName: "Terminal",
    status: "idle",
    transport: "connected",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
