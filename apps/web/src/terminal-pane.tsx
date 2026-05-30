import type { AgentSession } from "@citadel/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { postTerminalShortcutMessage } from "./terminal-shortcut-bridge.js";
import { useResolvedTheme } from "./use-resolved-theme.js";

type TerminalError = {
  code: string;
  detail: string;
};

export type TerminalSocketMessage = {
  type?: string;
  data?: string;
};

const RUNBOOK_URL = "/docs/operations/terminal-runbook";
const XTERM_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";

/**
 * Per-session handle used by Stage tabs to drive a live terminal WebSocket.
 * The in-pane status bar was removed; these affordances live on the tab now
 * and need access to state owned by TerminalPane, so we publish a tiny
 * registry on the window.
 *
 * Keyed by session id. TerminalPane registers on mount and clears on unmount.
 */
export type TerminalHandle = {
  reload: () => void;
  // Historical name kept for Stage callers; now focuses the in-process xterm.
  focusIframe: () => void;
  recoverIfDisconnected: () => boolean;
};

const REGISTRY = new Map<string, TerminalHandle>();
const LISTENERS = new Set<(id: string) => void>();

function publish(id: string, handle: TerminalHandle | null) {
  if (handle) {
    REGISTRY.set(id, handle);
  } else {
    REGISTRY.delete(id);
  }
  for (const listener of LISTENERS) listener(id);
}

export function getTerminalHandle(sessionId: string): TerminalHandle | undefined {
  return REGISTRY.get(sessionId);
}

export function subscribeTerminalHandle(listener: (sessionId: string) => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

export function isRegisteredTerminalMessageSource(
  _source: MessageEventSource | null,
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && REGISTRY.has(sessionId));
}

// Focus the terminal of an active session. No-op when:
//   - sessionId is null/undefined (workspace has no active session)
//   - no handle is registered (session not yet mounted)
//   - document.activeElement is a text input or contenteditable (don't steal
//     focus while the user is typing — e.g. inline workspace-title rename).
export function focusActiveTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const handle = REGISTRY.get(sessionId);
  if (!handle) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  if (active instanceof HTMLElement && active.isContentEditable) return;
  handle.focusIframe();
}

