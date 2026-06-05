import { execFileSync } from "node:child_process";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { type IPty, spawn } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { type PtyDaemonClient, connectPtyDaemonClient } from "./pty-daemon-client.js";
import type { PtyDaemonSessionInfo } from "./pty-daemon-protocol.js";
import { ensureTmuxExtendedKeys, setTmuxMouseForSession, tmuxPrefix } from "./tmux.js";

export type TmuxTerminalPtyTarget = {
  backend?: "tmux";
  sessionName: string;
  socketName?: string | null;
  enableTmuxMouse?: boolean;
};
export type PtyDaemonTerminalTarget = {
  backend: "pty-daemon";
  sessionId: string;
  socketPath: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  kind?: string;
  onSessionReady?: (session: PtyDaemonSessionInfo) => void | Promise<void>;
};
export type TerminalPtyTarget = TmuxTerminalPtyTarget | PtyDaemonTerminalTarget;
type ResolveTerminalSession = (
  id: string,
) => TerminalPtyTarget | string | null | Promise<TerminalPtyTarget | string | null>;
type TerminalUpgradeRejection = { status: number; body: unknown };
type TerminalWebSocketOptions = {
  authorize?: (request: http.IncomingMessage) => TerminalUpgradeRejection | null;
  maxBufferedBytes?: number;
  /** Internal test hook for deterministic backpressure coverage. */
  getBufferedAmount?: (ws: WebSocket) => number;
};

