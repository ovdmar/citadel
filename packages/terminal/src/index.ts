import { execFile, execFileSync, spawn } from "node:child_process";
import type http from "node:http";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

export { createTtydManager, TtydUnavailableError } from "./ttyd.js";
export type { TtydEntry, TtydManager, TtydManagerConfig } from "./ttyd.js";

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
    const command = terminalCommand(input.command, input.args);
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

function terminalCommand(command: string, args: string[]) {
  const argv = [command, ...args].map(shellQuote).join(" ");
  return [
    "env",
    "-u",
    "NO_COLOR",
    "TERM=xterm-256color",
    "COLORTERM=truecolor",
    "FORCE_COLOR=1",
    "CLICOLOR_FORCE=1",
    argv,
  ].join(" ");
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
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

export type TerminalTranscript = {
  ok: true;
  sessionName: string;
  lines: number;
  charCount: number;
  text: string;
};

export type TerminalTranscriptError = {
  ok: false;
  error: string;
};

// Bounded transcript capture for non-interactive callers (MCP, scripts).
// `lines` is the maximum scrollback depth pulled from tmux; the returned text is
// additionally truncated to `maxChars` to avoid streaming a megabyte of output
// when an agent has scrolled for a long time.
export function captureTranscript(
  sessionName: string,
  options: { lines?: number; maxChars?: number } = {},
): TerminalTranscript | TerminalTranscriptError {
  const requestedLines = Math.min(2000, Math.max(1, options.lines ?? 200));
  const maxChars = Math.min(200_000, Math.max(256, options.maxChars ?? 16_000));
  if (!tmuxSessionExists(sessionName)) {
    return { ok: false, error: "tmux_session_missing" };
  }
  let raw: string;
  try {
    raw = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", `-${requestedLines}`, "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "tmux_capture_failed" };
  }
  const trimmed = raw.replace(/\s+$/, "");
  const text = trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
  return {
    ok: true,
    sessionName,
    lines: text.length === 0 ? 0 : text.split("\n").length,
    charCount: text.length,
    text,
  };
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

export function captureTmuxSnapshot(sessionName: string) {
  let text = "";
  try {
    text = execFileSync("tmux", ["capture-pane", "-p", "-e", "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    text = text.replace(/\n+$/, "");
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "tmux capture failed" };
  }
  let cursorRow = 0;
  let cursorCol = 0;
  try {
    const raw = execFileSync("tmux", ["display-message", "-p", "-t", sessionName, "#{cursor_y},#{cursor_x}"], {
      encoding: "utf8",
    }).trim();
    const [yStr, xStr] = raw.split(",");
    const y = Number.parseInt(yStr ?? "", 10);
    const x = Number.parseInt(xStr ?? "", 10);
    if (Number.isFinite(y)) cursorRow = y as number;
    if (Number.isFinite(x)) cursorCol = x as number;
  } catch {
    // best-effort: leave cursor at 0,0 if tmux didn't answer
  }
  // Clear viewport + scrollback, paint the captured pane, then restore the cursor cell so the
  // user sees the same layout tmux's pane currently has.
  const clear = "\x1b[H\x1b[2J\x1b[3J";
  const placeCursor = `\x1b[${cursorRow + 1};${cursorCol + 1}H`;
  return { ok: true as const, data: `${clear}${text}\n${placeCursor}` };
}

// Wait for the tmux pane to "settle" before injecting input. Interactive TUIs
// like Claude Code repaint repeatedly during startup; if we send keys while the
// splash screen is still drawing the input either gets eaten or interleaved
// with the prompt placeholder. We sample the visible screen until it stops
// changing or the deadline expires. Best-effort — never throws.
export async function waitForTerminalIdle(
  sessionName: string,
  options: { timeoutMs?: number; idleMs?: number; pollMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const idleMs = options.idleMs ?? 250;
  const pollMs = options.pollMs ?? 80;
  const deadline = Date.now() + Math.max(idleMs + pollMs, timeoutMs);
  let last = safeCapture(sessionName);
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const current = safeCapture(sessionName);
    if (current === last) {
      if (Date.now() - stableSince >= idleMs) return;
      continue;
    }
    last = current;
    stableSince = Date.now();
  }
}

function safeCapture(sessionName: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

// Submit a prompt or follow-up message into a tmux-backed runtime. Robust
// against interactive TUIs (Claude Code, Codex, Cursor) because it:
//   1. waits for the pane to stop repainting (post-splash),
//   2. delivers the text via a tmux paste-buffer instead of typing chars one
//      at a time (avoids dropped keystrokes and is recognized as a bracketed
//      paste by readline-style prompts),
//   3. waits briefly for the paste to land, then sends Enter to submit.
// Returns whether the underlying tmux calls succeeded. Errors are non-fatal
// at the caller level so the session is still tracked.
export async function submitPrompt(
  sessionName: string,
  prompt: string,
  options: { waitForReadyMs?: number; submitDelayMs?: number; submitKey?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!tmuxSessionExists(sessionName)) return { ok: false, error: "tmux_session_missing" };
  try {
    await waitForTerminalIdle(sessionName, { timeoutMs: options.waitForReadyMs ?? 1500 });
    if (prompt.length > 0) pasteText(sessionName, prompt);
    await new Promise((resolve) => setTimeout(resolve, options.submitDelayMs ?? 120));
    execFileSync("tmux", ["send-keys", "-t", sessionName, options.submitKey ?? "Enter"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "submit_prompt_failed" };
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
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "exit", data: reason }));
          }
        },
      );
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

export function attachTmuxControlStream(
  sessionName: string,
  onOutput: (data: string) => void,
  onExit?: (reason: string) => void,
) {
  const child = spawn("tmux", ["-C", "attach-session", "-t", sessionName], {
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
