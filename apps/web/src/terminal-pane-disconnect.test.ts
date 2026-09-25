// @vitest-environment happy-dom

import type { TerminalSession } from "@citadel/contracts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./terminal-pane.js";

const xtermMocks = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];
    focus = vi.fn();
    dispose = vi.fn();
    refresh = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => true);
    getSelection = vi.fn(() => "selected text");

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }

    loadAddon() {}
    open(host: HTMLElement) {
      host.dataset.xterm = "open";
    }
    onData() {
      return { dispose: vi.fn() };
    }
    write(data: string | Uint8Array) {
      this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    attachCustomKeyEventHandler() {}
    onSelectionChange() {
      return { dispose: vi.fn() };
    }
  }

  class FakeFitAddon {
    static instances: FakeFitAddon[] = [];
    fit = vi.fn();

    constructor() {
      FakeFitAddon.instances.push(this);
    }
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMocks.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMocks.FakeFitAddon }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FakeWebSocket = class TerminalPaneDisconnectFakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TerminalPaneDisconnectFakeWebSocket[] = [];
  readyState = TerminalPaneDisconnectFakeWebSocket.CONNECTING;
  binaryType = "";

  constructor(readonly url: string) {
    super();
    TerminalPaneDisconnectFakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = TerminalPaneDisconnectFakeWebSocket.CLOSED;
  }

  closeFromServer(code = 1006, reason = "") {
    this.readyState = TerminalPaneDisconnectFakeWebSocket.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    this.dispatchEvent(event);
  }
};

const roots: Root[] = [];
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

class FakeResizeObserver {
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

beforeEach(() => {
  document.body.innerHTML = "";
  installLocalStorageMock();
  xtermMocks.FakeTerminal.instances = [];
  xtermMocks.FakeFitAddon.instances = [];
  FakeWebSocket.instances = [];
  FakeResizeObserver.instances = [];
  frameCallbacks.clear();
  nextFrameId = 1;
  vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });
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
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("TerminalPane disconnect handling", () => {
  it("shows an actionable error when the WebSocket closes", async () => {
    await renderTerminal();

    await flushReact(() => FakeWebSocket.instances[0]?.closeFromServer(1006, "lost"));

    expect(document.body.textContent).toContain("terminal_disconnected");
    expect(document.body.textContent).toContain("lost");
    expect((document.querySelector("button") as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it("auto-retries disconnected terminal sockets up to three times with 5s backoff", async () => {
    vi.useFakeTimers();
    await renderTerminal();

    await flushReact(() => FakeWebSocket.instances[0]?.closeFromServer(1006, "lost"));
    expect(FakeWebSocket.instances).toHaveLength(1);

    await flushReact(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    await flushReact(() => {
      vi.advanceTimersByTime(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    await flushReact(() => FakeWebSocket.instances[1]?.closeFromServer(1006, "still lost"));
    await flushReact(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);

    await flushReact(() => FakeWebSocket.instances[2]?.closeFromServer(1006, "still lost"));
    await flushReact(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);

    await flushReact(() => FakeWebSocket.instances[3]?.closeFromServer(1006, "exhausted"));
    await flushReact(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(document.body.textContent).toContain("terminal_disconnected");
    expect(document.body.textContent).toContain("exhausted");
  });

  it("reconnects immediately on page resume when the terminal socket already closed", async () => {
    await renderTerminal();

    const ws = FakeWebSocket.instances[0];
    if (!ws) throw new Error("terminal websocket missing");
    ws.readyState = FakeWebSocket.CLOSED;

    await flushReact(() => {
      window.dispatchEvent(new Event("pageshow"));
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("bypasses pending retry backoff on page resume after a disconnect", async () => {
    vi.useFakeTimers();
    await renderTerminal();

    await flushReact(() => FakeWebSocket.instances[0]?.closeFromServer(1006, "lost"));
    expect(FakeWebSocket.instances).toHaveLength(1);

    await flushReact(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(FakeWebSocket.instances).toHaveLength(2);
    await flushReact(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

async function renderTerminal() {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(createElement(TerminalPane, { session: sessionFixture() }));
  });
  return root;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

const flushReact = async (callback: () => void | Promise<void>) => {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
};

function installLocalStorageMock() {
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

function sessionFixture(): TerminalSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "idle",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}
