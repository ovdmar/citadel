import { execFile, execFileSync, spawn } from "node:child_process";
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

export function captureTmuxVisibleScreen(sessionName: string, lines = 200) {
  try {
    return execFileSync("tmux", ["capture-pane", "-a", "-p", "-S", `-${lines}`, "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return captureTmux(sessionName, lines);
  }
}

export function sendKeys(sessionName: string, data: string) {
  for (const token of tokenizeTerminalInput(data)) {
    if (token.literal) {
      execFileSync("tmux", ["send-keys", "-l", "-t", sessionName, token.value]);
    } else {
      execFileSync("tmux", ["send-keys", "-t", sessionName, token.value]);
    }
  }
}

export function pasteText(sessionName: string, data: string) {
  const bufferName = `citadel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync("tmux", ["load-buffer", "-b", bufferName, "-"], { input: data });
  execFileSync("tmux", ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName]);
}

export function resizePane(sessionName: string, cols: number, rows: number) {
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(120, Math.max(5, Math.trunc(rows)));
  execFileSync("tmux", ["resize-pane", "-t", sessionName, "-x", String(safeCols), "-y", String(safeRows)]);
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
      const sendSnapshot = () => {
        if (ws.readyState === ws.OPEN)
          ws.send(JSON.stringify({ type: "output", data: captureTmuxVisibleScreen(tmuxSession, 1000) }));
      };
      sendSnapshot();
      const control = attachTmuxControlStream(tmuxSession, (data) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "outputChunk", data }));
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as { type: string; data?: string; cols?: number; rows?: number };
        let shouldCatchUp = false;
        if (message.type === "input" && typeof message.data === "string") {
          sendKeys(tmuxSession, message.data);
          shouldCatchUp = true;
        }
        if (message.type === "paste" && typeof message.data === "string") {
          pasteText(tmuxSession, message.data);
          shouldCatchUp = true;
        }
        if (message.type === "resize" && message.cols && message.rows) {
          resizePane(tmuxSession, message.cols, message.rows);
          shouldCatchUp = true;
        }
        if (shouldCatchUp) setTimeout(sendSnapshot, 50).unref();
      });
      ws.on("close", () => control.close());
    });
  });
}

export function attachTmuxControlStream(sessionName: string, onOutput: (data: string) => void) {
  const child = spawn("tmux", ["-C", "attach-session", "-t", sessionName], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffered = "";
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
  return {
    close: () => {
      child.stdout.destroy();
      child.stdin.destroy();
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed || child.exitCode === null) child.kill("SIGKILL");
      }, 250).unref();
    },
  };
}

export function parseTmuxControlOutput(line: string) {
  const match = /^%output\s+\S+\s+(.*)$/.exec(line);
  if (!match) return null;
  return decodeTmuxControlValue(match[1] ?? "");
}

export function decodeTmuxControlValue(value: string) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function tokenizeTerminalInput(input: string) {
  const tokens: { literal: boolean; value: string }[] = [];
  let literal = "";
  const flush = () => {
    if (literal) {
      tokens.push({ literal: true, value: literal });
      literal = "";
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const rest = input.slice(index);
    const escapeKey = keyForEscapeSequence(rest);
    if (escapeKey) {
      flush();
      tokens.push({ literal: false, value: escapeKey.key });
      index += escapeKey.length - 1;
      continue;
    }

    const key = keyForControlCharacter(input[index] ?? "");
    if (key) {
      flush();
      tokens.push({ literal: false, value: key });
      continue;
    }
    literal += input[index];
  }
  flush();
  return tokens;
}

function keyForControlCharacter(char: string) {
  switch (char) {
    case "\r":
    case "\n":
      return "Enter";
    case "\t":
      return "Tab";
    case "\u0003":
      return "C-c";
    case "\u0004":
      return "C-d";
    case "\u001a":
      return "C-z";
    case "\u001b":
      return "Escape";
    case "\u007f":
      return "BSpace";
    default:
      return null;
  }
}

function keyForEscapeSequence(input: string) {
  const sequences: Record<string, string> = {
    "\u001b[A": "Up",
    "\u001b[B": "Down",
    "\u001b[C": "Right",
    "\u001b[D": "Left",
    "\u001b[H": "Home",
    "\u001b[F": "End",
    "\u001b[3~": "Delete",
    "\u001b[5~": "PageUp",
    "\u001b[6~": "PageDown",
  };
  for (const [sequence, key] of Object.entries(sequences)) {
    if (input.startsWith(sequence)) return { key, length: sequence.length };
  }
  return null;
}
