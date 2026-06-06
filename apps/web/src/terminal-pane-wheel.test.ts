// @vitest-environment happy-dom

import type { WorkspaceSession } from "@citadel/contracts";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeResizeObserver,
  FakeWebSocket as TerminalPaneWebSocketMock,
  flushAnimationFrames,
  flushReact as flushReactUpdate,
  installAnimationFrameMock,
  installLocalStorageMock,
  roots,
  sessionFixture,
  settle,
} from "./terminal-pane-test-utils.js";
import { TerminalPane } from "./terminal-pane.js";

const xtermMocks = vi.hoisted(() => {
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    options: Record<string, unknown>;
    cols = 80;
    rows = 24;
    focus = vi.fn();
    dispose = vi.fn();
    refresh = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => true);
    getSelection = vi.fn(() => "selected text");
    resize = vi.fn();

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
    write() {}
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

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
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

describe("TerminalPane wheel handling", () => {
  it("captures wheel input and scrolls the terminal viewport instead of leaking prompt-history keys", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    const downstream = vi.fn();
    host.addEventListener("wheel", downstream);
    await flushReactUpdate(async () => ws.open());

    const event = new WheelEvent("wheel", { deltaY: -32, deltaMode: 0, bubbles: true, cancelable: true });

    host.dispatchEvent(event);
    await nextAnimationFrame();

    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(ws.sent).toContain(JSON.stringify({ type: "scroll", lines: -2 }));
  });

  it("coalesces trackpad wheel deltas into one scroll message per frame", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -8, deltaMode: 0, bubbles: true, cancelable: true }));
    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -8, deltaMode: 0, bubbles: true, cancelable: true }));

    expect(scrollMessages(ws)).toEqual([]);
    await nextAnimationFrame();
    expect(scrollMessages(ws)).toEqual([{ type: "scroll", lines: -1 }]);
  });

  it("maps line-mode wheel ticks to multiple terminal rows", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, deltaMode: 1, bubbles: true, cancelable: true }));
    await nextAnimationFrame();

    expect(scrollMessages(ws)).toEqual([{ type: "scroll", lines: -3 }]);
  });

  it("accelerates large wheel deltas and Alt fast-scrolls in larger chunks", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    await flushReactUpdate(async () => ws.open());

    const event = new WheelEvent("wheel", { deltaY: -72, deltaMode: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, "altKey", { configurable: true, value: true });

    host.dispatchEvent(event);
    await nextAnimationFrame();

    expect(scrollMessages(ws)).toEqual([{ type: "scroll", lines: -45 }]);
  });

  it("leaves shifted wheel events alone for browser horizontal-scroll gestures", async () => {
    await renderTerminal();
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    const downstream = vi.fn();
    host.addEventListener("wheel", downstream);
    await flushReactUpdate(async () => ws.open());

    const event = new WheelEvent("wheel", { deltaY: -32, deltaMode: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, "shiftKey", { configurable: true, value: true });

    host.dispatchEvent(event);
    await nextAnimationFrame();

    expect(event.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(scrollMessages(ws)).toEqual([]);
  });

  it("lets Claude Code receive wheel input for fullscreen mouse scrolling", async () => {
    await renderTerminal({
      ...sessionFixture(),
      kind: "agent",
      runtimeId: "claude-code",
      displayName: "Claude Code",
    });
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    const downstream = vi.fn();
    host.addEventListener("wheel", downstream);
    await flushReactUpdate(async () => ws.open());

    const event = new WheelEvent("wheel", { deltaY: -32, deltaMode: 0, bubbles: true, cancelable: true });

    host.dispatchEvent(event);
    await nextAnimationFrame();

    expect(event.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(scrollMessages(ws)).toEqual([]);
  });

  it("keeps PTY-daemon wheel events native for xterm scrollback", async () => {
    await renderTerminal({
      ...sessionFixture(),
      terminalBackend: "pty-daemon",
      tmuxSessionName: null,
      tmuxSessionId: null,
      ptySessionId: "pty_1",
    });
    const ws = TerminalPaneWebSocketMock.instances[0];
    const host = document.querySelector(".terminal-xterm-host");
    if (!ws || !(host instanceof HTMLElement)) throw new Error("terminal rig missing");
    const downstream = vi.fn();
    host.addEventListener("wheel", downstream);
    await flushReactUpdate(async () => ws.open());

    const event = new WheelEvent("wheel", { deltaY: -32, deltaMode: 0, bubbles: true, cancelable: true });

    host.dispatchEvent(event);
    await nextAnimationFrame();

    expect(event.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(scrollMessages(ws)).toEqual([]);
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
}

async function nextAnimationFrame() {
  flushAnimationFrames();
  await settle();
}

function scrollMessages(ws: InstanceType<typeof TerminalPaneWebSocketMock>): Array<{ type: string; lines: number }> {
  return ws.sent
    .filter((item): item is string => typeof item === "string")
    .map((item) => JSON.parse(item) as { type?: string; lines?: unknown })
    .filter(
      (item): item is { type: string; lines: number } => item.type === "scroll" && typeof item.lines === "number",
    );
}