type TerminalSocketMessage = {
  type?: string;
  cols?: number;
  rows?: number;
  data?: string;
  key?: string;
  lines?: number;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 400;
const MAX_ROWS = 120;
const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const BACKPRESSURE_CLOSE_CODE = 1013;
const BACKPRESSURE_CLOSE_REASON = "terminal_backpressure";
const ALLOWED_TERMINAL_KEYS = new Set(["C-a", "C-e", "C-u"]);
const MAX_SCROLL_LINES = 200;

export function attachTerminalWebSocket(
  server: http.Server,
  resolveSession: ResolveTerminalSession,
  options: TerminalWebSocketOptions = {},
) {
  const wss = new WebSocketServer({ noServer: true });
  const ptys = new Set<IPty>();
  const clients = new Map<WebSocket, IPty>();
  const ptyDaemonClients = new Map<WebSocket, PtyDaemonClient>();
  const maxBufferedBytes = normalizeMaxBufferedBytes(options.maxBufferedBytes);
  const getBufferedAmount = options.getBufferedAmount ?? ((ws: WebSocket) => ws.bufferedAmount);
  let shuttingDown = false;
  const shutdownTerminalSockets = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const [ws, pty] of clients) {
      closePty(pty);
      if (
        ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CLOSING
      ) {
        ws.terminate();
      }
    }
    for (const [ws, client] of ptyDaemonClients) {
      client.dispose();
      if (
        ws.readyState === WebSocket.CONNECTING ||
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CLOSING
      ) {
        ws.terminate();
      }
    }
    for (const pty of ptys) closePty(pty);
    for (const ws of wss.clients) ws.terminate();
    ptys.clear();
    clients.clear();
    ptyDaemonClients.clear();
    wss.close();
  };
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (err?: Error) => void) => {
    shutdownTerminalSockets();
    return originalClose(callback);
  }) as typeof server.close;
  server.on("close", shutdownTerminalSockets);
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://127.0.0.1");
    if (!url.pathname.startsWith("/terminal/")) return;
    const rejection = options.authorize?.(request);
    if (rejection) {
      writeHttpError(socket, rejection.status, rejection.body);
      return;
    }
    const sessionId = decodeURIComponent(url.pathname.replace("/terminal/", ""));
    void Promise.resolve(resolveSession(sessionId))
      .then((resolved) => {
        const tmuxTarget = normalizeTarget(resolved);
        if (!tmuxTarget) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          if (tmuxTarget.backend === "pty-daemon") {
            void attachPtyDaemonWebSocketClient(ws, tmuxTarget, {
              maxBufferedBytes,
              getBufferedAmount,
              onClient: (client) => ptyDaemonClients.set(ws, client),
              onCleanup: () => ptyDaemonClients.delete(ws),
            });
            return;
          }
          let pty: IPty;
          try {
            pty = attachTmuxPty(tmuxTarget.sessionName, DEFAULT_COLS, DEFAULT_ROWS, tmuxTarget.socketName, {
              enableTmuxMouse: tmuxTarget.enableTmuxMouse === true,
            });
          } catch (error) {
            sendControl(ws, {
              type: "error",
              data: error instanceof Error ? error.message : "spawn_failed",
            });
            ws.close(1011, "spawn_failed");
            return;
          }
          ptys.add(pty);
          clients.set(ws, pty);
          let cleanedUp = false;
          let dataDisposable: { dispose: () => void } | null = null;
          let exitDisposable: { dispose: () => void } | null = null;
          const cleanup = (killPty: boolean) => {
            if (cleanedUp) return;
            cleanedUp = true;
            ptys.delete(pty);
            clients.delete(ws);
            dataDisposable?.dispose();
            exitDisposable?.dispose();
            if (killPty) closePty(pty);
          };
          const closeForBackpressure = () => {
            cleanup(true);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(BACKPRESSURE_CLOSE_CODE, BACKPRESSURE_CLOSE_REASON);
              const terminateTimer = setTimeout(() => {
                if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
              }, 1000);
              terminateTimer.unref();
            } else if (ws.readyState !== WebSocket.CLOSED) {
              ws.terminate();
            }
          };
          dataDisposable = pty.onData((data) => {
            if (ws.readyState !== WebSocket.OPEN || cleanedUp) return;
            if (getBufferedAmount(ws) > maxBufferedBytes) {
              closeForBackpressure();
              return;
            }
            ws.send(Buffer.from(data, "utf8"), { binary: true }, (error) => {
              if (error) cleanup(true);
            });
            if (getBufferedAmount(ws) > maxBufferedBytes) closeForBackpressure();
          });
          exitDisposable = pty.onExit(({ exitCode, signal }) => {
            cleanup(false);
            if (ws.readyState === WebSocket.OPEN) {
              sendControl(ws, { type: "exit", data: signal ? `signal:${signal}` : `exit:${exitCode}` });
              ws.close(1000, "pty_exit");
            }
          });
          ws.on("message", (raw, isBinary) => {
            if (isBinary) {
              pty.write(raw.toString("utf8"));
              return;
            }
            const message = parseTerminalSocketMessage(raw.toString());
            if (!message) {
              sendControl(ws, { type: "error", data: "invalid_message" });
              return;
            }
            if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
              const { cols, rows } = clampSize(message.cols, message.rows);
              pty.resize(cols, rows);
            } else if (message.type === "input" && typeof message.data === "string") {
              try {
                sendTmuxLiteralInput(tmuxTarget.sessionName, message.data, tmuxTarget.socketName);
              } catch (error) {
                sendControl(ws, {
                  type: "error",
                  data: error instanceof Error ? error.message : "input_failed",
                });
              }
            } else if (message.type === "key" && typeof message.key === "string") {
              if (!ALLOWED_TERMINAL_KEYS.has(message.key)) {
                sendControl(ws, { type: "error", data: "invalid_key" });
                return;
              }
              try {
                sendTmuxKey(tmuxTarget.sessionName, message.key, tmuxTarget.socketName);
              } catch (error) {
                sendControl(ws, {
                  type: "error",
                  data: error instanceof Error ? error.message : "key_failed",
                });
              }
            } else if (message.type === "scroll" && typeof message.lines === "number") {
              const lines = normalizeScrollLines(message.lines);
              if (lines !== null) scrollTmuxPane(tmuxTarget.sessionName, lines, tmuxTarget.socketName);
            }
          });
          ws.on("close", () => {
            cleanup(true);
          });
          ws.on("error", () => {
            cleanup(true);
          });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  });
}

function normalizeMaxBufferedBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BUFFERED_BYTES;
  return Math.max(1024, Math.trunc(value));
}

