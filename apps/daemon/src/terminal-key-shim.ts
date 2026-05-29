import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The shim itself lives in `terminal-key-shim.client.js` so editors lint and
// highlight it as real JavaScript. We slurp it once at module-init time. See
// the client file for the actual logic; documented behavior:
//
//   1. Forwarding block (runs first). Chords in `FORWARDABLE_CHORDS` — the
//      mirror of @citadel/contracts's shortcut registry — are dispatched as
//      synthetic KeyboardEvents on `window.parent` so the cockpit's global
//      key handler fires even when xterm has focus. Escape is forwarded
//      only when `window.parent.__citadelOverlayOpen > 0` and is always
//      passed through to xterm as well (vim/Claude rely on Esc).
//
//   2. Translation block (runs after the forwarding block, mutually
//      exclusive with it):
//        - Shift+Enter  -> send LF (newline, soft break) instead of CR (submit)
//        - Ctrl+A       -> send SOH (start of line) even when the browser
//                          would otherwise treat it as "select all"
//        - Cmd+Backspace (mac) -> Ctrl+U (kill line backward)
//        - Cmd+Left  (mac)     -> Ctrl+A (start of line)
//        - Cmd+Right (mac)     -> Ctrl+E (end of line)
//        - Cmd+C     (mac)     -> route through ttyd's Ctrl+Shift+C copy handler
//                                  so xterm's selection (no DOM selection in canvas
//                                  renderer) actually reaches the clipboard
//        - Cmd+V     (mac)     -> read system clipboard, send to PTY wrapped in
//                                  bracketed-paste escapes so multi-line pastes
//                                  don't auto-submit between lines
//        - Cmd+A     (mac)     -> select all visible terminal content (matches
//                                  Mac Terminal.app); falls back to a DOM Range
//                                  scoped to .xterm-screen so the selection is
//                                  terminal-scoped instead of iframe-chrome-scoped
//
//   3. OSC 52 bridge. For sessions where tmux owns mouse scrollback,
//      `buildAttachCommand` in `packages/terminal/src/ttyd.ts` enables
//      `set-clipboard on`, and tmux emits OSC 52 escapes for copy-mode
//      selections. The shim sniffs the ttyd WebSocket stream for
//      `ESC ] 52 ; <id> ; <base64> BEL` and writes the decoded text via
//      `navigator.clipboard.writeText`.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const TERMINAL_KEY_SHIM_SOURCE = fs.readFileSync(resolve(__dirname, "terminal-key-shim.client.js"), "utf8");

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

// Decide whether a proxied response is a candidate for HTML rewriting. We
// only mutate 200 responses whose content-type is text/html AND that are
// not transport-compressed; mutating a gzipped body without re-encoding (or
// silently producing a body for 204/304 responses) would corrupt the stream.
export function shouldInjectShim(headers: Record<string, string | string[] | undefined>, statusCode: number): boolean {
  if (statusCode !== 200) return false;
  const rawType = headers["content-type"];
  const contentType = String(Array.isArray(rawType) ? rawType[0] : (rawType ?? ""));
  if (!contentType.toLowerCase().includes("text/html")) return false;
  const rawEncoding = headers["content-encoding"];
  const encoding = String(Array.isArray(rawEncoding) ? rawEncoding[0] : (rawEncoding ?? ""))
    .trim()
    .toLowerCase();
  if (encoding && encoding !== "identity") return false;
  return true;
}
