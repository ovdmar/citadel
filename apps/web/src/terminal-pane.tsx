import type { WorkspaceSession } from "@citadel/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { isElementVoiceVisible } from "./lib/voice-targets.js";
import { matchShortcut } from "./shortcuts.js";
import { writeTerminalBinary } from "./terminal-binary-writer.js";
import { type TerminalHandle, publishTerminalHandle, registerTerminalHost } from "./terminal-pane-registry.js";
import { addTerminalResumeReconnectListeners } from "./terminal-resume-reconnect.js";
import { postTerminalShortcutMessage } from "./terminal-shortcut-bridge.js";
import { type TerminalSocketMessage, parseTerminalSocketMessage } from "./terminal-socket-message.js";
import { xtermTheme } from "./terminal-theme.js";
import { readOverlayCount } from "./use-overlay-present.js";
import { useResolvedTheme } from "./use-resolved-theme.js";
export {
  focusActiveTerminal,
  getDefaultVoiceTerminalSessionId,
  getFocusedTerminalSessionId,
  getTerminalHandle,
  isRegisteredTerminalMessageSource,
  setDefaultVoiceTerminalSession,
  subscribeTerminalHandle,
} from "./terminal-pane-registry.js";
export type { TerminalHandle } from "./terminal-pane-registry.js";

type TerminalError = {
  code: string;
  detail: string;
};

const RUNBOOK_URL = "/docs/operations/terminal-runbook";
const XTERM_FONT = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const SHIFT_ENTER_INPUT = "\n";
const CODEX_SHIFT_ENTER_INPUT = "\u001b[13;2u";
const LINE_START_KEY = "C-a";
const LINE_END_KEY = "C-e";
const LINE_KILL_KEY = "C-u";
const TERMINAL_SCROLLBACK_LINES = 20_000;
const TERMINAL_WHEEL_PIXELS_PER_LINE = 12;
const TERMINAL_WHEEL_LINES_PER_LINE_DELTA = 3;
const TERMINAL_WHEEL_ACCELERATION_THRESHOLD_LINES = 6;
const TERMINAL_WHEEL_ACCELERATION_MULTIPLIER = 1.5;
const TERMINAL_FAST_SCROLL_MULTIPLIER = 5;
const TERMINAL_MAX_SCROLL_LINES_PER_MESSAGE = 200;
const TERMINAL_AUTO_RETRY_LIMIT = 3;
const TERMINAL_AUTO_RETRY_BACKOFF_MS = 5_000;
const TERMINAL_PTY_INPUT_FLUSH_MS = 4;
const TERMINAL_RIGHT_EDGE_RESERVED_COLUMNS = 2;
const AUTO_RETRYABLE_TERMINAL_ERRORS = new Set(["terminal_disconnected", "terminal_socket_error"]);
const RUNTIME_MOUSE_EVENT_RUNTIMES = new Set(["claude-code"]);
export type TerminalPaneKey = typeof LINE_START_KEY | typeof LINE_END_KEY | typeof LINE_KILL_KEY;
export { parseTerminalSocketMessage };
export type { TerminalSocketMessage };

/**
 * Per-session handle used by Stage tabs and Shell-level voice dictation to
 * drive a live terminal WebSocket. The in-pane status bar was removed; these
 * affordances live outside TerminalPane and need access to socket state owned
 * by TerminalPane, so module-level registries expose the active handles.
 *
 * Keyed by session id. TerminalPane registers on mount and clears on unmount.
 */
