import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote, tmuxPrefix, tmuxSessionExists } from "./index.js";

export function captureTmux(sessionName: string, lines = 200, socketName?: string | null) {
  try {
    return execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "capture-pane", "-p", "-S", `-${lines}`, "-t", sessionName],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
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
  options: { lines?: number; maxChars?: number; socketName?: string | null } = {},
): TerminalTranscript | TerminalTranscriptError {
  const requestedLines = Math.min(2000, Math.max(1, options.lines ?? 200));
  const maxChars = Math.min(200_000, Math.max(256, options.maxChars ?? 16_000));
  if (!tmuxSessionExists(sessionName, options.socketName)) {
    return { ok: false, error: "tmux_session_missing" };
  }
  let raw: string;
  try {
    raw = execFileSync(
      "tmux",
      [...tmuxPrefix(options.socketName), "capture-pane", "-p", "-J", "-S", `-${requestedLines}`, "-t", sessionName],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
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

export function captureTmuxVisibleScreen(sessionName: string, lines = 200, socketName?: string | null) {
  try {
    return execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "capture-pane", "-a", "-p", "-S", `-${lines}`, "-t", sessionName],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return captureTmux(sessionName, lines, socketName);
  }
}

export function captureTmuxSnapshot(sessionName: string, socketName?: string | null) {
  let text = "";
  try {
    text = execFileSync("tmux", [...tmuxPrefix(socketName), "capture-pane", "-p", "-e", "-t", sessionName], {
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
    const raw = execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "display-message", "-p", "-t", sessionName, "#{cursor_y},#{cursor_x}"],
      {
        encoding: "utf8",
      },
    ).trim();
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

// Poll the pane's foreground process name (`#{pane_current_command}`) until
// the predicate matches or the deadline expires. tmux exposes the real
// foreground PID's comm string, so this is the cheapest reliable answer to
// "is the runtime actually running yet?" — much more meaningful than the
// pane-paint heuristic. Used before any input injection to avoid sending keys
// while the outer wrapper `bash -c` is still doing setup work.
//
// Returns the last command name observed (so callers can log it on timeout).
export async function waitForPaneCommand(
  sessionName: string,
  predicate: (cmd: string) => boolean,
  options: { timeoutMs?: number; pollMs?: number; socketName?: string | null } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const pollMs = options.pollMs ?? 80;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = execFileSync(
        "tmux",
        [...tmuxPrefix(options.socketName), "display-message", "-p", "-t", sessionName, "#{pane_current_command}"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        },
      ).trim();
    } catch {
      last = "";
    }
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return last;
}

// Sentinel file written by tmux's alert-silence-pane hook. Living under
// tmpdir keeps it cheap to fs.stat in tight loops; the hook itself only
// fires once per silence threshold crossing so we never spawn run-shell on
// the hot path.
const SILENCE_SENTINEL_DIR = path.join(os.tmpdir(), "citadel-silence");

function silenceSentinelPath(sessionName: string) {
  return path.join(SILENCE_SENTINEL_DIR, `${sessionName}.flag`);
}

// Arm tmux's monitor-silence hook so it touches a sentinel file whenever the
// pane has been silent for `seconds`. Caller is responsible for clearing the
// sentinel before arming and for calling `disarmSilenceHook` once done.
function armSilenceHook(sessionName: string, seconds: number, socketName?: string | null) {
  try {
    fs.mkdirSync(SILENCE_SENTINEL_DIR, { recursive: true });
  } catch {
    /* read-only tmpdir — the polling fallback will still kick in */
  }
  const sentinel = silenceSentinelPath(sessionName);
  try {
    fs.unlinkSync(sentinel);
  } catch {
    /* ignore */
  }
  try {
    execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "set-option", "-p", "-t", sessionName, "monitor-silence", String(seconds)],
      {
        stdio: "ignore",
      },
    );
    // -b: run the touch in the background so tmux doesn't block its event loop on it.
    execFileSync(
      "tmux",
      [
        ...tmuxPrefix(socketName),
        "set-hook",
        "-p",
        "-t",
        sessionName,
        "alert-silence-pane",
        `run-shell -b ${shellQuote(`touch ${shellQuote(sentinel)}`)}`,
      ],
      { stdio: "ignore" },
    );
  } catch {
    /* hook set failed — caller's polling fallback handles it */
  }
}

function disarmSilenceHook(sessionName: string, socketName?: string | null) {
  try {
    execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-p", "-u", "-t", sessionName, "monitor-silence"], {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
  try {
    execFileSync("tmux", [...tmuxPrefix(socketName), "set-hook", "-p", "-u", "-t", sessionName, "alert-silence-pane"], {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}

// Wait for the tmux pane to "settle" before injecting input. Interactive TUIs
// like Claude Code repaint repeatedly during startup; if we send keys while the
// splash screen is still drawing the input either gets eaten or interleaved
// with the prompt placeholder.
//
// Two parallel signals race; whichever fires first wins:
//   1. tmux's own monitor-silence hook touches a sentinel file after N seconds
//      of silence (event-driven, no busy polling tmux for screen diffs).
//   2. capture-pane diffing — fallback for the sub-second case where the
//      silence-hook threshold (whole seconds) is coarser than idleMs.
//
// Best-effort — never throws.
export async function waitForTerminalIdle(
  sessionName: string,
  options: {
    timeoutMs?: number;
    idleMs?: number;
    pollMs?: number;
    useSilenceHook?: boolean;
    socketName?: string | null;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const idleMs = options.idleMs ?? 250;
  const pollMs = options.pollMs ?? 80;
  const useSilenceHook = options.useSilenceHook ?? idleMs >= 1000;
  const deadline = Date.now() + Math.max(idleMs + pollMs, timeoutMs);

  const silenceSeconds = useSilenceHook ? Math.max(1, Math.round(idleMs / 1000)) : 0;
  if (silenceSeconds > 0) armSilenceHook(sessionName, silenceSeconds, options.socketName);
  const sentinel = silenceSentinelPath(sessionName);
  try {
    let last = safeCapture(sessionName, options.socketName);
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (silenceSeconds > 0 && safeStatExists(sentinel)) return;
      const current = safeCapture(sessionName, options.socketName);
      if (current === last) {
        if (Date.now() - stableSince >= idleMs) return;
        continue;
      }
      last = current;
      stableSince = Date.now();
    }
  } finally {
    if (silenceSeconds > 0) disarmSilenceHook(sessionName, options.socketName);
  }
}

function safeStatExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeCapture(sessionName: string, socketName?: string | null): string {
  try {
    return execFileSync("tmux", [...tmuxPrefix(socketName), "capture-pane", "-p", "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}
