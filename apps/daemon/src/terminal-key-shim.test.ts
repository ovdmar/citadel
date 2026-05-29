import { describe, expect, it } from "vitest";
import { TERMINAL_KEY_SHIM_SOURCE, injectKeyShim, shouldInjectShim } from "./terminal-key-shim.js";

describe("injectKeyShim", () => {
  it("injects the shim before the first <script> tag so it runs before ttyd's bundle", () => {
    const html =
      '<!doctype html><html><head><title>ttyd</title></head><body><div id="terminal"></div><script src="main.js"></script></body></html>';
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
    const html = '<html><head></head><body><script src="x.js"></script></body></html>';
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
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/key === "enter"[\s\S]*shiftKey/);
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\n")');
    // Ctrl+A -> SOH
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/key === "a" && event\.ctrlKey/);
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x01")');
    // Cmd+Backspace -> Ctrl+U on Mac only
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"backspace"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x15")');
    // Cmd+Left/Right -> Ctrl+A/E
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"arrowleft"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"arrowright"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('sendInput("\\x05")');
    // Mac gating
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/isMac/);
    // Cmd+C routing: read xterm's internal selection (via window.term) and
    // write it through navigator.clipboard. The mirrored lastTermSelection
    // cache covers TUIs that re-render between mouseup and Cmd+C.
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("navigator.clipboard");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("term.getSelection");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("onSelectionChange");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("lastTermSelection");
    // Cmd+V bracketed paste
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("\\x1b[200~");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("\\x1b[201~");
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/navigator\.clipboard\??\.readText/);
    // Cmd+A terminal-scoped select-all
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("selectAllInTerminal");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain(".xterm-screen");
    // Citadel-level shortcuts bridge out of the iframe to the parent app.
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("citadel.terminal-shortcut");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"command-palette"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"scratchpad-toggle"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('"new-workspace"');
    // Single listener registration — only document, not window (avoids
    // duplicate sends since stopImmediatePropagation only stops same-target
    // listeners).
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('document.addEventListener("keydown"');
    expect(TERMINAL_KEY_SHIM_SOURCE).not.toContain('window.addEventListener("keydown"');
    // Client lifecycle telemetry distinguishes iframe navigation from raw
    // WebSocket disconnects in diagnostics.
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain("terminal-client-event");
    expect(TERMINAL_KEY_SHIM_SOURCE).toContain('recordTerminalClientEvent("ws.close"');
    expect(TERMINAL_KEY_SHIM_SOURCE).toMatch(/window\.addEventListener\(\s*"pagehide"/);
  });

  it("does not self-refresh terminal pages for theme changes", () => {
    expect(TERMINAL_KEY_SHIM_SOURCE).not.toContain("citadel.theme");
    expect(TERMINAL_KEY_SHIM_SOURCE).not.toContain('window.addEventListener("storage"');
    expect(TERMINAL_KEY_SHIM_SOURCE).not.toContain("/terminal?theme=");
    expect(TERMINAL_KEY_SHIM_SOURCE).not.toContain("window.location.reload()");
  });
});