export function TerminalPane(props: { session: WorkspaceSession; active?: boolean }) {
  const sessionId = props.session.id;
  const sessionRuntimeId = props.session.runtimeId;
  const active = props.active ?? true;
  const theme = useResolvedTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const themeRef = useRef(theme);
  const encoderRef = useRef(new TextEncoder());
  const autoRetryAttemptsRef = useRef(0);
  const autoRetryTimerRef = useRef<number | null>(null);
  const requestResizeRef = useRef<(() => void) | null>(null);
  const forwardWheelToRuntime = shouldForwardWheelToRuntime(props.session);
  themeRef.current = theme;
  const [connectionState, setConnectionState] = useState<"connecting" | "attached" | "disconnected">("connecting");
  const [error, setError] = useState<TerminalError | null>(null);
  const [generation, setGeneration] = useState(0);
  const activeRef = useRef(active);
  const connectionStateRef = useRef(connectionState);
  const errorRef = useRef(error);
  const coalesceInput = props.session.terminalBackend === "pty-daemon";
  activeRef.current = active;
  connectionStateRef.current = connectionState;
  errorRef.current = error;

  const clearAutoRetryTimer = useCallback(() => {
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
  }, []);

  const reconnect = useCallback(() => {
    setGeneration((value) => value + 1);
  }, []);

  const reconnectOnResume = useCallback(() => {
    if (!activeRef.current) return;
    if (typeof document !== "undefined" && document.hidden) return;
    const ws = wsRef.current;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    autoRetryAttemptsRef.current = 0;
    clearAutoRetryTimer();
    recordTerminalClientEvent(sessionId, "websocket.resume_reconnect");
    reconnect();
  }, [clearAutoRetryTimer, reconnect, sessionId]);

  const reload = useCallback(() => {
    autoRetryAttemptsRef.current = 0;
    clearAutoRetryTimer();
    reconnect();
  }, [clearAutoRetryTimer, reconnect]);

  const scheduleAutoRetry = useCallback(
    (code: string) => {
      if (!AUTO_RETRYABLE_TERMINAL_ERRORS.has(code)) return;
      if (autoRetryTimerRef.current !== null) return;
      if (autoRetryAttemptsRef.current >= TERMINAL_AUTO_RETRY_LIMIT) return;
      autoRetryAttemptsRef.current += 1;
      const attempt = autoRetryAttemptsRef.current;
      autoRetryTimerRef.current = window.setTimeout(() => {
        autoRetryTimerRef.current = null;
        recordTerminalClientEvent(sessionId, "websocket.auto_retry", { attempt });
        reconnect();
      }, TERMINAL_AUTO_RETRY_BACKOFF_MS);
    },
    [reconnect, sessionId],
  );

  const focusIframe = useCallback(() => {
    terminalRef.current?.focus();
    recordTerminalClientEvent(sessionId, "terminal.focus");
  }, [sessionId]);

  const sendVoiceInput = useCallback((text: string, options: { submit: boolean }) => {
    const ws = wsRef.current;
    if (
      !canAcceptTerminalVoiceInput(
        containerRef.current,
        ws,
        activeRef.current,
        connectionStateRef.current,
        errorRef.current,
      )
    ) {
      return false;
    }
    sendTerminalInput(ws, text);
    if (options.submit) sendTerminalInput(ws, "\r");
    return true;
  }, []);

  const canAcceptVoiceInput = useCallback(() => {
    return canAcceptTerminalVoiceInput(
      containerRef.current,
      wsRef.current,
      activeRef.current,
      connectionStateRef.current,
      errorRef.current,
    );
  }, []);

  const recoverIfDisconnected = useCallback(() => {
    if (!error || !["terminal_disconnected", "terminal_closed", "terminal_socket_error"].includes(error.code)) {
      return false;
    }
    reload();
    return true;
  }, [error, reload]);

  useEffect(() => {
    void sessionId;
    autoRetryAttemptsRef.current = 0;
    clearAutoRetryTimer();
  }, [clearAutoRetryTimer, sessionId]);

  useEffect(() => clearAutoRetryTimer, [clearAutoRetryTimer]);

  useEffect(() => addTerminalResumeReconnectListeners(reconnectOnResume), [reconnectOnResume]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.options.theme = xtermTheme(theme);
  }, [theme]);

  useEffect(() => {
    void generation;
    const host = containerRef.current;
    if (!host) return;
    if (!active) {
      requestResizeRef.current = null;
      return;
    }
    const unregisterTerminalHost = registerTerminalHost(sessionId, host);
    let disposed = false;
    let resizeFrame: number | null = null;
    let wheelFrame: number | null = null;
    let wheelRemainder = 0;
    let pendingWheelLines = 0;
    let lastSentResize: { cols: number; rows: number } | null = null;
    let inputFlushTimer: number | null = null;
    let pendingInput = "";
    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: XTERM_FONT,
      fontSize: 13,
      fastScrollModifier: "alt",
      fastScrollSensitivity: TERMINAL_FAST_SCROLL_MULTIPLIER,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      smoothScrollDuration: 0,
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
    let latestSelectionText = "";
    const updateSelectionSnapshot = () => {
      latestSelectionText = terminal.hasSelection() ? terminal.getSelection() : "";
    };

    const runResize = () => {
      if (disposed) return;
      if (!activeRef.current) return;
      let fittedSize: ReturnType<FitAddon["proposeDimensions"]>;
      try {
        fittedSize = fit.proposeDimensions();
      } catch {
        return;
      }
      if (!fittedSize) return;
      const fittedCols = fittedSize.cols;
      const rows = fittedSize.rows;
      if (!Number.isFinite(fittedCols) || !Number.isFinite(rows) || fittedCols <= 0 || rows <= 0) return;
      const cols = terminalReadableCols(fittedCols);
      if (terminal.cols !== cols || terminal.rows !== rows) terminal.resize(cols, rows);
      if (lastSentResize?.cols === cols && lastSentResize.rows === rows) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
        lastSentResize = { cols, rows };
      }
    };

    const scheduleResize = () => {
      if (disposed || resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        runResize();
      });
    };
    requestResizeRef.current = scheduleResize;
    const flushWheelScroll = () => {
      wheelFrame = null;
      const lines = pendingWheelLines;
      pendingWheelLines = 0;
      sendTerminalScroll(ws, lines);
    };
    const clearInputFlushTimer = () => {
      if (inputFlushTimer !== null) {
        window.clearTimeout(inputFlushTimer);
        inputFlushTimer = null;
      }
    };
    const flushInput = (suffix = "") => {
      clearInputFlushTimer();
      const data = pendingInput + suffix;
      pendingInput = "";
      if (data && ws.readyState === WebSocket.OPEN) ws.send(encoderRef.current.encode(data));
    };
    const sendInput = (data: string) => {
      if (!shouldCoalesceTerminalInput(ws, data, coalesceInput)) {
        flushInput(data);
        return;
      }
      pendingInput += data;
      if (inputFlushTimer !== null) return;
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = null;
        flushInput();
      }, TERMINAL_PTY_INPUT_FLUSH_MS);
    };
    const scheduleWheelScroll = () => {
      if (disposed || wheelFrame !== null) return;
      wheelFrame = window.requestAnimationFrame(flushWheelScroll);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleResize();
          });
    resizeObserver?.observe(host);
    window.addEventListener("resize", scheduleResize);
    const nativeKeyHandler = (event: KeyboardEvent) => {
      if (!handleTerminalKeyEvent(event, terminal, sessionId, sessionRuntimeId, ws, host, latestSelectionText)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const nativeCopyHandler = (event: ClipboardEvent) => {
      copyTerminalSelection(event, terminal, host, latestSelectionText);
    };
    const nativeWheelHandler = (event: WheelEvent) => {
      const delta = wheelDeltaToLines(event, terminal.rows, wheelRemainder);
      if (!delta) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      wheelRemainder = delta.remainder;
      if (delta.lines === 0) return;
      pendingWheelLines += delta.lines;
      scheduleWheelScroll();
    };
    const selectionDisposable = terminal.onSelectionChange(updateSelectionSnapshot);
    host.addEventListener("keydown", nativeKeyHandler, true);
    if (!forwardWheelToRuntime) host.addEventListener("wheel", nativeWheelHandler, { capture: true, passive: false });
    document.addEventListener("copy", nativeCopyHandler, true);
    terminal.attachCustomKeyEventHandler((event) =>
      handleTerminalKeyEvent(event, terminal, sessionId, sessionRuntimeId, ws, host, latestSelectionText),
    );
    const inputDisposable = terminal.onData((data) => {
      if (data.includes("\u0003")) recordTerminalUserAction(sessionId, "ctrl_c");
      if (ws.readyState === WebSocket.OPEN) sendInput(data);
    });

    ws.addEventListener("open", () => {
      if (disposed) return;
      autoRetryAttemptsRef.current = 0;
      clearAutoRetryTimer();
      recordTerminalClientEvent(sessionId, "websocket.open");
      setConnectionState("attached");
      scheduleResize();
    });
    ws.addEventListener("message", (event) => {
      if (disposed) return;
      if (typeof event.data !== "string") {
        void writeTerminalBinary(event.data, terminal);
        return;
      }
      const message = parseTerminalSocketMessage(event.data);
      if (!message) {
        terminal.write(event.data);
        return;
      }
      if (message.type === "error") {
        setConnectionState("disconnected");
        setError({ code: message.data || "terminal_unavailable", detail: message.data ?? "" });
      } else if (message.type === "exit") {
        setConnectionState("disconnected");
        setError({ code: "terminal_closed", detail: message.data ?? "Terminal bridge closed." });
      }
    });
    ws.addEventListener("close", (event) => {
      if (disposed) return;
      recordTerminalClientEvent(sessionId, "websocket.close", { code: event.code, reason: event.reason });
      const nextError = {
        code: "terminal_disconnected",
        detail: event.reason || `Terminal WebSocket closed with code ${event.code}.`,
      };
      setConnectionState("disconnected");
      setError(nextError);
      scheduleAutoRetry(nextError.code);
    });
    ws.addEventListener("error", () => {
      if (disposed) return;
      recordTerminalClientEvent(sessionId, "websocket.error");
      const nextError = { code: "terminal_socket_error", detail: "Terminal WebSocket failed." };
      setConnectionState("disconnected");
      setError(nextError);
      scheduleAutoRetry(nextError.code);
    });
    window.setTimeout(scheduleResize, 0);
    return () => {
      flushInput();
      disposed = true;
      clearInputFlushTimer();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (wheelFrame !== null) {
        window.cancelAnimationFrame(wheelFrame);
        wheelFrame = null;
      }
      inputDisposable.dispose();
      selectionDisposable.dispose();
      resizeObserver?.disconnect();
      host.removeEventListener("keydown", nativeKeyHandler, true);
      if (!forwardWheelToRuntime) host.removeEventListener("wheel", nativeWheelHandler, { capture: true });
      document.removeEventListener("copy", nativeCopyHandler, true);
      window.removeEventListener("resize", scheduleResize);
      ws.close();
      terminal.dispose();
      if (requestResizeRef.current === scheduleResize) requestResizeRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
      if (wsRef.current === ws) wsRef.current = null;
      unregisterTerminalHost();
    };
  }, [
    sessionId,
    active,
    sessionRuntimeId,
    generation,
    clearAutoRetryTimer,
    scheduleAutoRetry,
    forwardWheelToRuntime,
    coalesceInput,
  ]);

  useEffect(() => {
    if (!active) return;
    requestResizeRef.current?.();
    const terminal = terminalRef.current;
    if (terminal) terminal.refresh(0, Math.max(0, terminal.rows - 1));
  }, [active]);

  // Publish the live URL + reload/focus/recover callbacks so nav selection and
  // tab actions can drive state owned by TerminalPane.
  // The status bar used to render these affordances inside the pane; that was
  // removed in favour of the tab actions, but the state still lives here.
  useEffect(() => {
    publishTerminalHandle(sessionId, {
      reload,
      focusIframe,
      recoverIfDisconnected,
      sendVoiceInput,
      canAcceptVoiceInput,
    });
    return () => publishTerminalHandle(sessionId, null);
  }, [sessionId, reload, focusIframe, recoverIfDisconnected, sendVoiceInput, canAcceptVoiceInput]);
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

