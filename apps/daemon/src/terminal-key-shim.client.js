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
  const loadedAt = Date.now();
  let terminalClientEventCount = 0;
  let lastTerminalClientEventAt = 0;

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
      ws.addEventListener("close", (event) => {
        recordTerminalClientEvent("ws.close", {
          code: event?.code,
          reason: event?.reason,
          wasClean: event?.wasClean,
        });
        if (activeWs === ws) activeWs = null;
      });
      ws.addEventListener("error", () => {
        recordTerminalClientEvent("ws.error", {});
      });
      // ttyd's WebSocket frames look like: 1-byte command + payload. Output
      // frames start with '0' (0x30) and the payload is the raw PTY byte
      // stream — every terminal escape, including OSC 52 from tmux when
      // set-clipboard is on. Sniff for OSC 52 here as a fallback to the
      // xterm.parser path below, because ttyd's bundled xterm does NOT
      // enable allowProposedApi, so term.parser.registerOscHandler often
      // silently does nothing.
      ws.addEventListener("message", (event) => {
        try {
          extractOsc52(event.data);
        } catch (_err) {
          // never let clipboard handling break terminal IO
        }
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

  // Accumulator for OSC 52 sequences that may span multiple WS frames.
  // Reset whenever an unrelated byte appears mid-collection so we don't grow
  // unbounded if the sniffer is wrong about where a sequence ends.
  let osc52Buf = "";
  let osc52Active = false;
  const OSC52_PREFIX = "\x1b]52;";
  const OSC52_BEL = "\x07";
  const OSC52_ST = "\x1b\\";

  // Dedupe rapid duplicate writes — both the WS sniff and the xterm OSC
  // handler may extract the same payload from the same emit, and Cmd+C may
  // also re-write the same selection. We skip if the same text was written
  // within the last 500ms.
  let lastClipboardText = "";
  let lastClipboardAt = 0;
  function writeClipboard(text) {
    if (!text || !navigator.clipboard?.writeText) return;
    const now = Date.now();
    if (text === lastClipboardText && now - lastClipboardAt < 500) return;
    lastClipboardText = text;
    lastClipboardAt = now;
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function decodeOsc52Payload(payload) {
    // payload looks like "<targets>;<base64>" where targets is e.g. "c", "p",
    // "s", or empty. We ignore reads (empty base64 == read request).
    const semi = payload.indexOf(";");
    if (semi < 0) return "";
    const b64 = payload.slice(semi + 1).replace(/\s+/g, "");
    if (!b64) return "";
    try {
      const raw = atob(b64);
      try {
        return new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0)));
      } catch (_err) {
        return raw;
      }
    } catch (_err) {
      return "";
    }
  }

  function flushOsc52(payload) {
    osc52Active = false;
    osc52Buf = "";
    const text = decodeOsc52Payload(payload);
    if (text) writeClipboard(text);
  }

  function consumeOsc52(text) {
    let i = 0;
    while (i < text.length) {
      if (!osc52Active) {
        const start = text.indexOf(OSC52_PREFIX, i);
        if (start < 0) return;
        osc52Active = true;
        osc52Buf = "";
        i = start + OSC52_PREFIX.length;
        continue;
      }
      // Collect until BEL or ST.
      const belAt = text.indexOf(OSC52_BEL, i);
      const stAt = text.indexOf(OSC52_ST, i);
      let end = -1;
      let endLen = 0;
      if (belAt >= 0 && (stAt < 0 || belAt < stAt)) {
        end = belAt;
        endLen = 1;
      } else if (stAt >= 0) {
        end = stAt;
        endLen = 2;
      }
      if (end < 0) {
        osc52Buf += text.slice(i);
        if (osc52Buf.length > 8_000_000) {
          // 8 MB ceiling — if we never see a terminator something is wrong.
          osc52Active = false;
          osc52Buf = "";
        }
        return;
      }
      osc52Buf += text.slice(i, end);
      const payload = osc52Buf;
      flushOsc52(payload);
      i = end + endLen;
    }
  }

  function extractOsc52(data) {
    if (typeof data === "string") {
      // ttyd may use binary frames, but be defensive.
      if (data.length > 0 && data.charCodeAt(0) === 48) consumeOsc52(data.slice(1));
      return;
    }
    let bytes;
    if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      data
        .arrayBuffer()
        .then((ab) => extractOsc52(ab))
        .catch(() => {});
      return;
    } else {
      return;
    }
    if (bytes.byteLength === 0 || bytes[0] !== 48) return; // not an OUTPUT frame
    // Decode the payload as Latin-1 so escape bytes stay 1:1 with chars.
    let text = "";
    for (let k = 1; k < bytes.byteLength; k += 1) text += String.fromCharCode(bytes[k]);
    consumeOsc52(text);
  }

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
  // xterm clears its selection on every re-render. TUIs that redraw the
  // screen frequently — Claude Code's ink/React TUI is the worst offender —
  // therefore lose the selection between mouseup and the moment the user
  // presses Cmd+C, so term.getSelection() returns "". We mirror the live
  // selection into lastTermSelection on every onSelectionChange and fall
  // back to it (capped at 5 seconds) when the live read is empty.
  let lastTermSelection = "";
  let lastTermSelectionAt = 0;
  const watchTermSelection = () => {
    const term = window.term;
    if (!term || typeof term.onSelectionChange !== "function") return false;
    try {
      term.onSelectionChange(() => {
        try {
          const s = typeof term.getSelection === "function" ? term.getSelection() : "";
          if (s) {
            lastTermSelection = s;
            lastTermSelectionAt = Date.now();
          }
        } catch (_err) {
          /* ignore */
        }
      });
      // While we're here, force Option-drag on Mac to bypass any inner
      // mouse-event capture so a drag always creates an xterm selection,
      // even when the TUI has mouse mode enabled.
      try {
        if (term.options) term.options.macOptionClickForcesSelection = true;
      } catch (_err) {
        /* ignore */
      }
      return true;
    } catch (_err) {
      return false;
    }
  };
  let watchTries = 0;
  const watchTimer = setInterval(() => {
    watchTries += 1;
    if (watchTermSelection() || watchTries > 40) clearInterval(watchTimer);
  }, 250);

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
    if (!text && lastTermSelection && Date.now() - lastTermSelectionAt < 5000) {
      text = lastTermSelection;
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
    // Shell-first lifecycle signal: Ctrl+C inside the embedded terminal is
    // the dominant operator-initiated agent stop. Fire-and-forget a POST to
    // the user-action endpoint so the daemon's status-monitor knows the
    // subsequent `running → idle` transition was operator-initiated (and
    // doesn't mis-label it as `idle_after_unexpected_exit`). Do NOT
    // consume(event) — the 0x03 byte must continue propagating to xterm so
    // it reaches the PTY exactly as today.
    if (key === "c" && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      recordUserAction("ctrl_c");
      // fall through — no consume(); xterm handles the 0x03.
    }
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

  try {
    window.addEventListener(
      "pagehide",
      (event) => {
        recordTerminalClientEvent("pagehide", { persisted: event?.persisted });
      },
      { capture: true },
    );
  } catch (_err) {
    // Browsers without pagehide support still report WebSocket close events.
  }

  // Derive the sessionId from the iframe's URL path. ttyd is mounted at
  // `/terminals/<sessionId>/` (see packages/terminal/src/ttyd.ts:147 — basePath
  // is `${basePathPrefix}/<sessionId>`). Cached at module init since the URL
  // never changes for a given iframe's lifetime. Defensive against test
  // runtimes that don't provide window.location (the shim is eval'd inside a
  // jsdom-lite Function() in apps/daemon/src/terminal-key-shim.test.ts).
  const SESSION_ID = (() => {
    try {
      const pathname = window.location?.pathname || "";
      const match = /^\/terminals\/([^/]+)/.exec(pathname);
      return match ? decodeURIComponent(match[1]) : null;
    } catch (_err) {
      return null;
    }
  })();

  // Fire-and-forget POST to the user-action endpoint. The daemon writes the
  // session's entry in `recentUserAction` so the next status-monitor tick
  // sees the operator action and clears `statusReason` instead of labelling
  // the resulting `running → idle` as `idle_after_unexpected_exit`. Errors
  // are silently swallowed — the worst case is a single mis-labelled
  // session that auto-clears in 30 min.
  function recordUserAction(reason) {
    if (!SESSION_ID) return;
    try {
      fetch(`/api/agent-sessions/${encodeURIComponent(SESSION_ID)}/user-action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
        keepalive: true,
      }).catch(() => {});
    } catch (_err) {
      // Network constructed-call errors are swallowed; the user's keystroke
      // already propagated to ttyd.
    }
  }

  // Browser-side lifecycle breadcrumbs for the daemon diagnostics log. The
  // server sees only TCP close/end; this records the close code plus whether
  // the iframe itself is being hidden/navigated.
  function recordTerminalClientEvent(event, data) {
    if (!SESSION_ID) return;
    const now = Date.now();
    if (terminalClientEventCount >= 100) return;
    if (terminalClientEventCount >= 20 && now - lastTerminalClientEventAt < 5000) return;
    terminalClientEventCount += 1;
    lastTerminalClientEventAt = now;
    const payload = {
      event,
      ...data,
      ageMs: now - loadedAt,
      visibility: document.visibilityState || "unknown",
      path: window.location?.pathname || "",
    };
    const url = `/api/agent-sessions/${encodeURIComponent(SESSION_ID)}/terminal-client-event`;
    try {
      const body = JSON.stringify(payload);
      if (navigator.sendBeacon && typeof Blob !== "undefined") {
        const sent = navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        if (sent) return;
      }
      if (typeof fetch === "function") {
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (_err) {
      // Diagnostics must never affect terminal input or reconnect behavior.
    }
  }

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