export function attachTmuxPty(
  sessionName: string,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  socketName?: string | null,
  options: { enableTmuxMouse?: boolean } = {},
): IPty {
  ensureTmuxExtendedKeys(socketName);
  if (options.enableTmuxMouse) setTmuxMouseForSession(sessionName, true, socketName);
  const size = clampSize(cols, rows);
  return spawn("tmux", [...tmuxPrefix(socketName), "attach-session", "-t", sessionName], {
    name: "xterm-256color",
    cols: size.cols,
    rows: size.rows,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: "1",
      CLICOLOR_FORCE: "1",
    },
  });
}

function normalizeTarget(target: TerminalPtyTarget | string | null): TerminalPtyTarget | null {
  if (!target) return null;
  return typeof target === "string" ? { sessionName: target } : target;
}

async function attachPtyDaemonWebSocketClient(
  ws: WebSocket,
  target: PtyDaemonTerminalTarget,
  options: {
    maxBufferedBytes: number;
    getBufferedAmount: (ws: WebSocket) => number;
    onClient: (client: PtyDaemonClient) => void;
    onCleanup: () => void;
  },
): Promise<void> {
  let client: PtyDaemonClient | null = null;
  let registeredClient = false;
  let cleanedUp = false;
  let unsubscribe: (() => void) | null = null;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    unsubscribe?.();
    if (registeredClient) options.onCleanup();
    client?.dispose();
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
  try {
    client = await connectPtyDaemonClient({ socketPath: target.socketPath });
  } catch (error) {
    if (!cleanedUp) {
      sendControl(ws, { type: "error", data: error instanceof Error ? error.message : "pty_owner_missing" });
      ws.close(1011, "pty_owner_missing");
    }
    return;
  }
  if (cleanedUp || ws.readyState === WebSocket.CLOSED) {
    client.dispose();
    return;
  }
  options.onClient(client);
  registeredClient = true;
  const closeForBackpressure = () => {
    cleanup();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(BACKPRESSURE_CLOSE_CODE, BACKPRESSURE_CLOSE_REASON);
      const terminateTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }, 1000);
      terminateTimer.unref();
    } else if (ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  };
  try {
    const session = await ensurePtyDaemonSession(client, target);
    if (cleanedUp) return;
    await Promise.resolve(target.onSessionReady?.(session));
    if (cleanedUp) return;
    unsubscribe = await client.subscribe(target.sessionId, {
      replay: true,
      onOutput: (chunk) => {
        if (ws.readyState !== WebSocket.OPEN || cleanedUp) return;
        if (options.getBufferedAmount(ws) > options.maxBufferedBytes) {
          closeForBackpressure();
          return;
        }
        ws.send(chunk, { binary: true }, (error) => {
          if (error) cleanup();
        });
        if (options.getBufferedAmount(ws) > options.maxBufferedBytes) closeForBackpressure();
      },
      onExit: ({ exitCode, signal }) => {
        cleanup();
        if (ws.readyState === WebSocket.OPEN) {
          sendControl(ws, { type: "exit", data: signal ? `signal:${signal}` : `exit:${exitCode}` });
          ws.close(1000, "pty_exit");
        }
      },
    });
    if (cleanedUp) unsubscribe();
  } catch (error) {
    cleanup();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      sendControl(ws, { type: "error", data: error instanceof Error ? error.message : "pty_session_missing" });
      ws.close(1011, "pty_session_missing");
    }
    return;
  }
  ws.on("message", (raw, isBinary) => {
    if (cleanedUp || !client) return;
    if (isBinary) {
      client.input(target.sessionId, rawWebSocketDataToBuffer(raw));
      return;
    }
    const message = parseTerminalSocketMessage(raw.toString());
    if (!message) {
      sendControl(ws, { type: "error", data: "invalid_message" });
      return;
    }
    if (message.type === "resize" && typeof message.cols === "number" && typeof message.rows === "number") {
      const { cols, rows } = clampSize(message.cols, message.rows);
      client.resize(target.sessionId, cols, rows);
    } else if (message.type === "input" && typeof message.data === "string") {
      client.input(target.sessionId, Buffer.from(message.data, "utf8"));
    } else if (message.type === "key" && typeof message.key === "string") {
      const control = controlBytesForKey(message.key);
      if (!control) {
        sendControl(ws, { type: "error", data: "invalid_key" });
        return;
      }
      client.input(target.sessionId, control);
    }
  });
}