function canAcceptTerminalVoiceInput(
  host: HTMLElement | null,
  ws: WebSocket | null,
  active: boolean,
  connectionState: "connecting" | "attached" | "disconnected",
  error: TerminalError | null,
): ws is WebSocket {
  return Boolean(
    active &&
      !error &&
      connectionState === "attached" &&
      host &&
      ws &&
      ws.readyState === WebSocket.OPEN &&
      isElementVoiceVisible(host),
  );
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
      return "The terminal WebSocket disconnected. Retry reconnects to the same terminal session.";
    case "terminal_closed":
      return "The terminal bridge closed. Retry reconnects if the underlying terminal session is still present.";
    case "tmux_session_missing":
      return "The tmux session this terminal would attach to no longer exists. Restart the agent session or reconcile.";
    case "pty_owner_missing":
      return "The PTY daemon is not reachable. Retry starts or adopts the terminal owner when the daemon is available.";
    case "pty_session_missing":
      return "The PTY daemon could not open or adopt this terminal session. Retry or recreate the terminal.";
    case "session_not_found":
      return "This Citadel session is not registered. Refresh or recreate it from the cockpit.";
    case "spawn_failed":
      return "The terminal PTY failed to spawn. Verify the terminal backend is installed and reachable from the daemon environment.";
    default:
      return "Open the terminal runbook below for diagnostic steps.";
  }
}

