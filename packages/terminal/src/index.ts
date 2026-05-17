import { execFile, execFileSync } from "node:child_process";
import type http from "node:http";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);

export type TerminalSessionRequest = {
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
};

export async function ensureTmuxSession(input: TerminalSessionRequest) {
  const exists = tmuxSessionExists(input.sessionName);
  if (!exists) {
    const command = [input.command, ...input.args].join(" ");
    await execFileAsync("tmux", ["new-session", "-d", "-s", input.sessionName, "-c", input.cwd, command], {
      timeout: 10000,
      maxBuffer: 128 * 1024,
    });
  }
  const id = execFileSync("tmux", ["display-message", "-p", "-t", input.sessionName, "#{session_id}"], {
    encoding: "utf8",
  }).trim();
  return { tmuxSessionName: input.sessionName, tmuxSessionId: id };
}

export function tmuxSessionExists(sessionName: string) {
  try {
    execFileSync("tmux", ["has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function captureTmux(sessionName: string, lines = 200) {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-S", `-${lines}`, "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    return error instanceof Error ? error.message : "tmux capture failed";
  }
}

export function sendKeys(sessionName: string, data: string) {
  if (data === "\r" || data === "\n") {
    execFileSync("tmux", ["send-keys", "-t", sessionName, "Enter"]);
    return;
  }
  execFileSync("tmux", ["send-keys", "-l", "-t", sessionName, data]);
}

export function resizePane(sessionName: string, cols: number, rows: number) {
  execFileSync("tmux", ["resize-pane", "-t", sessionName, "-x", String(cols), "-y", String(rows)]);
}

export function killTmuxSession(sessionName: string) {
  if (!tmuxSessionExists(sessionName)) return;
  execFileSync("tmux", ["kill-session", "-t", sessionName]);
}

export function attachTerminalWebSocket(server: http.Server, resolveSession: (id: string) => string | null) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://127.0.0.1");
    if (!url.pathname.startsWith("/terminal/")) return;
    const sessionId = decodeURIComponent(url.pathname.replace("/terminal/", ""));
    const tmuxSession = resolveSession(sessionId);
    if (!tmuxSession) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      let last = "";
      const push = () => {
        const current = captureTmux(tmuxSession, 300);
        if (current !== last) {
          ws.send(JSON.stringify({ type: "output", data: current }));
          last = current;
        }
      };
      const timer = setInterval(push, 250);
      push();
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
        if (message.type === "input" && typeof message.data === "string") sendKeys(tmuxSession, message.data);
        if (message.type === "resize" && message.cols && message.rows)
          resizePane(tmuxSession, message.cols, message.rows);
      });
      ws.on("close", () => clearInterval(timer));
    });
  });
}
