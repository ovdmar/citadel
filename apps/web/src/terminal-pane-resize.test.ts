// @vitest-environment happy-dom

import type { TerminalSession } from "@citadel/contracts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane, getTerminalHandle } from "./terminal-pane.js";

const xtermMocks = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    writes: string[] = [];
    focus = vi.fn();
    dispose = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => true);
    getSelection = vi.fn(() => "selected text");
    private dataHandler: ((data: string) => void) | null = null;
    private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    private selectionHandler: (() => void) | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeTerminal.instances.push(this);
    }

    loadAddon() {}
    open(host: HTMLElement) {
      host.dataset.xterm = "open";
    }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: vi.fn() };
    }
    write(data: string) {
      this.writes.push(data);
    }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    onSelectionChange(handler: () => void) {
      this.selectionHandler = handler;
      return { dispose: vi.fn() };
    }
    emitData(data: string) {
      this.dataHandler?.(data);
    }
    emitKey(event: KeyboardEvent) {
      return this.keyHandler?.(event);
    }
    emitSelectionChange() {
      this.selectionHandler?.();
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

class TerminalPaneWebSocketMock extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TerminalPaneWebSocketMock[] = [];
  readyState = TerminalPaneWebSocketMock.CONNECTING;
  binaryType = "";
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    TerminalPaneWebSocketMock.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = TerminalPaneWebSocketMock.CLOSED;
  }

  open() {
    this.readyState = TerminalPaneWebSocketMock.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  closeFromServer(code = 1006, reason = "") {
    this.readyState = TerminalPaneWebSocketMock.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    this.dispatchEvent(event);
  }
}

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

const roots: Root[] = [];
const frameCallbacks = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  installLocalStorageMock();
  xtermMocks.FakeTerminal.instances = [];
  xtermMocks.FakeFitAddon.instances = [];
  TerminalPaneWebSocketMock.instances = [];
  FakeResizeObserver.instances = [];
  frameCallbacks.clear();
  nextFrameId = 1;
  vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TerminalPaneWebSocketMock,
  });
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
  await flushReactUpdate(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("TerminalPane resize handling", () => {
  it("coalesces resize events and sends PTY resize only when rows or columns change", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const fit = xtermMocks.FakeFitAddon.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !term || !fit || !observer) throw new Error("terminal rig missing");

    await flushReactUpdate(() => ws.open());
    observer.trigger();
    window.dispatchEvent(new Event("resize"));
    observer.trigger();
    expect(fit.fit).not.toHaveBeenCalled();

    flushAnimationFrames();

    expect(fit.fit).toHaveBeenCalledTimes(1);
    expect(resizeMessages(ws)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    observer.trigger();
    window.dispatchEvent(new Event("resize"));
    flushAnimationFrames();

    expect(fit.fit).toHaveBeenCalledTimes(2);
    expect(resizeMessages(ws)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    term.cols = 100;
    term.rows = 32;
    observer.trigger();
    window.dispatchEvent(new Event("resize"));
    flushAnimationFrames();

    expect(fit.fit).toHaveBeenCalledTimes(3);
    expect(resizeMessages(ws)).toEqual([
      { type: "resize", cols: 80, rows: 24 },
      { type: "resize", cols: 100, rows: 32 },
    ]);
  });

  it("does not send invalid terminal dimensions", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !term || !observer) throw new Error("terminal rig missing");

    await flushReactUpdate(() => ws.open());

    const invalidDimensions: Array<[number, number]> = [
      [0, 24],
      [80, 0],
      [-1, 24],
      [80, -1],
      [Number.NaN, 24],
      [80, Number.POSITIVE_INFINITY],
    ];

    for (const [cols, rows] of invalidDimensions) {
      term.cols = cols;
      term.rows = rows;
      observer.trigger();
      flushAnimationFrames();
    }

    expect(resizeMessages(ws)).toEqual([]);

    term.cols = 90;
    term.rows = 30;
    observer.trigger();
    flushAnimationFrames();

    expect(resizeMessages(ws)).toEqual([{ type: "resize", cols: 90, rows: 30 }]);
  });

  it("sends the first valid resize when the WebSocket opens after an earlier fit", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !observer) throw new Error("terminal rig missing");

    observer.trigger();
    flushAnimationFrames();
    expect(resizeMessages(ws)).toEqual([]);

    await flushReactUpdate(() => ws.open());
    flushAnimationFrames();

    expect(resizeMessages(ws)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("sends the first valid resize again after reconnect", async () => {
    await renderTerminal();
    const first = TerminalPaneWebSocketMock.instances[0];
    if (!first) throw new Error("missing first ws");
    await flushReactUpdate(() => first.open());
    flushAnimationFrames();
    expect(resizeMessages(first)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    await flushReactUpdate(() => {
      getTerminalHandle("sess_1")?.reload();
    });

    const second = TerminalPaneWebSocketMock.instances[1];
    if (!second) throw new Error("missing second ws");
    await flushReactUpdate(() => second.open());
    flushAnimationFrames();

    expect(resizeMessages(second)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("cancels pending resize work on unmount", async () => {
    const root = await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const fit = xtermMocks.FakeFitAddon.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !fit || !observer) throw new Error("terminal rig missing");

    await flushReactUpdate(() => ws.open());
    observer.trigger();
    await flushReactUpdate(() => root.unmount());
    untrackRoot(root);
    flushAnimationFrames();

    expect(fit.fit).not.toHaveBeenCalled();
    expect(resizeMessages(ws)).toEqual([]);
  });

  it("ignores late WebSocket events after unmount", async () => {
    const root = await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReactUpdate(() => root.unmount());
    untrackRoot(root);
    ws.open();
    flushAnimationFrames();
    ws.message(new TextEncoder().encode("late").buffer);
    ws.closeFromServer(1006, "late");
    ws.dispatchEvent(new Event("error"));

    expect(term.writes).toEqual([]);
    expect(resizeMessages(ws)).toEqual([]);
    expect(document.body.textContent).not.toContain("terminal_disconnected");
  });
});

async function renderTerminal() {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReactUpdate(async () => {
    root.render(createElement(TerminalPane, { session: sessionFixture() }));
    await settle();
  });
  return root;
}

async function flushReactUpdate(callback: () => void | Promise<void>): Promise<void> {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

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

function resizeMessages(ws: TerminalPaneWebSocketMock): Array<{ type: string; cols: number; rows: number }> {
  return ws.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => parseJsonObject(item))
    .filter(
      (item): item is { type: string; cols: number; rows: number } =>
        item?.type === "resize" && typeof item.cols === "number" && typeof item.rows === "number",
    );
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function flushAnimationFrames() {
  const callbacks = [...frameCallbacks.entries()];
  frameCallbacks.clear();
  for (const [id, callback] of callbacks) callback(performance.now() + id);
}

function untrackRoot(root: Root) {
  const index = roots.indexOf(root);
  if (index !== -1) roots.splice(index, 1);
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
