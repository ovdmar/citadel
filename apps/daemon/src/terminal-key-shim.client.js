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

  // Read the clipboard and inject it into the PTY wrapped in bracketed-paste
  // escapes (\x1b[200~ ... \x1b[201~). Every modern shell (bash >=4.4, zsh,
  // fish) and TUI (Claude Code, Codex, vim, etc.) understands bracketed
  // paste, and it prevents multi-line pastes from auto-submitting between
  // lines. Async by necessity — clipboard.readText is a Promise — but the
  // caller calls consume() synchronously so the browser's default paste
  // never fires alongside.
  function pasteFromClipboard() {
    if (!navigator.clipboard?.readText) return false;
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) sendInput(`\x1b[200~${text}\x1b[201~`);
      })
      .catch(() => {});
    return true;
  }

  // Cmd+A in the iframe currently selects the entire iframe body (including
  // the surrounding cockpit chrome), which is rarely what the user wants.
  // We can't reliably "select only the current prompt" without OSC 133
  // shell-integration markers, so we match Mac Terminal.app's convention:
  // select all visible terminal content. If ttyd's build exposes the xterm
  // Terminal instance on window.term we use its selectAll(); otherwise we
  // fall back to a DOM Range scoped to .xterm-screen so at minimum the
  // selection is terminal-scoped, not iframe-scoped.
  function selectAllInTerminal() {
    const term = window.term;
    if (term && typeof term.selectAll === "function") {
      try {
        term.selectAll();
        return true;
      } catch (_err) {
        // fall through to DOM-range path
      }
    }
    const screen = document.querySelector(".xterm-screen") || document.querySelector(".xterm");
    const selection = window.getSelection?.();
    if (!screen || !selection || typeof document.createRange !== "function") return false;
    try {
      const range = document.createRange();
      range.selectNodeContents(screen);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (_err) {
      return false;
    }
  }

  // Cmd+C path: xterm's canvas renderer doesn't produce a real DOM selection,
  // so window.getSelection() is empty for anything inside the terminal. The
  // real selection lives in xterm's internal model and is only reachable via
  // term.getSelection(). ttyd exposes the xterm instance on window.term, so
  // we read it from there and write directly to the clipboard. We still
  // check window.getSelection() as a fallback for the (rare) DOM-renderer
  // xterm build and for selections that span surrounding chrome.
  function copySelection() {
    let text = "";
    const term = window.term;
    if (term && typeof term.getSelection === "function") {
      try {
        text = term.getSelection() || "";
      } catch (_err) {
        text = "";
      }
    }
    if (!text) {
      try {
        const sel = window.getSelection?.();
        text = sel ? String(sel) : "";
      } catch (_err) {
        text = "";
      }
    }
    if (!text) return false;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
    // Last-resort legacy path for browsers without the async clipboard API.
    try {
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.opacity = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(helper);
      return ok;
    } catch (_err) {
      return false;
    }
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
      if (key === "v" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (pasteFromClipboard()) consume(event);
        return;
      }
      if (key === "a" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (selectAllInTerminal()) consume(event);
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

  // OSC 52 bridge: when tmux runs with `set-clipboard on` (we enable that in
  // buildAttachCommand), every copy-mode/mouse selection inside tmux is
  // forwarded to the terminal as `ESC ] 52 ; c ; <base64> BEL`. xterm.js
  // does not write OSC 52 payloads to the system clipboard by default, so
  // we register our own OSC 52 handler that decodes the base64 and writes
  // via navigator.clipboard. This is what makes "select inside Claude Code
  // / vim / any TUI" actually land on the macOS clipboard, even though the
  // selection lives inside tmux and never reaches xterm's own selection
  // model. The terminal is polled with retries because window.term is
  // assigned by ttyd asynchronously after the page boots.
  const registerOsc52 = () => {
    const term = window.term;
    if (!term?.parser?.registerOscHandler) return false;
    try {
      term.parser.registerOscHandler(52, (data) => {
        if (typeof data !== "string") return false;
        // Format: "<clipboard-id>;<base64>" — clipboard-id is c/p/s/etc.
        // Empty base64 means "the source app is asking for the clipboard
        // contents" (read request). We ignore reads (security) and only
        // honor writes.
        const semi = data.indexOf(";");
        if (semi < 0) return false;
        const b64 = data.slice(semi + 1);
        if (!b64) return true;
        let text = "";
        try {
          text = atob(b64);
          // OSC 52 payloads are bytes; treat as UTF-8 if possible.
          try {
            text = new TextDecoder().decode(Uint8Array.from(text, (c) => c.charCodeAt(0)));
          } catch (_err) {
            // best-effort: keep the raw atob output
          }
        } catch (_err) {
          return false;
        }
        if (!text) return true;
        try {
          if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
        } catch (_err) {
          // ignore — clipboard requires secure context + iframe allow
        }
        return true;
      });
      return true;
    } catch (_err) {
      return false;
    }
  };
  let osc52Tries = 0;
  const osc52Timer = setInterval(() => {
    osc52Tries += 1;
    if (registerOsc52() || osc52Tries > 40) clearInterval(osc52Timer);
  }, 250);
})();
