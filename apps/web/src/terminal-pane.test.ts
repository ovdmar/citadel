// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboardDataMock, selectTextInside, sessionFixture } from "./terminal-pane-test-helpers.js";
import {
  TerminalPane,
  focusActiveTerminal,
  getTerminalHandle,
  isRegisteredTerminalMessageSource,
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

const roots: Root[] = [];

async function flushReactUpdate(callback: () => void | Promise<void>): Promise<void> {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  (window as Window & { __citadelOverlayOpen?: number }).__citadelOverlayOpen = 0;
  installLocalStorageMock();
  xtermMocks.FakeTerminal.instances = [];
  xtermMocks.FakeFitAddon.instances = [];
  TerminalPaneWebSocketMock.instances = [];
  vi.spyOn(window, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: TerminalPaneWebSocketMock,
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
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
  await flushReactUpdate(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
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

    expect(TerminalPaneWebSocketMock.instances[0]?.url).toBe(terminalWebSocketUrl("sess_1"));
    expect(xtermMocks.FakeTerminal.instances[0]?.options.scrollback).toBe(20_000);
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

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: false }));
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(0);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(0);
    expect(getTerminalHandle("sess_1")).toBeDefined();

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: true }));
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(1);

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: false }));
    });

    expect(TerminalPaneWebSocketMock.instances[0]?.readyState).toBe(TerminalPaneWebSocketMock.CLOSED);
    expect(xtermMocks.FakeTerminal.instances[0]?.dispose).toHaveBeenCalled();
  });

  it("writes WebSocket output to xterm and sends input over the same socket", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReactUpdate(async () => ws.open());
    ws.message(new TextEncoder().encode("snapshot").buffer);
    ws.message(new TextEncoder().encode("-chunk").buffer);
    term.emitData("abc");

    expect(term.writes.join("")).toBe("snapshot-chunk");
    expect(decodeBinarySent(ws.sent)).toContain("abc");
  });

  it("keeps raw input, control/meta shortcuts, paste, and Ctrl+C usable in the in-process xterm", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReactUpdate(async () => ws.open());
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

  it("forwards indexed workspace/session navigation and spawn shortcuts to the cockpit bridge", async () => {
    await renderTerminal();
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!term) throw new Error("terminal rig missing");
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    const navWorkspace = term.emitKey(
      new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const navSession = term.emitKey(
      new KeyboardEvent("keydown", { key: "3", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );
    const spawnTerminal = term.emitKey(
      new KeyboardEvent("keydown", { key: "t", metaKey: true, bubbles: true, cancelable: true }),
    );
    const spawnAgent = term.emitKey(
      new KeyboardEvent("keydown", { key: "e", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(navWorkspace).toBe(false);
    expect(navSession).toBe(false);
    expect(spawnTerminal).toBe(false);
    expect(spawnAgent).toBe(false);
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: "nav-workspace", sessionId: "sess_1", index: 1 }),
      window.location.origin,
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ action: "nav-session", sessionId: "sess_1", index: 2 }),
      window.location.origin,
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ action: "spawn-terminal", sessionId: "sess_1" }),
      window.location.origin,
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ action: "spawn-agent", sessionId: "sess_1" }),
      window.location.origin,
    );
  });

  it("only forwards Escape to the cockpit bridge while an overlay is open", async () => {
    await renderTerminal();
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!term) throw new Error("terminal rig missing");
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);

    const closedOverlay = term.emitKey(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    (window as Window & { __citadelOverlayOpen?: number }).__citadelOverlayOpen = 1;
    const openOverlay = term.emitKey(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(closedOverlay).toBe(true);
    expect(openOverlay).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "close-overlay", sessionId: "sess_1" }),
      window.location.origin,
    );
  });

  it("maps command-style line editing to pane key events without relying on daemon platform", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "Linux x86_64" });
    await flushReactUpdate(async () => ws.open());

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
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    await flushReactUpdate(async () => ws.open());

    const killed = term.emitKey(
      new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(killed).toBe(false);
    expect(ws.sent).toContain(JSON.stringify({ type: "key", key: "C-u" }));
  });

  it("lets macOS Cmd+C with an xterm selection reach the browser copy event", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await flushReactUpdate(async () => ws.open());

    const copied = term.emitKey(
      new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(copied).toBe(true);
    expect(decodeBinarySent(ws.sent).join("")).not.toContain("\u0003");
  });

  it("does not cancel the native host keydown before macOS selected-text copy", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    await flushReactUpdate(async () => ws.open());
    const event = new KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });

    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(decodeBinarySent(ws.sent).join("")).not.toContain("\u0003");
  });

  it("does not turn browser-selected terminal text into a macOS Cmd+C interrupt", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !term || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");
    selectTextInside(host, "browser selected text");
    await flushReactUpdate(async () => ws.open());
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
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
    term.hasSelection.mockReturnValue(false);
    term.getSelection.mockReturnValue("");
    await flushReactUpdate(async () => ws.open());

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
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    await flushReactUpdate(async () => ws.open());
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
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!term) throw new Error("terminal rig missing");
    expect((term.options.theme as { background?: string }).background).toBe("#1a1814");

    await flushReactUpdate(async () => {
      applyThemePreference("light");
      await settle();
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);
    expect((term.options.theme as { background?: string }).background).toBe("#f5f1e8");
  });

  it("shows an actionable error when the WebSocket closes", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    if (!ws) throw new Error("missing ws");

    await flushReactUpdate(async () => ws.closeFromServer(1006, "lost"));

    expect(document.body.textContent).toContain("terminal_disconnected");
    expect(document.body.textContent).toContain("lost");
    expect((document.querySelector("button") as HTMLButtonElement | null)?.disabled).toBe(false);
  });

  it("auto-retries disconnected terminal sockets up to three times with 5s backoff", async () => {
    vi.useFakeTimers();
    await renderTerminal();

    await flushReactUpdate(() => TerminalPaneWebSocketMock.instances[0]?.closeFromServer(1006, "lost"));
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);

    await flushReactUpdate(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);

    await flushReactUpdate(() => {
      vi.advanceTimersByTime(1);
    });
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(2);

    await flushReactUpdate(() => TerminalPaneWebSocketMock.instances[1]?.closeFromServer(1006, "still lost"));
    await flushReactUpdate(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(3);

    await flushReactUpdate(() => TerminalPaneWebSocketMock.instances[2]?.closeFromServer(1006, "still lost"));
    await flushReactUpdate(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(TerminalPaneWebSocketMock.instances).toHaveLength(4);

    await flushReactUpdate(() => TerminalPaneWebSocketMock.instances[3]?.closeFromServer(1006, "exhausted"));
    await flushReactUpdate(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(4);
    expect(document.body.textContent).toContain("terminal_disconnected");
    expect(document.body.textContent).toContain("exhausted");
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