async function ensurePtyDaemonSession(
  client: PtyDaemonClient,
  target: PtyDaemonTerminalTarget,
): Promise<PtyDaemonSessionInfo> {
  const existing = (await client.list()).find((session) => session.sessionId === target.sessionId);
  if (existing) return existing;
  return client.open({
    sessionId: target.sessionId,
    cwd: target.cwd,
    command: target.command,
    args: target.args ?? [],
    env: target.env ?? {},
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    kind: target.kind ?? "terminal",
  });
}

function controlBytesForKey(key: string): Buffer | null {
  if (key === "C-a") return Buffer.from("\u0001", "utf8");
  if (key === "C-e") return Buffer.from("\u0005", "utf8");
  if (key === "C-u") return Buffer.from("\u0015", "utf8");
  return null;
}

function rawWebSocketDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

function writeHttpError(socket: Duplex, status: number, body: unknown) {
  const payload = `${JSON.stringify(body)}\n`;
  socket.write(
    [
      `HTTP/1.1 ${status} WebSocket Upgrade Rejected`,
      "Content-Type: application/json; charset=utf-8",
      "Connection: close",
      `Content-Length: ${Buffer.byteLength(payload, "utf8")}`,
      "",
      payload,
    ].join("\r\n"),
  );
  socket.destroy();
}

export function parseTerminalSocketMessage(raw: string): TerminalSocketMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const message = parsed as TerminalSocketMessage;
    if (typeof message.type !== "string") return null;
    return message;
  } catch {
    return null;
  }
}

export function clampSize(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Math.min(MAX_COLS, Math.max(20, Math.trunc(cols))),
    rows: Math.min(MAX_ROWS, Math.max(5, Math.trunc(rows))),
  };
}

function sendControl(ws: WebSocket, message: { type: string; data: string }): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function closePty(pty: IPty): void {
  try {
    pty.kill("SIGHUP");
  } catch {
    /* already closed */
  }
}

function sendTmuxLiteralInput(sessionName: string, data: string, socketName?: string | null): void {
  if (data.length === 0) return;
  execFileSync("tmux", [...tmuxPrefix(socketName), "send-keys", "-l", "-t", sessionName, data], {
    stdio: "ignore",
  });
}

function sendTmuxKey(sessionName: string, key: string, socketName?: string | null): void {
  execFileSync("tmux", [...tmuxPrefix(socketName), "send-keys", "-t", sessionName, key], {
    stdio: "ignore",
  });
}

function normalizeScrollLines(lines: number): number | null {
  if (!Number.isFinite(lines)) return null;
  const truncated = Math.trunc(lines);
  if (truncated === 0) return null;
  return Math.max(-MAX_SCROLL_LINES, Math.min(MAX_SCROLL_LINES, truncated));
}

function scrollTmuxPane(sessionName: string, lines: number, socketName?: string | null): void {
  const count = String(Math.abs(lines));
  const action = lines < 0 ? "scroll-up" : "scroll-down";
  try {
    if (lines < 0) {
      execFileSync(
        "tmux",
        [
          ...tmuxPrefix(socketName),
          "copy-mode",
          "-e",
          "-t",
          sessionName,
          ";",
          "send-keys",
          "-t",
          sessionName,
          "-X",
          "-N",
          count,
          action,
        ],
        { stdio: "ignore" },
      );
      return;
    }
    execFileSync("tmux", [...tmuxPrefix(socketName), "send-keys", "-t", sessionName, "-X", "-N", count, action], {
      stdio: "ignore",
    });
  } catch {
    // Scroll is best-effort UI state. Never turn a wheel event into a terminal error overlay.
  }
}
