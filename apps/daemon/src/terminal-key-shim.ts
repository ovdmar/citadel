// Injected into ttyd's HTML so it executes before ttyd's bundle. We wrap
// `window.WebSocket` to capture the input channel ttyd opens at `/ws`, then
// translate the keyboard shortcuts ttyd/xterm.js do not handle the way users
// expect inside Citadel's embedded terminal:
//
//   - Shift+Enter  -> send LF (newline, soft break) instead of CR (submit)
//   - Ctrl+A       -> send SOH (start of line) even when the browser would
//                     otherwise treat it as "select all"
//   - Cmd+Backspace (mac) -> Ctrl+U (kill line backward)
//   - Cmd+Left  (mac)     -> Ctrl+A (start of line)
//   - Cmd+Right (mac)     -> Ctrl+E (end of line)
//
// ttyd frames input as a binary message: byte 0 is `0` (Command.INPUT),
// followed by the UTF-8 encoded payload.
export const TERMINAL_KEY_SHIM_SOURCE = `(function () {
  if (window.__citadelTerminalShim) return;
  window.__citadelTerminalShim = true;

  var isMac = /Mac|iPhone|iPad/i.test(navigator.platform || "") || /Macintosh/i.test(navigator.userAgent || "");
  var activeWs = null;
  var textEncoder = new TextEncoder();

  var OriginalWebSocket = window.WebSocket;
  function CitadelWebSocket(url, protocols) {
    var ws = protocols === undefined ? new OriginalWebSocket(url) : new OriginalWebSocket(url, protocols);
    if (typeof url === "string" && /\\/ws(\\?|$)/.test(url)) {
      activeWs = ws;
      ws.addEventListener("close", function () {
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
    var ws = activeWs;
    if (!ws || ws.readyState !== 1) return false;
    var encoded = textEncoder.encode(text);
    var payload = new Uint8Array(encoded.length + 1);
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

  function onKeydown(event) {
    if (event.isComposing) return;
    if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (sendInput("\\n")) consume(event);
      return;
    }
    if ((event.key === "a" || event.key === "A") && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey) {
      if (sendInput("\\x01")) consume(event);
      return;
    }
    if (isMac) {
      if (event.key === "Backspace" && event.metaKey && !event.ctrlKey && !event.altKey) {
        if (sendInput("\\x15")) consume(event);
        return;
      }
      if (event.key === "ArrowLeft" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (sendInput("\\x01")) consume(event);
        return;
      }
      if (event.key === "ArrowRight" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (sendInput("\\x05")) consume(event);
        return;
      }
    }
  }

  window.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keydown", onKeydown, true);
})();`;

// Inject the shim into ttyd's index page so it runs before any other script
// tag (ttyd's bundle opens its WebSocket as soon as it executes).
export function injectKeyShim(html: string): string {
  if (html.includes("__citadelTerminalShim")) return html;
  const inject = `<script>${TERMINAL_KEY_SHIM_SOURCE}</script>`;
  const firstScript = html.search(/<script[\s>]/i);
  if (firstScript !== -1) {
    return html.slice(0, firstScript) + inject + html.slice(firstScript);
  }
  const headClose = html.search(/<\/head>/i);
  if (headClose !== -1) {
    return html.slice(0, headClose) + inject + html.slice(headClose);
  }
  return inject + html;
}
