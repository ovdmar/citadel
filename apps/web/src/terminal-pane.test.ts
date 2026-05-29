// @vitest-environment happy-dom

import type { AgentSession } from "@citadel/contracts";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalPane,
  focusActiveTerminal,
  getTerminalHandle,
  isRegisteredTerminalMessageSource,
  isTtydHttpErrorPageVisible,
  isTtydReconnectPromptVisible,
  parseTerminalSocketMessage,
  terminalFallbackUrl,
  terminalIframeSrc,
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
    private dataHandler: ((data: string) => void) | null = null;

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
    emitData(data: string) {
      this.dataHandler?.(data);
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
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
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
  it("opens the primary /terminal WebSocket without spawning ttyd", async () => {
    await renderTerminal();

    expect(FakeWebSocket.instances[0]?.url).toBe(terminalWebSocketUrl("sess_1"));
    expect(window.fetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/agent-sessions/sess_1/terminal"));
    expect(getTerminalHandle("sess_1")?.url).toBe("/terminals/sess_1/");
  });

  it("writes WebSocket output to xterm and sends input/resize over the same socket", async () => {
    await renderTerminal();
    const ws = FakeWebSocket.instances[0];
    const term = xtermMocks.FakeTerminal.instances[0];
    if (!ws || !term) throw new Error("terminal rig missing");

    await act(async () => ws.open());
    ws.message(JSON.stringify({ type: "output", data: "snapshot" }));
    ws.message(JSON.stringify({ type: "outputChunk", data: "-chunk" }));
    term.emitData("abc");

    expect(term.writes.join("")).toBe("snapshot-chunk");
    expect(ws.sent).toContain(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    expect(ws.sent).toContain(JSON.stringify({ type: "input", data: "abc" }));
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
  it("builds WebSocket and fallback ttyd URLs", () => {
    const location = { protocol: "https:", host: "citadel.example" } as Location;

    expect(terminalWebSocketUrl("sess 1", location)).toBe("wss://citadel.example/terminal/sess%201");
    expect(terminalFallbackUrl("sess 1")).toBe("/terminals/sess%201/");
  });

  it("adds a client-version cache buster without discarding existing query params", () => {
    expect(terminalIframeSrc("/terminals/sess_1/")).toBe("/terminals/sess_1/?citadelClient=shortcut-bridge-v2");
    expect(terminalIframeSrc("/terminals/sess_1/?x=1")).toBe("/terminals/sess_1/?x=1&citadelClient=shortcut-bridge-v2");
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

function iframeWithBody(html: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("iframe contentDocument unavailable");
  doc.body.innerHTML = html;
  return iframe;
}

describe("isTtydReconnectPromptVisible", () => {
  it("detects ttyd's persistent reconnect overlay", () => {
    const iframe = iframeWithBody('<div class="xterm"><div>Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("detects reconnect button overlays from ttyd variants", () => {
    const iframe = iframeWithBody('<main><button type="button">Reconnect</button></main>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("ignores normal terminal output mentioning reconnect", () => {
    const iframe = iframeWithBody(
      '<div class="xterm"><div class="xterm-screen"><span>run reconnect-database when ready</span></div></div>',
    );

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });

  it("ignores hidden reconnect overlays", () => {
    const iframe = iframeWithBody('<div class="xterm"><div style="display: none">Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });
});

describe("isTtydHttpErrorPageVisible", () => {
  it("detects terminal proxy 404 pages", () => {
    expect(isTtydHttpErrorPageVisible(iframeWithBody("terminal_not_found"))).toBe(true);
    expect(isTtydHttpErrorPageVisible(iframeWithBody("404 page not found"))).toBe(true);
  });

  it("ignores normal xterm terminal content", () => {
    const iframe = iframeWithBody('<div class="xterm"><div class="xterm-screen">404 from curl</div></div>');

    expect(isTtydHttpErrorPageVisible(iframe)).toBe(false);
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
