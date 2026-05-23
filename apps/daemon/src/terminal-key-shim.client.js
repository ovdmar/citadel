// Injected verbatim into ttyd's HTML by injectKeyShim(). Kept as a sibling
// .js file (loaded at module-init time via fs.readFileSync) so editors give
// us real JS syntax highlighting / linting instead of inside a template
// literal. Runs in the iframe before any other script.
(() => {
  if (window.__citadelTerminalShim) return;
  window.__citadelTerminalShim = true;

  const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || "") || /Macintosh/i.test(navigator.userAgent || "");
  let activeWs = null;
  const textEncoder = new TextEncoder();

  // Wrap WebSocket so we can capture the ttyd input channel. The constructor
  // explicitly `return ws` — per JS semantics, when a constructor returns an
  // object via `new`, that object is what `new` evaluates to, so callers get
  // a real OriginalWebSocket instance (instanceof checks against the native
  // class continue to work).
  const OriginalWebSocket = window.WebSocket;
  function CitadelWebSocket(url, protocols) {
    const ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    if (typeof url === "string" && /\/ws(\?|$)/.test(url)) {
      activeWs = ws;
      ws.addEventListener("close", () => {
        if (activeWs === ws) activeWs = null;
      });
    }
    return ws;
  }
  CitadelWebSocket.prototype = OriginalWebSocket.prototype;
  CitadelWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  CitadelWebSocket.OPEN = OriginalWebSocket.OPEN;
  CitadelWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  CitadelWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  window.WebSocket = CitadelWebSocket;

  function sendInput(text) {
    const ws = activeWs;
    if (!ws || ws.readyState !== 1) return false;
    const encoded = textEncoder.encode(text);
    const payload = new Uint8Array(encoded.length + 1);
    payload[0] = 48; // '0' === Command.INPUT in ttyd's protocol
    payload.set(encoded, 1);
    try {
      ws.send(payload);
    } catch (_err) {
      return false;
    }
    return true;
  }

  function consume(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }

  // Cmd+C path: xterm's canvas renderer doesn't produce a real DOM selection,
  // so the browser's native copy event has nothing to copy. We first try the
  // DOM selection (in case a DOM-renderer build is in use), then fall back to
  // dispatching the synthetic Ctrl+Shift+C event that ttyd's own xterm
  // attachCustomKeyEventHandler already wires up for copy.
  function copySelection() {
    let domSelection = "";
    try {
      const sel = window.getSelection?.();
      domSelection = sel ? String(sel) : "";
    } catch (_err) {
      domSelection = "";
    }
    if (domSelection) {
      try {
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(domSelection).catch(() => {});
          return true;
        }
      } catch (_err) {
        // fall through to synthetic-event path
      }
    }
    const helper = document.querySelector(".xterm-helper-textarea");
    if (!helper) return false;
    const Ctor = window.KeyboardEvent;
    if (typeof Ctor !== "function") return false;
    const synthetic = new Ctor("keydown", {
      key: "C",
      code: "KeyC",
      keyCode: 67,
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    helper.dispatchEvent(synthetic);
    return true;
  }

  function onKeydown(event) {
    if (event.isComposing) return;
    const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
    if (key === "enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (sendInput("\n")) consume(event);
      return;
    }
    if (key === "a" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (sendInput("\x01")) consume(event);
      return;
    }
    if (isMac) {
      if (key === "backspace" && event.metaKey && !event.ctrlKey && !event.altKey) {
        if (sendInput("\x15")) consume(event);
        return;
      }
      if (key === "arrowleft" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (sendInput("\x01")) consume(event);
        return;
      }
      if (key === "arrowright" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (sendInput("\x05")) consume(event);
        return;
      }
      if (key === "c" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (copySelection()) consume(event);
        return;
      }
    }
  }

  // Single registration on `document` at capture phase: every key event the
  // user types in the iframe passes through document's capture phase before
  // reaching xterm's textarea, so one listener is enough. Registering on
  // both `window` and `document` would double-fire each shortcut, because
  // stopImmediatePropagation only stops same-target same-phase listeners.
  document.addEventListener("keydown", onKeydown, true);
})();