export function TerminalPane(props: { session: AgentSession }) {
  const sessionId = props.session.id;
  const theme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const themeRef = useRef(theme);
  const encoderRef = useRef(new TextEncoder());
  const decoderRef = useRef(new TextDecoder());
  themeRef.current = theme;
  const [connectionState, setConnectionState] = useState<"connecting" | "attached">("connecting");
  const [error, setError] = useState<TerminalError | null>(null);
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  const focusIframe = useCallback(() => {
    terminalRef.current?.focus();
  }, []);

  const recoverIfDisconnected = useCallback(() => {
    if (!error || !["terminal_disconnected", "terminal_closed", "terminal_socket_error"].includes(error.code)) {
      return false;
    }
    reload();
    return true;
  }, [error, reload]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    void generation;
    const host = containerRef.current;
    if (!host) return;
    let disposed = false;
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      fontFamily: XTERM_FONT,
      fontSize: 13,
      scrollback: 5000,
      theme: xtermTheme(themeRef.current),
    });
    const fit = new FitAddon();
    const ws = new WebSocket(terminalWebSocketUrl(sessionId));
    ws.binaryType = "arraybuffer";
    terminalRef.current = terminal;
    fitRef.current = fit;
    wsRef.current = ws;
    terminal.loadAddon(fit);
    terminal.open(host);
    setConnectionState("connecting");
    setError(null);

    const sendResize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            sendResize();
          });
    resizeObserver?.observe(host);
    window.addEventListener("resize", sendResize);
    terminal.attachCustomKeyEventHandler((event) => handleTerminalKeyEvent(event, terminal, sessionId, ws));
    const inputDisposable = terminal.onData((data) => {
      if (data.includes("\u0003")) recordTerminalUserAction(sessionId, "ctrl_c");
      if (ws.readyState === WebSocket.OPEN) ws.send(encoderRef.current.encode(data));
    });

    ws.addEventListener("open", () => {
      if (disposed) return;
      setConnectionState("attached");
      sendResize();
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        void writeTerminalBinary(event.data, terminal, decoderRef.current);
        return;
      }
      const message = parseTerminalSocketMessage(event.data);
      if (!message) {
        terminal.write(event.data);
        return;
      }
      if (message.type === "error") {
        setError({ code: message.data || "terminal_unavailable", detail: message.data ?? "" });
      } else if (message.type === "exit") {
        setError({ code: "terminal_closed", detail: message.data ?? "Terminal bridge closed." });
      }
    });
    ws.addEventListener("close", (event) => {
      if (disposed) return;
      recordTerminalClientEvent(sessionId, "websocket.close", { code: event.code, reason: event.reason });
      setError({
        code: "terminal_disconnected",
        detail: event.reason || `Terminal WebSocket closed with code ${event.code}.`,
      });
    });
    ws.addEventListener("error", () => {
      if (disposed) return;
      recordTerminalClientEvent(sessionId, "websocket.error");
      setError({ code: "terminal_socket_error", detail: "Terminal WebSocket failed." });
    });
    window.setTimeout(sendResize, 0);
    return () => {
      disposed = true;
      inputDisposable.dispose();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", sendResize);
      ws.close();
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [sessionId, generation]);

  // Publish the live URL + reload/focus/recover callbacks so nav selection and
  // tab actions can drive state owned by TerminalPane.
  // The status bar used to render these affordances inside the pane; that was
  // removed in favour of the tab actions, but the state still lives here.
  useEffect(() => {
    publish(sessionId, { reload, focusIframe, recoverIfDisconnected });
    return () => publish(sessionId, null);
  }, [sessionId, reload, focusIframe, recoverIfDisconnected]);
  return (
    <div className="terminal-shell">
      <div className="terminal-surface">
        <div
          ref={containerRef}
          className={`terminal-xterm-host ${error ? "terminal-xterm-obscured" : ""}`}
          aria-label={`Terminal ${props.session.displayName}`}
        />
        {!error && connectionState === "connecting" ? (
          <div className="terminal-pending">Connecting terminal…</div>
        ) : null}
        {error ? (
          <TerminalErrorState error={error} onRetry={reload} retrying={connectionState === "connecting"} />
        ) : null}
      </div>
    </div>
  );
}

