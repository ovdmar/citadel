import { execFileSync } from "node:child_process";
import type http from "node:http";
import { type IPty, spawn } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { ensureTmuxExtendedKeys, tmuxPrefix } from "./tmux.js";

export type TerminalPtyTarget = { sessionName: string; socketName?: string | null };
type ResolveTerminalSession = (
  id: string,
) => TerminalPtyTarget | string | null | Promise<TerminalPtyTarget | string | null>;

type TerminalSocketMessage = {
  type?: string;
  cols?: number;
  rows?: number;
  data?: string;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_COLS = 400;
const MAX_ROWS = 120;

export function attachTerminalWebSocket(server: http.Server, resolveSession: ResolveTerminalSession) {
  const wss = new WebSocketServer({ noServer: true });
  const ptys = new Set<IPty>();
  const clients = new Map<WebSocket, IPty>();
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
    for (const pty of ptys) closePty(pty);
    for (const ws of wss.clients) ws.terminate();
    ptys.clear();
    clients.clear();
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
          let pty: IPty;
          try {
            pty = attachTmuxPty(tmuxTarget.sessionName, DEFAULT_COLS, DEFAULT_ROWS, tmuxTarget.socketName);
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
          pty.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.from(data, "utf8"), { binary: true });
          });
          pty.onExit(({ exitCode, signal }) => {
            ptys.delete(pty);
            clients.delete(ws);
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
            }
          });
          ws.on("close", () => {
            ptys.delete(pty);
            clients.delete(ws);
            closePty(pty);
          });
          ws.on("error", () => {
            ptys.delete(pty);
            clients.delete(ws);
            closePty(pty);
          });
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  });
}

export function attachTmuxPty(
  sessionName: string,
  cols = DEFAULT_COLS,
  rows = DEFAULT_ROWS,
  socketName?: string | null,
): IPty {
  ensureTmuxExtendedKeys(socketName);
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