function terminalReadableCols(cols: number): number {
  return Math.max(20, Math.trunc(cols) - TERMINAL_RIGHT_EDGE_RESERVED_COLUMNS);
}

function handleTerminalKeyEvent(
  event: KeyboardEvent,
  terminal: Terminal,
  sessionId: string,
  runtimeId: string | null,
  ws: WebSocket,
  host: HTMLElement,
  selectionSnapshot = "",
): boolean {
  if (event.type !== "keydown" || event.isComposing) return true;
  const key = event.key.toLowerCase();
  const match = matchShortcut(event);
  if (match) {
    if (match.id === "close-overlay") {
      if (readOverlayCount() > 0) postTerminalShortcutMessage(match.id, sessionId);
      return true;
    }
    postTerminalShortcutMessage(match.id, sessionId, match.index);
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
    sendTerminalControl(ws, { type: "input", data: shiftEnterInputForRuntime(runtimeId) });
    return false;
  }
  if (isLineKillShortcut(key, event)) {
    sendTerminalKey(ws, LINE_KILL_KEY);
    return false;
  }
  if (event.metaKey && !event.ctrlKey && !event.altKey) {
    if (key === "arrowleft" && !event.shiftKey) {
      sendTerminalKey(ws, LINE_START_KEY);
      return false;
    }
    if (key === "arrowright" && !event.shiftKey) {
      sendTerminalKey(ws, LINE_END_KEY);
      return false;
    }
    if (key === "c" && !event.shiftKey) {
      if (copyableTerminalSelectionText(terminal, host, selectionSnapshot)) return true;
      sendTerminalInterrupt(ws, sessionId);
      return false;
    }
    if (key === "v" && !event.shiftKey) {
      void pasteClipboardIntoTerminal(ws);
      return false;
    }
    if (key === "a" && !event.shiftKey) {
      terminal.selectAll();
      return false;
    }
  }
  return true;
}

