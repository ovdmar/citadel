// @vitest-environment happy-dom

import type { WorkspaceSession } from "@citadel/contracts";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeResizeObserver,
  FakeWebSocket as TerminalPaneWebSocketMock,
  clipboardDataMock,
  decodeBinarySent,
  flushReact as flushReactUpdate,
  installAnimationFrameMock,
  installLocalStorageMock,
  roots,
  selectTextInside,
  sessionFixture,
  settle,
} from "./terminal-pane-test-utils.js";
import {
  TerminalPane,
  focusActiveTerminal,
  getFocusedTerminalSessionId,
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
    refresh = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => true);
    getSelection = vi.fn(() => "selected text");
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
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
    write(data: string | Uint8Array) {
      this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
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
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));

    constructor() {
      FakeFitAddon.instances.push(this);
    }
  }

  return { FakeTerminal, FakeFitAddon };
});

vi.mock("@xterm/xterm", () => ({ Terminal: xtermMocks.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: xtermMocks.FakeFitAddon }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  (window as Window & { __citadelOverlayOpen?: number }).__citadelOverlayOpen = 0;
  installLocalStorageMock();
  xtermMocks.FakeTerminal.instances = [];
  xtermMocks.FakeFitAddon.instances = [];
  TerminalPaneWebSocketMock.instances = [];
  FakeResizeObserver.instances = [];
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
  installAnimationFrameMock();
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

  it("detaches retained panes while inactive so hidden output cannot block active typing", async () => {
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);
    const session = sessionFixture();

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: true }));
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(1);
    const ws = TerminalPaneWebSocketMock.instances[0];
    if (!ws) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());
    expect(getTerminalHandle("sess_1")?.canAcceptVoiceInput()).toBe(true);

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: false }));
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(1);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(1);
    expect(TerminalPaneWebSocketMock.instances[0]?.readyState).toBe(TerminalPaneWebSocketMock.CLOSED);
    expect(xtermMocks.FakeTerminal.instances[0]?.dispose).toHaveBeenCalled();
    expect(getTerminalHandle("sess_1")?.canAcceptVoiceInput()).toBe(false);

    await flushReactUpdate(async () => {
      root.render(createElement(TerminalPane, { session, active: true }));
    });

    expect(TerminalPaneWebSocketMock.instances).toHaveLength(2);
    expect(xtermMocks.FakeTerminal.instances).toHaveLength(2);
    expect(getTerminalHandle("sess_1")).toBeDefined();
    await flushReactUpdate(async () => TerminalPaneWebSocketMock.instances[1]?.open());
    expect(getTerminalHandle("sess_1")?.canAcceptVoiceInput()).toBe(true);
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

  it("coalesces printable PTY-daemon input only while the socket is backed up", async () => {
    vi.useFakeTimers();
    await renderTerminal({ ...sessionFixture(), terminalBackend: "pty-daemon" });
    const ws = TerminalPaneWebSocketMock.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await flushReactUpdate(async () => ws.open());
    term.emitData("z");
    expect(decodeBinarySent(ws.sent)).toEqual(["z"]);

    ws.sent = [];
    (ws as typeof ws & { bufferedAmount: number }).bufferedAmount = 1;
    term.emitData("a");
    term.emitData("b");

    expect(decodeBinarySent(ws.sent)).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(decodeBinarySent(ws.sent)).toEqual(["ab"]);

    ws.sent = [];
    term.emitData("c");
    term.emitData("\u0003");

    expect(decodeBinarySent(ws.sent)).toEqual(["c\u0003"]);
    expect(window.fetch).toHaveBeenCalledWith(
      "/api/agent-sessions/sess_1/user-action",
      expect.objectContaining({ body: JSON.stringify({ reason: "ctrl_c" }) }),
    );
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
    const voiceDictation = term.emitKey(
      new KeyboardEvent("keydown", { key: "d", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
    );

    expect(navWorkspace).toBe(false);
    expect(navSession).toBe(false);
    expect(spawnTerminal).toBe(false);
    expect(spawnAgent).toBe(false);
    expect(voiceDictation).toBe(false);
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
    expect(postMessage).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({ action: "voice-dictation", sessionId: "sess_1" }),
      window.location.origin,
    );
  });

  it("forwards native host voice shortcuts without sending terminal bytes", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());
    ws.sent = [];
    const postMessage = vi.spyOn(window, "postMessage").mockImplementation(() => undefined);
    const downstream = vi.fn();
    host.addEventListener("keydown", downstream);

    const event = new KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);
    host.removeEventListener("keydown", downstream);

    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "voice-dictation", sessionId: "sess_1" }),
      window.location.origin,
    );
    expect(decodeBinarySent(ws.sent)).toEqual([]);
  });

  it("sends voice input through the terminal WebSocket with one Enter on submit", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    if (!ws) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());

    const handle = getTerminalHandle("sess_1");
    expect(handle?.sendVoiceInput("hello", { submit: false })).toBe(true);
    expect(handle?.sendVoiceInput("run it", { submit: true })).toBe(true);

    expect(decodeBinarySent(ws.sent)).toEqual(["hello", "run it", "\r"]);
    const agentMessageCalls = vi
      .mocked(window.fetch)
      .mock.calls.filter(([input]) => /\/api\/agent-sessions\/sess_1\/(?:messages?|follow-up)/.test(String(input)));
    expect(agentMessageCalls).toEqual([]);
  });

  it("sends agent-session voice input through the same terminal WebSocket path", async () => {
    await renderTerminal({
      ...sessionFixture(),
      kind: "agent",
      runtimeId: "claude-code",
      displayName: "Claude Code",
    });
    const ws = TerminalPaneWebSocketMock.instances[0];
    if (!ws) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());

    const handle = getTerminalHandle("sess_1");
    expect(handle?.sendVoiceInput("agent text", { submit: false })).toBe(true);
    expect(handle?.sendVoiceInput("agent run", { submit: true })).toBe(true);

    expect(decodeBinarySent(ws.sent)).toEqual(["agent text", "agent run", "\r"]);
    const agentMessageCalls = vi
      .mocked(window.fetch)
      .mock.calls.filter(([input]) => /\/api\/agent-sessions\/sess_1\/(?:messages?|follow-up)/.test(String(input)));
    expect(agentMessageCalls).toEqual([]);
  });

  it("rejects terminal voice input when the terminal host is hidden", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());
    const handle = getTerminalHandle("sess_1");

    expect(handle?.canAcceptVoiceInput()).toBe(true);
    host.closest(".terminal-shell")?.setAttribute("aria-hidden", "true");

    expect(handle?.canAcceptVoiceInput()).toBe(false);
    expect(getFocusedTerminalSessionId(host)).toBeNull();
  });

  it("rejects terminal voice input while the terminal pane is in an error state", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    if (!ws) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());
    ws.sent = [];
    const handle = getTerminalHandle("sess_1");

    expect(handle?.canAcceptVoiceInput()).toBe(true);
    await flushReactUpdate(async () => {
      ws.message(JSON.stringify({ type: "error", data: "tmux_session_missing" }));
    });

    expect(document.querySelector(".terminal-error-state")).not.toBeNull();
    expect(handle?.canAcceptVoiceInput()).toBe(false);
    expect(handle?.sendVoiceInput("should buffer", { submit: true })).toBe(false);
    expect(decodeBinarySent(ws.sent)).toEqual([]);
  });

  it("resolves focused xterm descendants to their session id", async () => {
    await renderTerminal();
    const host = document.querySelector(".terminal-xterm-host");
    if (!(host instanceof HTMLElement)) throw new Error("terminal host missing");
    const innerInput = document.createElement("textarea");
    host.appendChild(innerInput);
    innerInput.focus();

    expect(getFocusedTerminalSessionId()).toBe("sess_1");
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

  it("sends Codex's modified-enter sequence for Shift+Enter in Codex sessions", async () => {
    await renderTerminal({
      ...sessionFixture(),
      kind: "agent",
      runtimeId: "codex",
      displayName: "Codex",
    });
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");

    await flushReactUpdate(async () => ws.open());
    const event = new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(ws.sent).toContain(JSON.stringify({ type: "input", data: "\u001b[13;2u" }));
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
});

async function renderTerminal(session: WorkspaceSession = sessionFixture()) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReactUpdate(async () => {
    root.render(createElement(TerminalPane, { session }));
    await settle();
  });
  return root;
}
