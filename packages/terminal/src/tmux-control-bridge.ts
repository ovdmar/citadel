import { execFileSync, spawn } from "node:child_process";
import type http from "node:http";
import { WebSocketServer } from "ws";
import { captureTmuxSnapshot } from "./capture.js";
import { tokenizeTerminalInput } from "./input-tokens.js";
import { tmuxPrefix } from "./tmux.js";

type ResolveTerminalSession = (id: string) => string | null | Promise<string | null>;

const MAX_LITERAL_CHARS = 4096;

export function attachTerminalWebSocket(server: http.Server, resolveSession: ResolveTerminalSession) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://127.0.0.1");
    if (!url.pathname.startsWith("/terminal/")) return;
    const sessionId = decodeURIComponent(url.pathname.replace("/terminal/", ""));
    void Promise.resolve(resolveSession(sessionId))
      .then((tmuxSession) => {
        if (!tmuxSession) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          const sendSnapshot = () => {
            if (ws.readyState !== ws.OPEN) return;
            const snapshot = captureTmuxSnapshot(tmuxSession);
            if (snapshot.ok) {
              ws.send(JSON.stringify({ type: "output", data: snapshot.data }));
            } else {
              ws.send(JSON.stringify({ type: "error", data: snapshot.error }));
            }
          };
          sendSnapshot();
          const control = attachTmuxControlStream(
            tmuxSession,
            (data) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "outputChunk", data }));
            },
            (reason) => {
              if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "exit", data: reason }));
            },
          );
          ws.on("message", (raw) => {
            const message = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
            let shouldCatchUp = false;
            if (message.type === "input" && typeof message.data === "string") {
              control.writeInput(message.data);
              shouldCatchUp = true;
            }
            if (message.type === "paste" && typeof message.data === "string") {
              pasteText(tmuxSession, message.data);
              shouldCatchUp = true;
            }
            if (message.type === "resize" && message.cols && message.rows) {
              control.resize(message.cols, message.rows);
              shouldCatchUp = true;
            }
            if (shouldCatchUp) setTimeout(sendSnapshot, 50).unref();
          });
          ws.on("close", () => control.close());
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
      });
  });
}

export function attachTmuxControlStream(
  sessionName: string,
  onOutput: (data: string) => void,
  onExit?: (reason: string) => void,
) {
  const child = spawn("tmux", [...tmuxPrefix(), "-C", "attach-session", "-t", sessionName], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffered = "";
  let exited = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const data = parseTmuxControlOutput(line);
      if (data) onOutput(data);
    }
  });
  child.on("exit", (code, signal) => {
    if (exited) return;
    exited = true;
    onExit?.(signal ? `signal:${signal}` : `exit:${code ?? "?"}`);
  });
  return {
    writeInput: (data: string) => {
      for (const command of tmuxControlInputCommands(sessionName, data)) writeControlCommand(child, command);
    },
    resize: (cols: number, rows: number) =>
      writeControlCommand(child, tmuxControlResizeCommand(sessionName, cols, rows)),
    close: () => {
      exited = true;
      child.stdout.destroy();
      child.stdin.destroy();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) child.kill("SIGKILL");
      }, 250).unref();
    },
  };
}

export function tmuxControlInputCommands(sessionName: string, data: string): string[] {
  const target = tmuxControlQuote(sessionName);
  const commands: string[] = [];
  for (const token of tokenizeTerminalInput(data)) {
    if (token.literal) {
      for (const chunk of chunkLiteral(token.value)) {
        commands.push(`send-keys -l -t ${target} ${tmuxControlQuote(chunk)}`);
      }
    } else {
      commands.push(`send-keys -t ${target} ${tmuxControlQuote(token.value)}`);
    }
  }
  return commands;
}

export function tmuxControlResizeCommand(sessionName: string, cols: number, rows: number): string {
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(120, Math.max(5, Math.trunc(rows)));
  return `resize-pane -t ${tmuxControlQuote(sessionName)} -x ${safeCols} -y ${safeRows}`;
}

export function tmuxControlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

export function parseTmuxControlOutput(line: string) {
  const match = /^%output\s+\S+\s+(.*)$/.exec(line);
  if (!match) return null;
  return decodeTmuxControlValue(match[1] ?? "");
}

export function decodeTmuxControlValue(value: string) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function writeControlCommand(child: ReturnType<typeof spawn>, command: string): void {
  const stdin = child.stdin;
  if (!stdin?.writable || child.exitCode !== null) return;
  stdin.write(`${command}\n`);
}

function chunkLiteral(value: string): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += MAX_LITERAL_CHARS) {
    chunks.push(value.slice(index, index + MAX_LITERAL_CHARS));
  }
  return chunks;
}

function pasteText(sessionName: string, data: string) {
  const bufferName = `citadel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync("tmux", [...tmuxPrefix(), "load-buffer", "-b", bufferName, "-"], { input: data });
  execFileSync("tmux", [...tmuxPrefix(), "paste-buffer", "-d", "-b", bufferName, "-t", sessionName]);
}
