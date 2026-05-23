import { describe, expect, it } from "vitest";
import { TERMINAL_KEY_SHIM_SOURCE, injectKeyShim } from "./terminal-key-shim.js";

describe("injectKeyShim", () => {
  it("injects the shim before the first <script> tag so it runs before ttyd's bundle", () => {
    const html = `<!doctype html><html><head><title>ttyd</title></head><body><div id="terminal"></div><script src="main.js"></script></body></html>`;
    const result = injectKeyShim(html);
    const shimIdx = result.indexOf("__citadelTerminalShim");
    const bundleIdx = result.indexOf('src="main.js"');
    expect(shimIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(-1);
    expect(shimIdx).toBeLessThan(bundleIdx);
  });

  it("falls back to </head> when there is no <script> tag", () => {
    const html = "<html><head><title>x</title></head><body></body></html>";
    const result = injectKeyShim(html);
    expect(result).toContain("__citadelTerminalShim");
    expect(result.indexOf("__citadelTerminalShim")).toBeLessThan(result.indexOf("</head>"));
  });

  it("is idempotent — does not double-inject", () => {
    const html = `<html><head></head><body><script src="x.js"></script></body></html>`;
    const once = injectKeyShim(html);
    const twice = injectKeyShim(once);
    expect(twice).toEqual(once);
    // Exactly one <script> shim wrapper, regardless of how many times the
    // marker variable appears inside the shim source itself.
    const inject = once.split("<script>").filter((piece) => piece.includes("__citadelTerminalShim"));
    expect(inject).toHaveLength(1);
  });

  it("covers every advertised shortcut so behavioural regressions surface in source", () => {
    // Shift+Enter -> LF
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/"Enter"[\s\S]*shiftKey/);
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\n")');
    // Ctrl+A -> SOH
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/"a" \|\| event\.key === "A"/);
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x01")');
    // Cmd+Backspace -> Ctrl+U on Mac only
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"Backspace"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x15")');
    // Cmd+Left/Right -> Ctrl+A/E
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"ArrowLeft"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"ArrowRight"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x05")');
    // Mac gating
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/isMac/);
  });
});

describe("TERMINAL_KEY_SHIM_SOURCE runtime behavior", () => {
  type ShimHarness = {
    runtime: {
      window: Record<string, unknown> & {
        WebSocket: typeof FakeWebSocket;
        addEventListener: (typeof Window.prototype)["addEventListener"];
      };
      document: { addEventListener: (typeof Document.prototype)["addEventListener"] };
      navigator: { platform: string; userAgent: string };
      TextEncoder: typeof TextEncoder;
    };
    listeners: Array<(event: FakeKeyboardEvent) => void>;
    sent: Uint8Array[];
    activate: () => void;
  };

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    sent: Uint8Array[] = [];
    listeners: Record<string, Array<() => void>> = {};
    constructor(public url: string) {
      FakeWebSocket.instances.push(this);
    }
    addEventListener(type: string, handler: () => void) {
      const bucket = this.listeners[type] ?? [];
      bucket.push(handler);
      this.listeners[type] = bucket;
    }
    send(payload: Uint8Array) {
      this.sent.push(payload);
    }
  }

  type FakeKeyboardEvent = {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
    preventDefault: () => void;
    stopPropagation: () => void;
    stopImmediatePropagation?: () => void;
    defaultPrevented?: boolean;
  };

  function makeEvent(over: Partial<FakeKeyboardEvent> & { key: string }): FakeKeyboardEvent {
    let prevented = false;
    return {
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      ...over,
      preventDefault: () => {
        prevented = true;
      },
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
      get defaultPrevented() {
        return prevented;
      },
    } as FakeKeyboardEvent;
  }

  function setup(platform: string): ShimHarness {
    const listeners: ShimHarness["listeners"] = [];
    const sent: Uint8Array[] = [];
    const runtime: ShimHarness["runtime"] = {
      window: {
        WebSocket: FakeWebSocket,
        addEventListener: ((type: string, handler: (event: FakeKeyboardEvent) => void) => {
          if (type === "keydown") listeners.push(handler);
        }) as unknown as Window["addEventListener"],
      } as ShimHarness["runtime"]["window"],
      document: {
        addEventListener: ((type: string, handler: (event: FakeKeyboardEvent) => void) => {
          if (type === "keydown") listeners.push(handler);
        }) as unknown as Document["addEventListener"],
      },
      navigator: { platform, userAgent: platform },
      TextEncoder,
    };
    new Function("window", "document", "navigator", "TextEncoder", TERMINAL_KEY_SHIM_SOURCE)(
      runtime.window,
      runtime.document,
      runtime.navigator,
      runtime.TextEncoder,
    );
    return {
      runtime,
      listeners,
      sent,
      activate: () => {
        const PatchedWS = runtime.window.WebSocket;
        const ws = new PatchedWS("ws://localhost/terminals/x/ws");
        const fakeWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
        // Re-route fakeWs.send into our captured `sent` array for easy assertions.
        const originalSend = fakeWs.send.bind(fakeWs);
        fakeWs.send = (payload: Uint8Array) => {
          sent.push(payload);
          originalSend(payload);
        };
        void ws;
      },
    };
  }

  function decode(payload: Uint8Array | undefined): { command: number; text: string } {
    if (!payload) throw new Error("expected payload");
    return {
      command: payload[0] ?? -1,
      text: new TextDecoder().decode(payload.subarray(1)),
    };
  }

  function dispatch(harness: ShimHarness, event: FakeKeyboardEvent) {
    for (const listener of harness.listeners) listener(event);
    return event;
  }

  it("forwards Shift+Enter as a literal LF byte", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "Enter", shiftKey: true }));
    expect(event.defaultPrevented).toBe(true);
    // One listener fires on window and one on document — both forward.
    expect(harness.sent.length).toBeGreaterThanOrEqual(1);
    const decoded = decode(harness.sent[0]);
    expect(decoded.command).toBe(48); // '0'
    expect(decoded.text).toBe("\n");
  });

  it("forwards Ctrl+A as SOH on any platform", () => {
    const harness = setup("Linux x86_64");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", ctrlKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(decode(harness.sent[0]).text).toBe("\x01");
  });

  it("translates Cmd+Backspace to Ctrl+U only on macOS", () => {
    const mac = setup("MacIntel");
    mac.activate();
    dispatch(mac, makeEvent({ key: "Backspace", metaKey: true }));
    expect(decode(mac.sent[0]).text).toBe("\x15");

    const linux = setup("Linux x86_64");
    linux.activate();
    const event = dispatch(linux, makeEvent({ key: "Backspace", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(linux.sent).toEqual([]);
  });

  it("maps Cmd+Left/Right to Ctrl+A/Ctrl+E on macOS", () => {
    const mac = setup("MacIntel");
    mac.activate();
    dispatch(mac, makeEvent({ key: "ArrowLeft", metaKey: true }));
    dispatch(mac, makeEvent({ key: "ArrowRight", metaKey: true }));
    // First handler fires twice (window+document) per event; index 0 = Left, index 2 = Right.
    const texts = mac.sent.map((payload) => decode(payload).text);
    expect(texts).toContain("\x01");
    expect(texts).toContain("\x05");
  });

  it("ignores keystrokes while IME composition is active", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "Enter", shiftKey: true, isComposing: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(harness.sent).toEqual([]);
  });
});
