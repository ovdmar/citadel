import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

export { createTtydManager, TtydUnavailableError } from "./ttyd.js";
export type { TtydEntry, TtydManager, TtydManagerConfig, TtydTheme } from "./ttyd.js";
export { submitPrompt } from "./submit-prompt.js";

import { tokenizeTerminalInput } from "./input-tokens.js";
export { keyForControlCharacter, keyForEscapeSequence, tokenizeTerminalInput } from "./input-tokens.js";
export type { InputToken } from "./input-tokens.js";

const execFileAsync = promisify(execFile);

// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket. The server lives
// in citadel-tmux.service's cgroup, not citadel.service's — so daemon
// restarts/upgrades leave the agent sessions untouched. Empty in tests and
// on hosts where the socket isn't configured, preserving legacy behavior.
export function tmuxPrefix(): string[] {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}

export type TerminalSessionRequest = {
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
};

export async function ensureTmuxSession(input: TerminalSessionRequest) {
  const exists = tmuxSessionExists(input.sessionName);
  const freshlyCreated = !exists;
  if (!exists) {
    // Pre-create the live sentinel so reconciliation between tmux launch and
    // the wrapper's own `touch` cannot race into a spurious "stopped".
    try {
      fs.writeFileSync(agentLiveSentinelPath(input.sessionName), "");
    } catch {
      // best-effort: status detection degrades gracefully if tmpdir is read-only
    }
    const command = terminalCommand(input.sessionName, input.command, input.args);
    await execFileAsync(
      "tmux",
      [...tmuxPrefix(), "new-session", "-d", "-s", input.sessionName, "-c", input.cwd, command],
      {
        timeout: 10000,
        maxBuffer: 128 * 1024,
      },
    );
    // Capture every byte tmux ever writes to this pane to a side log. Used by
    // submitPrompt for delivery verification (capture-pane only shows the
    // visible scrollback; the log keeps even bytes that scrolled off) and by
    // humans for debugging. Best-effort — if the tmpdir isn't writable we
    // just lose the diagnostic, the rest of the flow is unaffected.
    try {
      attachPipePaneLog(input.sessionName);
    } catch {
      /* noop */
    }
  }
  ensureTmuxExtendedKeys();
  const id = execFileSync(
    "tmux",
    [...tmuxPrefix(), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  // After freshly spawning the wrapper there is a brief window where the outer
  // `bash -c` is still running the script and the inner interactive shell
  // hasn't yet taken over the PTY foreground. Keystrokes (and crucially,
  // Ctrl+C) delivered during that window can reach the wrong process. Wait
  // for the pane to settle so callers can rely on "ensureTmuxSession returned
  // → keys are safe to send."
  if (freshlyCreated) await waitForTerminalIdle(input.sessionName, { timeoutMs: 1500, idleMs: 200 });
  return { tmuxSessionName: input.sessionName, tmuxSessionId: id };
}

// Side-channel byte log of everything a pane emits. Lives under tmpdir so it
// gets cleaned up on reboot. `pipe-pane -o` toggles: passing the command once
// opens the pipe, calling again with no command closes it. We don't bother
// closing on session teardown — when the tmux session goes away tmux severs
// the pipe automatically.
const PIPE_PANE_LOG_DIR = path.join(os.tmpdir(), "citadel-pty");

export function pipePaneLogPath(sessionName: string) {
  return path.join(PIPE_PANE_LOG_DIR, `${sessionName}.log`);
}

function attachPipePaneLog(sessionName: string) {
  fs.mkdirSync(PIPE_PANE_LOG_DIR, { recursive: true });
  const logPath = pipePaneLogPath(sessionName);
  // Truncate any stale log from a previous incarnation of this session name.
  try {
    fs.writeFileSync(logPath, "");
  } catch {
    /* tmpdir is read-only — pipe-pane will recreate on first write */
  }
  // Default direction is "-O" (pane → command). Omitting -o means we always
  // replace any existing pipe rather than no-op, so re-attach is idempotent.
  const shellCmd = `cat >> ${shellQuote(logPath)}`;
  execFileSync("tmux", [...tmuxPrefix(), "pipe-pane", "-t", sessionName, shellCmd], { stdio: "ignore" });
}

// Return the tail of the pipe-pane log (or empty string if unavailable). Used
// by verification paths that need to inspect bytes that may have scrolled out
// of the visible pane.
export function readPipePaneTail(sessionName: string, maxBytes = 16 * 1024): string {
  const logPath = pipePaneLogPath(sessionName);
  try {
    const stat = fs.statSync(logPath);
    const offset = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Path of the "agent still running" sentinel file for a given tmux session.
// The wrapper script touches this before exec'ing the agent and removes it
// after the agent exits. The reconciler reads it to distinguish "agent
// running" from "agent exited but pane still alive in fallback shell".
export function agentLiveSentinelPath(sessionName: string) {
  return path.join(os.tmpdir(), `citadel-agent-${sessionName}.live`);
}

// Side-channel exit-code file. The bash wrapper writes the agent's `$?` here
// immediately after the agent process returns (or via the EXIT trap on
// signal death). The status monitor reads it to classify stopped/failed.
export function agentExitSentinelPath(sessionName: string) {
  return path.join(os.tmpdir(), `citadel-agent-${sessionName}.exit`);
}

export function isAgentLive(sessionName: string) {
  return fs.existsSync(agentLiveSentinelPath(sessionName));
}

// Reads the recorded exit code for an agent session, or null if no .exit
// file is present (agent hasn't exited yet, or wrapper crashed before writing).
export function readAgentExitCode(sessionName: string): number | null {
  const exitPath = agentExitSentinelPath(sessionName);
  try {
    const raw = fs.readFileSync(exitPath, "utf8").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Wrap the agent so the tmux pane survives its exit: Ctrl+C in Claude Code
// would otherwise kill PID 1 of the pane. After exit we drop into a fresh
// interactive login shell at the workspace cwd. A tmpdir sentinel marks
// "agent live" so the reconciler can flip session status without killing the
// pane. Outer shell is non-login (`bash -c`) so we don't silently source
// ~/.bash_profile per agent; the post-exit fallback IS a login shell and
// respects $SHELL so zsh/fish users aren't forced into bash.
function terminalCommand(sessionName: string, command: string, args: string[]) {
  const argv = [command, ...args].map(shellQuote).join(" ");
  const envPrefix = "env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1";
  const liveSentinel = shellQuote(agentLiveSentinelPath(sessionName));
  const exitSentinel = shellQuote(agentExitSentinelPath(sessionName));
  const exitHint = "[citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume <sessionId>`).";
  // The trap fires on bash signal-death (the bash shell receives SIGTERM/SIGINT
  // mid-`<agent>`); the explicit lines after `<agent>` cover the happy-path
  // (natural agent exit) before `exec` replaces this bash with the fallback
  // shell. The explicit lines run normally; the trap also runs on signal but
  // `exec` skips the trap on the happy path. `$?` at trap time reflects the
  // killed agent's exit status (typically 130/SIGINT or 143/SIGTERM).
  //
  // `rm -f ${exitSentinel}` first: if a previous incarnation with the same
  // tmux session name left a stale .exit on disk (daemon restart, /tmp not
  // cleared), the status monitor would read it and mark this fresh session
  // as already-stopped. Clearing before touching .live guarantees a clean
  // slate per wrapper invocation.
  const script = [
    `rm -f ${exitSentinel}`,
    `touch ${liveSentinel}`,
    `trap 'rc=$?; echo $rc > ${exitSentinel}; rm -f ${liveSentinel}' EXIT`,
    `${envPrefix} ${argv}`,
    "rc=$?",
    `echo $rc > ${exitSentinel}`,
    `rm -f ${liveSentinel}`,
    `printf '\\n%s\\n' ${shellQuote(exitHint)}`,
    'exec "${SHELL:-/bin/bash}" -l',
  ].join("; ");
  return `bash -c ${shellQuote(script)}`;
}

export function shellQuote(value: string) {
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Per-run cap on pipe-pane log size. tmux pipe-pane streams the raw PTY bytes
 * into `head -c LOG_TRUNCATION_BYTES`, which exits on cap and closes the pipe,
 * after which pipe-pane stops writing. We surface the cap via stat at run-row
 * close (see scheduledAgents.executeRun).
 */
export const LOG_TRUNCATION_BYTES = 16 * 1024 * 1024;

/**
 * Like ensureTmuxSession but bypasses the agent-wrapper script — runs
 * `command args` directly under tmux. When the command exits, the pane
 * terminates. Used by background scheduled-agent runs where:
 *  - There is no human to "fall back" to a shell for.
 *  - We do NOT want the wrapper's "[citadel] Agent exited" line + fallback
 *    shell PS1 to stream into the per-run log file via pipe-pane.
 *  - We DO want the reconciler to see `tmuxSessionExists === false` on the
 *    next tick after the agent exits so the run row closes promptly.
 */
export async function ensureTmuxSessionRaw(input: TerminalSessionRequest) {
  if (tmuxSessionExists(input.sessionName)) {
    const id = execFileSync(
      "tmux",
      [...tmuxPrefix(), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    return { tmuxSessionName: input.sessionName, tmuxSessionId: id };
  }
  try {
    fs.writeFileSync(agentLiveSentinelPath(input.sessionName), "");
  } catch {
    // best-effort
  }
  // tmux new-session takes a single `shell-command` string and hands it to
  // /bin/sh -c. Build it ourselves with shellQuote so an arg with spaces is
  // preserved correctly. Compare to ensureTmuxSession which wraps in `bash -c`.
  const shellCommand = [input.command, ...input.args].map(shellQuote).join(" ");
  await execFileAsync(
    "tmux",
    [...tmuxPrefix(), "new-session", "-d", "-s", input.sessionName, "-c", input.cwd, shellCommand],
    {
      timeout: 10000,
      maxBuffer: 128 * 1024,
    },
  );
  ensureTmuxExtendedKeys();
  const id = execFileSync(
    "tmux",
    [...tmuxPrefix(), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  return { tmuxSessionName: input.sessionName, tmuxSessionId: id };
}

/**
 * Start streaming a tmux pane to a per-run log file via `tmux pipe-pane -O`.
 * Bounded by `head -c LOG_TRUNCATION_BYTES` so a runaway agent can't fill
 * disk. `logFilePath` is shellQuoted; we never hand pipe-pane an unquoted
 * user-controlled path.
 */
export function pipeBackgroundSessionToLog(sessionName: string, logFilePath: string) {
  const quoted = shellQuote(logFilePath);
  const command = `head -c ${LOG_TRUNCATION_BYTES} >> ${quoted}`;
  execFileSync("tmux", [...tmuxPrefix(), "pipe-pane", "-O", "-t", sessionName, command]);
}

/** Stop the pipe-pane stream on a session (no command = stop streaming). */
export function stopBackgroundSessionPipe(sessionName: string) {
  execFileSync("tmux", [...tmuxPrefix(), "pipe-pane", "-t", sessionName]);
}

/**
 * Returns true when the pane's command has exited (regardless of whether
 * `remain-on-exit` is keeping the pane visible). Useful for background
 * sessions where we never injected the wrapper's `isAgentLive` sentinel —
 * the reconciler relies on this signal to close the matching run row.
 */
export function tmuxPaneDead(sessionName: string): boolean {
  try {
    const output = execFileSync("tmux", [...tmuxPrefix(), "list-panes", "-t", sessionName, "-F", "#{pane_dead}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // First pane's value — for our single-pane background sessions this is
    // the only one we care about.
    const first = output.split(/\s+/)[0] ?? "0";
    return first === "1";
  } catch {
    // Session itself is gone → treat as dead.
    return true;
  }
}

export function tmuxSessionExists(sessionName: string) {
  try {
    execFileSync("tmux", [...tmuxPrefix(), "has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function ensureTmuxExtendedKeys() {
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-s", "extended-keys", "on"], { stdio: "ignore" });
  const features = execFileSync("tmux", [...tmuxPrefix(), "show-options", "-s", "-g", "terminal-features"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!/xterm\*[^\n]*\bextkeys\b/.test(features)) {
    execFileSync("tmux", [...tmuxPrefix(), "set-option", "-as", "terminal-features", ",xterm*:extkeys"], {
      stdio: "ignore",
    });
  }
  // Cap per-pane scrollback. The previous default (2000) was already low in
  // line-count, but unset history-limit is what compounds: long-running tmux
  // servers in citadel-tmux.service accumulate tmux client structs (one per
  // ttyd browser connection / WS reconnect), and the per-client screen state
  // grows with the per-pane scrollback ceiling. 5000 keeps headroom for
  // operator inspection while bounding worst-case server memory.
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-g", "history-limit", "5000"], { stdio: "ignore" });
}

export function captureTmux(sessionName: string, lines = 200) {
  try {
    return execFileSync("tmux", [...tmuxPrefix(), "capture-pane", "-p", "-S", `-${lines}`, "-t", sessionName], {
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
    raw = execFileSync(
      "tmux",
      [...tmuxPrefix(), "capture-pane", "-p", "-J", "-S", `-${requestedLines}`, "-t", sessionName],
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

export function captureTmuxVisibleScreen(sessionName: string, lines = 200) {
  try {
    return execFileSync("tmux", [...tmuxPrefix(), "capture-pane", "-a", "-p", "-S", `-${lines}`, "-t", sessionName], {
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
    text = execFileSync("tmux", [...tmuxPrefix(), "capture-pane", "-p", "-e", "-t", sessionName], {
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
      [...tmuxPrefix(), "display-message", "-p", "-t", sessionName, "#{cursor_y},#{cursor_x}"],
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
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const pollMs = options.pollMs ?? 80;
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = execFileSync(
        "tmux",
        [...tmuxPrefix(), "display-message", "-p", "-t", sessionName, "#{pane_current_command}"],
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
//
// tmux's silence threshold is integer seconds (minimum 1), so this gives us
// coarse-but-reliable "is the runtime quiet" signal. Fine-grained idle waits
// (post-paste settle, etc.) still fall back to capture-pane polling.
function armSilenceHook(sessionName: string, seconds: number) {
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
    execFileSync("tmux", [...tmuxPrefix(), "set-option", "-p", "-t", sessionName, "monitor-silence", String(seconds)], {
      stdio: "ignore",
    });
    // -b: run the touch in the background so tmux doesn't block its event loop on it.
    execFileSync(
      "tmux",
      [
        ...tmuxPrefix(),
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

function disarmSilenceHook(sessionName: string) {
  try {
    execFileSync("tmux", [...tmuxPrefix(), "set-option", "-p", "-u", "-t", sessionName, "monitor-silence"], {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
  try {
    execFileSync("tmux", [...tmuxPrefix(), "set-hook", "-p", "-u", "-t", sessionName, "alert-silence-pane"], {
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
//   2. capture-pane diffing — kept as a fallback for the sub-second case where
//      the silence-hook threshold (whole seconds) is coarser than the idleMs
//      the caller actually wants.
//
// Best-effort — never throws.
export async function waitForTerminalIdle(
  sessionName: string,
  options: { timeoutMs?: number; idleMs?: number; pollMs?: number; useSilenceHook?: boolean } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const idleMs = options.idleMs ?? 250;
  const pollMs = options.pollMs ?? 80;
  const useSilenceHook = options.useSilenceHook ?? idleMs >= 1000;
  const deadline = Date.now() + Math.max(idleMs + pollMs, timeoutMs);

  // Arm the tmux silence hook in parallel with capture-pane polling — whichever
  // signal fires first wins. The hook lets tmux's own event loop tell us when
  // the runtime has been quiet, which is far cheaper than capture-pane diffing
  // and immune to mid-paint false-positive lulls. We only arm it when idleMs
  // is at least 1s (tmux's minimum silence threshold); below that the polling
  // diff is the better tool.
  const silenceSeconds = useSilenceHook ? Math.max(1, Math.round(idleMs / 1000)) : 0;
  if (silenceSeconds > 0) armSilenceHook(sessionName, silenceSeconds);
  const sentinel = silenceSentinelPath(sessionName);
  try {
    let last = safeCapture(sessionName);
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      if (silenceSeconds > 0 && safeStatExists(sentinel)) return;
      const current = safeCapture(sessionName);
      if (current === last) {
        if (Date.now() - stableSince >= idleMs) return;
        continue;
      }
      last = current;
      stableSince = Date.now();
    }
  } finally {
    if (silenceSeconds > 0) disarmSilenceHook(sessionName);
  }
}

function safeStatExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function safeCapture(sessionName: string): string {
  try {
    return execFileSync("tmux", [...tmuxPrefix(), "capture-pane", "-p", "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

export function sendKeys(sessionName: string, data: string) {
  for (const token of tokenizeTerminalInput(data)) {
    if (token.literal) {
      execFileSync("tmux", [...tmuxPrefix(), "send-keys", "-l", "-t", sessionName, token.value]);
    } else {
      execFileSync("tmux", [...tmuxPrefix(), "send-keys", "-t", sessionName, token.value]);
    }
  }
}

// `bracketed: true` wraps the paste in `ESC[200~ … ESC[201~` so the receiving
// runtime knows it's literal text (not keys). TUIs that opt into bracketed
// paste mode (Claude Code, Codex, anything readline-based with the mode on)
// will atomically commit the chunk to their input buffer regardless of how
// long their initial paint takes — no idle-window race, no LF-inside-paste
// getting misread as Enter. Default stays off so plain-shell paste paths
// (tests, generic shell sessions) keep working byte-for-byte.
export function pasteText(sessionName: string, data: string, options: { bracketed?: boolean } = {}) {
  const bufferName = `citadel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync("tmux", [...tmuxPrefix(), "load-buffer", "-b", bufferName, "-"], { input: data });
  const args = options.bracketed
    ? ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", sessionName]
    : ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName];
  execFileSync("tmux", [...tmuxPrefix(), ...args]);
}

export function resizePane(sessionName: string, cols: number, rows: number) {
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(120, Math.max(5, Math.trunc(rows)));
  execFileSync("tmux", [
    ...tmuxPrefix(),
    "resize-pane",
    "-t",
    sessionName,
    "-x",
    String(safeCols),
    "-y",
    String(safeRows),
  ]);
}

export function killTmuxSession(sessionName: string) {
  if (tmuxSessionExists(sessionName)) {
    execFileSync("tmux", [...tmuxPrefix(), "kill-session", "-t", sessionName]);
  }
  try {
    fs.rmSync(agentLiveSentinelPath(sessionName), { force: true });
  } catch {
    // best-effort
  }
  try {
    fs.rmSync(agentExitSentinelPath(sessionName), { force: true });
  } catch {
    // best-effort
  }
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