function shiftEnterInputForRuntime(runtimeId: string | null): string {
  return runtimeId === "codex" ? CODEX_SHIFT_ENTER_INPUT : SHIFT_ENTER_INPUT;
}

function isLineKillShortcut(key: string, event: KeyboardEvent): boolean {
  if (key !== "backspace" || event.shiftKey || event.altKey) return false;
  if (event.metaKey && !event.ctrlKey) return true;
  return event.ctrlKey && !event.metaKey && !isApplePlatform();
}

function shouldForwardWheelToRuntime(session: WorkspaceSession): boolean {
  return (
    session.terminalBackend === "pty-daemon" ||
    (session.terminalBackend === "tmux" &&
      session.kind === "agent" &&
      RUNTIME_MOUSE_EVENT_RUNTIMES.has(session.runtimeId))
  );
}

function wheelDeltaToLines(
  event: WheelEvent,
  terminalRows: number,
  remainder: number,
): { lines: number; remainder: number } | null {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0 || event.shiftKey) return null;
  const rows = Number.isFinite(terminalRows) && terminalRows > 1 ? Math.trunc(terminalRows) : 24;
  const rawLineDelta =
    event.deltaMode === 1
      ? event.deltaY * TERMINAL_WHEEL_LINES_PER_LINE_DELTA
      : event.deltaMode === 2
        ? event.deltaY * Math.max(1, rows - 1)
        : event.deltaY / TERMINAL_WHEEL_PIXELS_PER_LINE;
  const lineDelta = accelerateWheelLineDelta(rawLineDelta, event, rows);
  const total = remainder + lineDelta;
  const lines = total < 0 ? Math.ceil(total) : Math.floor(total);
  return { lines, remainder: total - lines };
}