export function terminalWebSocketUrl(sessionId: string, location: Location = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/terminal/${encodeURIComponent(sessionId)}`;
}

function TerminalErrorState(props: { error: TerminalError; onRetry: () => void; retrying: boolean }) {
  const { code, detail } = props.error;
  const guidance = guidanceFor(code);
  return (
    <div className="terminal-error-state" role="alert">
      <h3>Terminal unavailable</h3>
      <p className="terminal-error-code">{code}</p>
      {detail ? <p className="terminal-error-detail">{detail}</p> : null}
      <p className="terminal-error-guidance">{guidance}</p>
      <div className="terminal-error-actions">
        <Button type="button" onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? "Retrying…" : "Retry"}
        </Button>
        <a className="terminal-error-link" href="/settings" title="Open Citadel settings">
          Open settings
        </a>
        <a className="terminal-error-link" href={RUNBOOK_URL} title="Terminal runbook">
          Runbook
        </a>
      </div>
    </div>
  );
}

function guidanceFor(code: string) {
  switch (code) {
    case "terminal_disconnected":
    case "terminal_socket_error":
      return "The terminal WebSocket disconnected. Retry reconnects to the same tmux session.";
    case "terminal_closed":
      return "The terminal bridge closed. Retry reconnects if the underlying tmux session is still present.";
    case "tmux_session_missing":
      return "The tmux session this terminal would attach to no longer exists. Restart the agent session or reconcile.";
    case "session_not_found":
      return "This Citadel session is not registered. Refresh or recreate it from the cockpit.";
    case "spawn_failed":
      return "The terminal PTY failed to spawn. Verify tmux is installed and reachable from the daemon environment.";
    default:
      return "Open the terminal runbook below for diagnostic steps.";
  }
}

function handleTerminalKeyEvent(event: KeyboardEvent, terminal: Terminal, sessionId: string, ws: WebSocket): boolean {
  if (event.type !== "keydown" || event.isComposing) return true;
  const key = event.key.toLowerCase();
  if (key === "k" && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
    postTerminalShortcutMessage("command-palette", sessionId);
    return false;
  }
  if (key === "s" && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey) {
    postTerminalShortcutMessage("scratchpad-toggle", sessionId);
    return false;
  }
  if (key === "n" && event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
    postTerminalShortcutMessage("new-workspace", sessionId);
    return false;
  }
  if (key === "enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
    sendTerminalInput(ws, SHIFT_ENTER_SEQUENCE);
    return false;
  }
  if (isMacPlatform()) {
    if (key === "backspace" && event.metaKey && !event.ctrlKey && !event.altKey) {
      sendTerminalInput(ws, "\u0015");
      return false;
    }
    if (key === "arrowleft" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      sendTerminalInput(ws, "\u0001");
      return false;
    }
    if (key === "arrowright" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      sendTerminalInput(ws, "\u0005");
      return false;
    }
    if (key === "c" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      copyTerminalSelection(terminal);
      return false;
    }
    if (key === "v" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      void pasteClipboardIntoTerminal(ws);
      return false;
    }
    if (key === "a" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      terminal.selectAll();
      return false;
    }
  }
  return true;
}

function sendTerminalInput(ws: WebSocket, data: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
}

async function writeTerminalBinary(data: unknown, terminal: Terminal, decoder: TextDecoder): Promise<void> {
  if (data instanceof ArrayBuffer) {
    terminal.write(decoder.decode(data));
    return;
  }
  if (data instanceof Blob) {
    terminal.write(decoder.decode(await data.arrayBuffer()));
  }
}

function copyTerminalSelection(terminal: Terminal): void {
  const selection = terminal.getSelection();
  if (!selection) return;
  void navigator.clipboard?.writeText(selection).catch(() => undefined);
}

async function pasteClipboardIntoTerminal(ws: WebSocket): Promise<void> {
  const text = await navigator.clipboard?.readText().catch(() => "");
  if (text) sendTerminalInput(ws, text);
}

function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");
}

export function parseTerminalSocketMessage(raw: unknown): TerminalSocketMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as TerminalSocketMessage;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function xtermTheme(theme: "light" | "dark") {
  return theme === "light" ? LIGHT_XTERM_THEME : DARK_XTERM_THEME;
}

const LIGHT_XTERM_THEME = {
  background: "#f5f1e8",
  foreground: "#1a1814",
  cursor: "#14171f",
  cursorAccent: "#f5f1e8",
  selectionBackground: "rgba(20, 23, 31, 0.18)",
  black: "#1a1814",
  red: "#9a1d12",
  green: "#36680c",
  yellow: "#825507",
  blue: "#194d8e",
  magenta: "#5f2a7a",
  cyan: "#0a5d6e",
  white: "#1a1814",
  brightBlack: "#4a463e",
  brightRed: "#b8281c",
  brightGreen: "#4a8a14",
  brightYellow: "#a06b0a",
  brightBlue: "#2864ad",
  brightMagenta: "#7d3a98",
  brightCyan: "#0f7d92",
  brightWhite: "#0c0a06",
};

const DARK_XTERM_THEME = {
  background: "#1a1814",
  foreground: "#e8e3d3",
  cursor: "#f0ebdd",
  cursorAccent: "#1a1814",
  selectionBackground: "rgba(240, 235, 221, 0.18)",
  black: "#1a1814",
  red: "#ec7468",
  green: "#a3d364",
  yellow: "#e8b552",
  blue: "#7eb5e4",
  magenta: "#c896d4",
  cyan: "#7dbedc",
  white: "#e8e3d3",
  brightBlack: "#948d7b",
  brightRed: "#ff8d80",
  brightGreen: "#bbe683",
  brightYellow: "#f5c66a",
  brightBlue: "#a2cef0",
  brightMagenta: "#dcb1e4",
  brightCyan: "#9ad0e8",
  brightWhite: "#fffaef",
};

function recordTerminalClientEvent(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  fetch(`/api/agent-sessions/${encodeURIComponent(sessionId)}/terminal-client-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event,
      ...extra,
      path: window.location.pathname,
      visibility: document.visibilityState,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

function recordTerminalUserAction(sessionId: string, reason: string) {
  fetch(`/api/agent-sessions/${encodeURIComponent(sessionId)}/user-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
    keepalive: true,
  }).catch(() => undefined);
}
