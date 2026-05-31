// @vitest-environment happy-dom

import type { AgentSession } from "@citadel/contracts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalPane,
  focusActiveTerminal,
  getTerminalHandle,
  isRegisteredTerminalMessageSource,
  parseTerminalSocketMessage,
  terminalWebSocketUrl,
} from "./terminal-pane.js";
import { applyThemePreference } from "./use-resolved-theme.js";

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
    getSelection = vi.fn(() => "selected text");
    private dataHandler: ((data: string) => void) | null = null;
    private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;

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
    emitData(data: string) {
      this.dataHandler?.(data);
    }
    emitKey(event: KeyboardEvent) {
      return this.keyHandler?.(event);
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

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "";
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  closeFromServer(code = 1006, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    Object.defineProperty(event, "reason", { value: reason });
    this.dispatchEvent(event);
  }
}

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
  document.documentElement.removeAttribute("data-theme");
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
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("focusActiveTerminal", () => {
  it("is a no-op when sessionId is null", () => {
    expect(() => focusActiveTerminal(null)).not.toThrow();
    expect(() => focusActiveTerminal(undefined)).not.toThrow();
  });

  it("is a no-op when no handle is registered for the sessionId", () => {
    expect(getTerminalHandle("unknown-session")).toBeUndefined();
    expect(() => focusActiveTerminal("unknown-session")).not.toThrow();
  });

  it("accepts terminal bridge messages by registered session id when the frame source identity is unavailable", async () => {
    await renderTerminal();

    expect(getTerminalHandle("sess_1")).toBeDefined();
    expect(isRegisteredTerminalMessageSource(null, "sess_1")).toBe(true);
    expect(isRegisteredTerminalMessageSource(null, "unknown-session")).toBe(false);
  });

  it("focuses the registered xterm instance", async () => {
    await renderTerminal();

    focusActiveTerminal("sess_1");

    expect(xtermMocks.FakeTerminal.instances[0]?.focus).toHaveBeenCalled();
  });
});