function accelerateWheelLineDelta(lineDelta: number, event: WheelEvent, terminalRows: number): number {
  const magnitude = Math.abs(lineDelta);
  if (magnitude === 0) return 0;
  const accelerated =
    magnitude >= TERMINAL_WHEEL_ACCELERATION_THRESHOLD_LINES
      ? magnitude * TERMINAL_WHEEL_ACCELERATION_MULTIPLIER
      : magnitude;
  const fastMultiplier = event.altKey ? TERMINAL_FAST_SCROLL_MULTIPLIER : 1;
  const maxLines = Math.max(1, terminalRows - 1) * fastMultiplier;
  return Math.sign(lineDelta) * Math.min(maxLines, accelerated * fastMultiplier);
}

function sendTerminalInput(ws: WebSocket, data: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data));
}

function shouldFlushTerminalInputImmediately(data: string): boolean {
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function shouldCoalesceTerminalInput(ws: WebSocket, data: string, enabled: boolean): boolean {
  return enabled && ws.bufferedAmount > 0 && !shouldFlushTerminalInputImmediately(data);
}

function sendTerminalKey(ws: WebSocket, key: TerminalPaneKey): void {
  sendTerminalControl(ws, { type: "key", key });
}

function sendTerminalControl(ws: WebSocket, message: TerminalSocketMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sendTerminalScroll(ws: WebSocket, lines: number): void {
  let remaining = Math.trunc(lines);
  while (remaining !== 0) {
    const chunk =
      remaining > 0
        ? Math.min(remaining, TERMINAL_MAX_SCROLL_LINES_PER_MESSAGE)
        : Math.max(remaining, -TERMINAL_MAX_SCROLL_LINES_PER_MESSAGE);
    sendTerminalControl(ws, { type: "scroll", lines: chunk });
    remaining -= chunk;
  }
}

function sendTerminalInterrupt(ws: WebSocket, sessionId: string): void {
  recordTerminalUserAction(sessionId, "ctrl_c");
  sendTerminalInput(ws, "\u0003");
}

function copyTerminalSelection(
  event: ClipboardEvent,
  terminal: Terminal,
  host: HTMLElement,
  selectionSnapshot: string,
): void {
  const selection = copyableTerminalSelectionText(terminal, host, selectionSnapshot);
  if (!selection || !event.clipboardData) return;
  event.clipboardData.setData("text/plain", selection);
  event.preventDefault();
  event.stopImmediatePropagation();
}

function terminalSelectionText(terminal: Terminal, selectionSnapshot: string): string {
  const selection = terminal.getSelection();
  if (selection) return selection;
  return terminal.hasSelection() ? selectionSnapshot : "";
}

function copyableTerminalSelectionText(terminal: Terminal, host: HTMLElement, selectionSnapshot: string): string {
  return terminalSelectionText(terminal, selectionSnapshot) || browserSelectionTextWithin(host);
}

function browserSelectionTextWithin(host: HTMLElement): string {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && host.contains(active)) {
    return active.value.slice(active.selectionStart, active.selectionEnd);
  }
  if (active instanceof HTMLInputElement && host.contains(active)) {
    return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
  }
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return "";
  if (!host.contains(selection.anchorNode) || !host.contains(selection.focusNode)) return "";
  return selection.toString();
}

async function pasteClipboardIntoTerminal(ws: WebSocket): Promise<void> {
  const text = await navigator.clipboard?.readText().catch(() => "");
  if (text) sendTerminalInput(ws, text);
}

function isApplePlatform(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /Mac|iPhone|iPad|iPod/.test(nav.userAgentData?.platform || navigator.platform || "");
}

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