describe("shouldInjectShim", () => {
  it("returns true for 200 text/html with no content-encoding", () => {
    expect(shouldInjectShim({ "content-type": "text/html; charset=utf-8" }, 200)).toBe(true);
  });

  it("returns true for 200 text/html with identity content-encoding", () => {
    expect(shouldInjectShim({ "content-type": "text/html", "content-encoding": "identity" }, 200)).toBe(true);
  });

  it("returns false for non-200 status (e.g. 304 Not Modified, 204 No Content, 500)", () => {
    const headers = { "content-type": "text/html" };
    expect(shouldInjectShim(headers, 304)).toBe(false);
    expect(shouldInjectShim(headers, 204)).toBe(false);
    expect(shouldInjectShim(headers, 500)).toBe(false);
  });

  it("returns false for non-html content types", () => {
    expect(shouldInjectShim({ "content-type": "application/javascript" }, 200)).toBe(false);
    expect(shouldInjectShim({ "content-type": "text/css" }, 200)).toBe(false);
    expect(shouldInjectShim({ "content-type": "image/png" }, 200)).toBe(false);
  });

  it("returns false when the response is transport-compressed (gzip/deflate/br)", () => {
    expect(shouldInjectShim({ "content-type": "text/html", "content-encoding": "gzip" }, 200)).toBe(false);
    expect(shouldInjectShim({ "content-type": "text/html", "content-encoding": "deflate" }, 200)).toBe(false);
    expect(shouldInjectShim({ "content-type": "text/html", "content-encoding": "br" }, 200)).toBe(false);
  });

  it("handles missing or array-valued headers gracefully", () => {
    expect(shouldInjectShim({}, 200)).toBe(false);
    expect(shouldInjectShim({ "content-type": ["text/html"] }, 200)).toBe(true);
    expect(shouldInjectShim({ "content-type": "text/html", "content-encoding": [""] }, 200)).toBe(true);
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
    windowKeydownListeners: number;
    documentKeydownListeners: number;
    sent: Uint8Array[];
    parentMessages: Array<{ message: unknown; targetOrigin: string }>;
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

  type FakeKeyboardEventInit = {
    key: string;
    code?: string;
    keyCode?: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    bubbles?: boolean;
    cancelable?: boolean;
  };
  class FakeSyntheticEvent {
    constructor(
      public type: string,
      public init: FakeKeyboardEventInit,
    ) {}
  }

  type SelectionState = {
    selected: object[];
    cleared: number;
  };
  type RangeState = { contents: object[] };

  function setup(
    platform: string,
    extras: {
      getSelection?: () => string;
      clipboardWrites?: string[];
      clipboardReadText?: string | (() => Promise<string>);
      xtermHelper?: { dispatchEvent: (event: FakeSyntheticEvent) => boolean };
      term?: {
        selectAll?: () => void;
        getSelection?: () => string;
        onSelectionChange?: (handler: (...args: unknown[]) => void) => void;
      };
      xtermScreen?: object;
      xtermElement?: object;
      selectionState?: SelectionState;
      rangeState?: RangeState;
    } = {},
  ): ShimHarness {
    const listeners: ShimHarness["listeners"] = [];
    const sent: Uint8Array[] = [];
    const parentMessages: ShimHarness["parentMessages"] = [];
    const clipboardWrites = extras.clipboardWrites ?? [];
    let windowKeydownListeners = 0;
    let documentKeydownListeners = 0;
    const selectionState = extras.selectionState;
    const rangeState = extras.rangeState;
    const runtime: ShimHarness["runtime"] = {
      window: {
        WebSocket: FakeWebSocket,
        addEventListener: ((type: string, handler: (event: FakeKeyboardEvent) => void) => {
          if (type === "keydown") {
            windowKeydownListeners += 1;
            listeners.push(handler);
          }
        }) as unknown as Window["addEventListener"],
        getSelection: extras.getSelection
          ? () => ({ toString: () => extras.getSelection?.() ?? "" })
          : selectionState
            ? () => ({
                toString: () => "",
                removeAllRanges: () => {
                  selectionState.cleared += 1;
                },
                addRange: (range: object) => {
                  selectionState.selected.push(range);
                },
              })
            : undefined,
        KeyboardEvent: FakeSyntheticEvent as unknown as typeof KeyboardEvent,
        term: extras.term,
        parent: {
          postMessage: (message: unknown, targetOrigin: string) => {
            parentMessages.push({ message, targetOrigin });
          },
        },
        location: {
          origin: "http://localhost",
          pathname: "/terminals/sess_test/",
        },
      } as ShimHarness["runtime"]["window"],
      document: {
        addEventListener: ((type: string, handler: (event: FakeKeyboardEvent) => void) => {
          if (type === "keydown") {
            documentKeydownListeners += 1;
            listeners.push(handler);
          }
        }) as unknown as Document["addEventListener"],
        querySelector: ((selector: string) => {
          if (selector === ".xterm-helper-textarea") return extras.xtermHelper ?? null;
          if (selector === ".xterm-screen") return extras.xtermScreen ?? null;
          if (selector === ".xterm") return extras.xtermElement ?? null;
          return null;
        }) as Document["querySelector"],
        createRange: rangeState
          ? () => ({
              selectNodeContents: (node: object) => {
                rangeState.contents.push(node);
              },
            })
          : undefined,
      } as unknown as ShimHarness["runtime"]["document"],
      navigator: {
        platform,
        userAgent: platform,
        clipboard: {
          writeText: (text: string) => {
            clipboardWrites.push(text);
            return Promise.resolve();
          },
          readText:
            extras.clipboardReadText === undefined
              ? undefined
              : typeof extras.clipboardReadText === "function"
                ? extras.clipboardReadText
                : () => Promise.resolve(extras.clipboardReadText as string),
        },
      } as ShimHarness["runtime"]["navigator"],
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
      get windowKeydownListeners() {
        return windowKeydownListeners;
      },
      get documentKeydownListeners() {
        return documentKeydownListeners;
      },
      sent,
      parentMessages,
      activate: () => {
        const PatchedWS = runtime.window.WebSocket;
        const ws = new PatchedWS("ws://localhost/terminals/x/ws");
        const fakeWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1] as FakeWebSocket;
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

  it("registers exactly one keydown listener on document (not on window) so shortcuts fire once", () => {
    const harness = setup("MacIntel");
    expect(harness.documentKeydownListeners).toBe(1);
    expect(harness.windowKeydownListeners).toBe(0);
  });

  it("forwards Shift+Enter as a single LF byte", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "Enter", shiftKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(harness.sent).toHaveLength(1);
    const decoded = decode(harness.sent[0]);
    expect(decoded.command).toBe(48); // '0'
    expect(decoded.text).toBe("\n");
  });

  it("forwards Ctrl+A as a single SOH byte on any platform", () => {
    const harness = setup("Linux x86_64");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", ctrlKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(harness.sent).toHaveLength(1);
    expect(decode(harness.sent[0]).text).toBe("\x01");
  });

  it("translates Cmd+Backspace to Ctrl+U only on macOS", () => {
    const mac = setup("MacIntel");
    mac.activate();
    dispatch(mac, makeEvent({ key: "Backspace", metaKey: true }));
    expect(mac.sent).toHaveLength(1);
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
    expect(mac.sent).toHaveLength(2);
    expect(decode(mac.sent[0]).text).toBe("\x01");
    expect(decode(mac.sent[1]).text).toBe("\x05");
  });

  it("ignores keystrokes while IME composition is active", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "Enter", shiftKey: true, isComposing: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(harness.sent).toEqual([]);
  });

  it("posts Cmd+K to the parent app instead of sending it to the PTY", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "k", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(harness.sent).toEqual([]);
    expect(harness.parentMessages).toEqual([
      {
        targetOrigin: "http://localhost",
        message: {
          source: "citadel-terminal",
          type: "citadel.terminal-shortcut",
          action: "command-palette",
          sessionId: "sess_test",
        },
      },
    ]);
  });

  it("posts Shift+Cmd+S to the parent app for the scratchpad drawer", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "s", metaKey: true, shiftKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(harness.sent).toEqual([]);
    expect(harness.parentMessages.map((entry) => (entry.message as { action?: string }).action)).toEqual([
      "scratchpad-toggle",
    ]);
  });

  it("posts Ctrl+N to the parent app for new workspace", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "n", ctrlKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(harness.sent).toEqual([]);
    expect(harness.parentMessages.map((entry) => (entry.message as { action?: string }).action)).toEqual([
      "new-workspace",
    ]);
  });

  it("Cmd+C copies the DOM selection through navigator.clipboard exactly once", () => {
    const clipboardWrites: string[] = [];
    const harness = setup("MacIntel", { getSelection: () => "highlighted text", clipboardWrites });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "c", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWrites).toEqual(["highlighted text"]);
  });

  it("Cmd+C reads xterm's internal selection through window.term when the DOM selection is empty", () => {
    // Canvas-renderer xterm doesn't produce a real DOM selection, so the
    // shim has to ask the xterm instance directly. The previous mechanism
    // (synthetic Ctrl+Shift+C dispatch on .xterm-helper-textarea) silently
    // dropped the copy inside Claude Code's TUI; the current path reads
    // term.getSelection() and writes it to navigator.clipboard.
    const clipboardWrites: string[] = [];
    const term = {
      getSelection: () => "xterm-internal selection",
      onSelectionChange: () => {},
    };
    const harness = setup("MacIntel", { getSelection: () => "", clipboardWrites, term });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "c", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(clipboardWrites).toEqual(["xterm-internal selection"]);
  });

  it("Cmd+C is a no-op on non-mac platforms", () => {
    const clipboardWrites: string[] = [];
    const harness = setup("Linux x86_64", { getSelection: () => "anything", clipboardWrites });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "c", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(clipboardWrites).toEqual([]);
  });

  it("accepts uppercase key values from keyboards with CapsLock/Shift", () => {
    const harness = setup("Linux x86_64");
    harness.activate();
    dispatch(harness, makeEvent({ key: "A", ctrlKey: true }));
    expect(harness.sent).toHaveLength(1);
    expect(decode(harness.sent[0]).text).toBe("\x01");
  });

  it("Cmd+V reads the clipboard and sends the text wrapped in bracketed-paste escapes", async () => {
    const harness = setup("MacIntel", { clipboardReadText: "echo hello\nls\n" });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "v", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    // clipboard.readText is async — flush the microtask queue once.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.sent).toHaveLength(1);
    expect(decode(harness.sent[0]).text).toBe("\x1b[200~echo hello\nls\n\x1b[201~");
  });

  it("Cmd+V is a no-op when the clipboard API is unavailable", () => {
    const harness = setup("MacIntel"); // no clipboardReadText -> readText: undefined
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "v", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(harness.sent).toEqual([]);
  });

  it("Cmd+V swallows clipboard rejections (e.g. permission denied) without sending anything", async () => {
    const harness = setup("MacIntel", {
      clipboardReadText: () => Promise.reject(new Error("clipboard blocked")),
    });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "v", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.sent).toEqual([]);
  });

  it("Cmd+V is a no-op on non-mac platforms", () => {
    const harness = setup("Linux x86_64", { clipboardReadText: "anything" });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "v", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
    expect(harness.sent).toEqual([]);
  });

  it("Cmd+A delegates to window.term.selectAll when xterm exposes the Terminal instance", () => {
    const calls: string[] = [];
    const harness = setup("MacIntel", {
      term: {
        selectAll: () => {
          calls.push("selectAll");
        },
      },
    });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(calls).toEqual(["selectAll"]);
  });

  it("Cmd+A falls back to a DOM Range scoped to .xterm-screen when window.term is absent", () => {
    const screen = { __id: "xterm-screen-element" };
    const selectionState: SelectionState = { selected: [], cleared: 0 };
    const rangeState: RangeState = { contents: [] };
    const harness = setup("MacIntel", { xtermScreen: screen, selectionState, rangeState });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", metaKey: true }));
    expect(event.defaultPrevented).toBe(true);
    expect(rangeState.contents).toEqual([screen]);
    expect(selectionState.cleared).toBe(1);
    expect(selectionState.selected).toHaveLength(1);
  });

  it("Cmd+A is a no-op when neither window.term nor .xterm-screen is available", () => {
    const harness = setup("MacIntel");
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
  });

  it("Cmd+A is a no-op on non-mac platforms (Ctrl+A continues to send SOH to the PTY)", () => {
    const harness = setup("Linux x86_64", {
      term: {
        selectAll: () => {
          throw new Error("should not be called on linux");
        },
      },
    });
    harness.activate();
    const event = dispatch(harness, makeEvent({ key: "a", metaKey: true }));
    expect(event.defaultPrevented).toBe(false);
  });
});