describe("TerminalPane xterm WebSocket renderer", () => {
  it("opens the primary /terminal WebSocket without hitting the legacy terminal ensure endpoint", async () => {
    await renderTerminal();

    expect(FakeWebSocket.instances[0]?.url).toBe(terminalWebSocketUrl("sess_1"));
    expect(window.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/agent-sessions/sess_1/terminal"));
    expect(getTerminalHandle("sess_1")).toBeDefined();
  });

  it("creates an opaque xterm renderer", async () => {
    await renderTerminal();

    expect(xtermMocks.FakeTerminal.instances[0]?.options).toEqual(
      expect.objectContaining({
        allowTransparency: false,
        theme: expect.objectContaining({ background: "#f5f1e8" }),
      }),
    );
  });

  it("keeps retained hidden panes dormant until they become active", async () => {
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);
    const session = sessionFixture();

    await act(async () => {
      root.render(createElement(TerminalPane, { session, active: false }));
      await settle();
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(0);
    expect(getTerminalHandle("sess_1")).toBeDefined();

    await act(async () => {
      root.render(createElement(TerminalPane, { session, active: true }));
      await settle();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(1);

    await act(async () => {
      root.render(createElement(TerminalPane, { session, active: false }));
      await settle();
    });

    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(xtermMocks.FakeTerminal.instances[0]?.dispose).toHaveBeenCalled();
  });

  it("writes WebSocket output to xterm and sends input/resize over the same socket", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await act(async () => ws.open());
    flushAnimationFrames();
    ws.message(new TextEncoder().encode("snapshot").buffer);
    ws.message(new TextEncoder().encode("-chunk").buffer);
    term.emitData("abc");

    expect(term.writes.join("")).toBe("snapshot-chunk");
    expect(ws.sent).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(decodeBinarySent(ws.sent)).toContain("abc");
  });

  it("coalesces resize events and sends PTY resize only when rows or columns change", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const fit = xtermMocks.FakeFitAddon.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !term || !fit || !observer) throw new Error("terminal rig missing");

    await act(async () => ws.open());
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
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !term || !observer) throw new Error("terminal rig missing");

    await act(async () => ws.open());

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
    const ws = FakeWebSocket.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !observer) throw new Error("terminal rig missing");

    observer.trigger();
    flushAnimationFrames();
    expect(resizeMessages(ws)).toEqual([]);

    await act(async () => ws.open());
    flushAnimationFrames();

    expect(resizeMessages(ws)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("sends the first valid resize again after reconnect", async () => {
    const root = await renderTerminal();
    const first = FakeWebSocket.instances[0];
    if (!first) throw new Error("missing first ws");
    await act(async () => first.open());
    flushAnimationFrames();
    expect(resizeMessages(first)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);

    await act(async () => {
      getTerminalHandle("sess_1")?.reload();
      await settle();
    });

    const second = FakeWebSocket.instances[1];
    if (!second) throw new Error("missing second ws");
    await act(async () => second.open());
    flushAnimationFrames();

    expect(resizeMessages(second)).toEqual([{ type: "resize", cols: 80, rows: 24 }]);
  });

  it("cancels pending resize work on unmount", async () => {
    const root = await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const fit = xtermMocks.FakeFitAddon.instances[0];
    const observer = FakeResizeObserver.instances[0];
    if (!ws || !fit || !observer) throw new Error("terminal rig missing");

    await act(async () => ws.open());
    observer.trigger();
    await act(async () => root.unmount());
    untrackRoot(root);
    flushAnimationFrames();

    expect(fit.fit).not.toHaveBeenCalled();
    expect(resizeMessages(ws)).toEqual([]);
  });

  it("ignores late WebSocket events after unmount", async () => {
    const root = await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await act(async () => root.unmount());
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

  it("keeps raw input, control/meta shortcuts, paste, and Ctrl+C usable in the in-process xterm", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await act(async () => ws.open());
    term.emitData("\u0003");
    term.emitData("abc");
    const commandPalette = term.emitKey(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
    const multiline = term.emitKey(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { readText: vi.fn().mockResolvedValue("pasted text") },
    });
    const paste = term.emitKey(
      new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }),
    );
    await settle();

    expect(commandPalette).toBe(false);
    expect(multiline).toBe(false);
    expect(paste).toBe(false);
    expect(decodeBinarySent(ws.sent)).toContain("\u0003");
    expect(decodeBinarySent(ws.sent)).toContain("abc");
    expect(decodeBinarySent(ws.sent)).toContain("pasted text");
    expect(ws.sent).toContain(JSON.stringify({ type: "input", data: "\n" }));
    expect(window.fetch).toHaveBeenCalledWith(
      "/api/agent-sessions/sess_1/user-action",
      expect.objectContaining({ body: JSON.stringify({ reason: "ctrl_c" }) }),
    );
  });

  it("captures Shift+Enter before the browser terminal can emit a plain Enter", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    await act(async () => ws.open());
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    const downstream = vi.fn();
    host.addEventListener("keydown", downstream);

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(ws.sent).toContain(JSON.stringify({ type: "input", data: "\n" }));
  });

  it("does not reconnect the terminal when the resolved theme changes", async () => {
    applyThemePreference("dark");
    await renderTerminal();
    expect(FakeWebSocket.instances).toHaveLength(1);

    await act(async () => {
      applyThemePreference("light");
      await settle();
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("shows an actionable error when the WebSocket closes", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    if (!ws) throw new Error("missing ws");

    await act(async () => ws.closeFromServer(1006, "lost"));

    expect(document.body.textContent).toContain("terminal_disconnected");
    expect(document.body.textContent).toContain("lost");
  });
});

describe("terminal URL helpers", () => {
  it("builds the primary WebSocket URL", () => {
    const location = { protocol: "https:", host: "citadel.example" } as Location;

    expect(terminalWebSocketUrl("sess 1", location)).toBe("wss://citadel.example/terminal/sess%201");
  });

  it("parses terminal socket messages defensively", () => {
    expect(parseTerminalSocketMessage(JSON.stringify({ type: "output", data: "ok" }))).toEqual({
      type: "output",
      data: "ok",
    });
    expect(parseTerminalSocketMessage("not-json")).toBeNull();
    expect(parseTerminalSocketMessage({ type: "output" })).toBeNull();
  });
});

async function renderTerminal() {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await act(async () => {
    root.render(createElement(TerminalPane, { session: sessionFixture() }));
    await settle();
  });
  return root;
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

function decodeBinarySent(sent: unknown[]): string[] {
  return sent
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((item) => new TextDecoder().decode(item));
}

function resizeMessages(ws: FakeWebSocket): Array<{ type: string; cols: number; rows: number }> {
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

function sessionFixture(): AgentSession {
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
