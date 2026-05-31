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
    fit = vi.fn();
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMocks.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMocks.FakeFitAddon }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  installLocalStorageMock();
  xtermMocks.FakeTerminal.instances = [];
  FakeWebSocket.instances = [];
  vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
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
  await flushReact(() => {
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
    expect(xtermMocks.FakeTerminal.instances[0]?.options.scrollback).toBe(20_000);
    expect(window.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/agent-sessions/sess_1/terminal"));
    expect(getTerminalHandle("sess_1")).toBeDefined();
  });

  it("keeps retained hidden panes dormant until they become active", async () => {
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);
    const session = sessionFixture();

    await flushReact(() => {
      root.render(createElement(TerminalPane, { session, active: false }));
    });

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(0);
    expect(getTerminalHandle("sess_1")).toBeDefined();

    await flushReact(() => {
      root.render(createElement(TerminalPane, { session, active: true }));
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(1);

    await flushReact(() => {
      root.render(createElement(TerminalPane, { session, active: false }));
    });

    expect(FakeWebSocket.instances[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(xtermMocks.FakeTerminal.instances[0]?.dispose).toHaveBeenCalled();
  });

  it("writes WebSocket output to xterm and sends input/resize over the same socket", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReact(() => ws.open());
    ws.message(new TextEncoder().encode("snapshot").buffer);
    ws.message(new TextEncoder().encode("-chunk").buffer);
    term.emitData("abc");

    expect(term.writes.join("")).toBe("snapshot-chunk");
    expect(ws.sent).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(decodeBinarySent(ws.sent)).toContain("abc");
  });

  it("keeps terminal shortcuts and Ctrl+C usable in the in-process xterm", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReact(() => ws.open());
    term.emitData("\u0003");
    const commandPalette = term.emitKey(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
    );
    const multiline = term.emitKey(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }),
    );

    expect(commandPalette).toBe(false);
    expect(multiline).toBe(false);
    expect(decodeBinarySent(ws.sent)).toContain("\u0003");
    expect(ws.sent).toContain(JSON.stringify({ type: "input", data: "\n" }));
    expect(window.fetch).toHaveBeenCalledWith(
      "/api/agent-sessions/sess_1/user-action",
      expect.objectContaining({ body: JSON.stringify({ reason: "ctrl_c" }) }),
    );
  });

  it("maps command-style line editing to pane key events without relying on daemon platform", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
    await flushReact(() => ws.open());

    const killed = term.emitKey(
      new KeyboardEvent("keydown", { key: "Backspace", metaKey: true, bubbles: true, cancelable: true }),
    );
    const home = term.emitKey(
      new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, bubbles: true, cancelable: true }),
    );
    const end = term.emitKey(
      new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(killed).toBe(false);
    expect(home).toBe(false);
    expect(end).toBe(false);
    expect(ws.sent).toContain(JSON.stringify({ type: "key", key: "C-u" }));
    expect(ws.sent).toContain(JSON.stringify({ type: "key", key: "C-a" }));
    expect(ws.sent).toContain(JSON.stringify({ type: "key", key: "C-e" }));
  });

  it("uses Ctrl+Backspace as the non-Apple line-kill shortcut", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    await flushReact(() => ws.open());

    const killed = term.emitKey(
      new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(killed).toBe(false);
    expect(ws.sent).toContain(JSON.stringify({ type: "key", key: "C-u" }));
  });

  it("lets macOS Cmd+C with an xterm selection reach the browser copy event", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await flushReact(() => ws.open());

    const copied = term.emitKey(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(copied).toBe(true);
    expect(decodeBinarySent(ws.sent).join("")).not.toContain("\u0003");
  });

  it("does not cancel the native host keydown before macOS selected-text copy", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await flushReact(() => ws.open());
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(decodeBinarySent(ws.sent).join("")).not.toContain("\u0003");
  });

  it("does not turn browser-selected terminal text into a macOS Cmd+C interrupt", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !term || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");
    selectTextInside(host, "browser selected text");
    await flushReact(() => ws.open());
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(decodeBinarySent(ws.sent).join("")).not.toContain("\u0003");
  });

  it("writes xterm selection text during the browser copy event", async () => {
    await renderTerminal();
    const term = xtermMocks.FakeTerminal.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!term || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    const clipboardData = clipboardDataMock();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "selected text");
  });

  it("writes terminal selection text when the browser copy event targets the document", async () => {
    await renderTerminal();
    const clipboardData = clipboardDataMock();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "selected text");
  });

  it("sends Ctrl+C to the PTY on macOS Cmd+C when there is no xterm selection", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");
    await flushReact(() => ws.open());

    const interrupted = term.emitKey(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(interrupted).toBe(false);
    expect(decodeBinarySent(ws.sent).join("")).toContain("\u0003");
    expect(window.fetch).toHaveBeenCalledWith(
      "/api/agent-sessions/sess_1/user-action",
      expect.objectContaining({ body: JSON.stringify({ reason: "ctrl_c" }) }),
    );
  });

  it("uses the latest xterm selection snapshot when copy fires after selection text is cleared", async () => {
    await renderTerminal();
    const term = xtermMocks.FakeTerminal.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!term || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    term.getSelection.mockReturnValue("snapshot text");
    term.emitSelectionChange();
    term.getSelection.mockReturnValue("");
    const clipboardData = clipboardDataMock();
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { configurable: true, value: clipboardData });

    host.dispatchEvent(event);

    expect(clipboardData.setData).toHaveBeenCalledWith("text/plain", "snapshot text");
  });

  it("captures Shift+Enter before the browser terminal can emit a plain Enter", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    await flushReact(() => ws.open());
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
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!term) throw new Error("terminal rig missing");
    expect((term.options.theme as { background?: string }).background).toBe("#1a1814");

    await flushReact(() => {
      applyThemePreference("light");
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect((term.options.theme as { background?: string }).background).toBe("#f5f1e8");
  });

  it("shows an actionable error when the WebSocket closes", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    if (!ws) throw new Error("missing ws");

    await flushReact(() => ws.closeFromServer(1006, "lost"));

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
  await flushReact(() => {
    root.render(createElement(TerminalPane, { session: sessionFixture() }));
  });
  return root;
}

async function flushReact(action: () => void) {
  flushSync(action);
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

function decodeBinarySent(sent: unknown[]): string[] {
  return sent
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((item) => new TextDecoder().decode(item));
}

function clipboardDataMock() {
  return {
    setData: vi.fn(),
  };
}

function selectTextInside(host: HTMLElement, text: string) {
  const node = document.createTextNode(text);
  host.appendChild(node);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
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
