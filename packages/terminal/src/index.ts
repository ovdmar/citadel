import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";

export { createTtydManager, TtydUnavailableError } from "./ttyd.js";
export type { TtydEntry, TtydManager, TtydManagerConfig, TtydTheme } from "./ttyd.js";

const execFileAsync = promisify(execFile);

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
    await execFileAsync("tmux", ["new-session", "-d", "-s", input.sessionName, "-c", input.cwd, command], {
      timeout: 10000,
      maxBuffer: 128 * 1024,
    });
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
  const id = execFileSync("tmux", ["display-message", "-p", "-t", input.sessionName, "#{session_id}"], {
    encoding: "utf8",
  }).trim();
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
  execFileSync("tmux", ["pipe-pane", "-t", sessionName, shellCmd], { stdio: "ignore" });
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

export function isAgentLive(sessionName: string) {
  return fs.existsSync(agentLiveSentinelPath(sessionName));
}

// Wrap the agent invocation so the tmux pane survives the agent's exit.
//
// Today pressing Ctrl+C inside a running agent (e.g. Claude Code) leaves an
// unusable terminal: the pane becomes dead because the agent process was PID 1
// of the pane. The wrapper drops the user back into a fresh interactive login
// shell rooted at the workspace cwd so they can run any command, including
// `claude resume <sessionId>`.
//
// A sentinel file under tmpdir marks "agent currently live"; the reconciler
// consults it to flip the session status to "stopped" without killing the
// pane.
//
// Outer shell is intentionally non-login (`bash -c`, not `bash -lc`) so the
// agent's environment matches what tmux delivered before this wrapper
// existed — we don't want to silently start sourcing `~/.bash_profile` for
// every agent. The *fallback* shell the user sees after the agent exits IS a
// login shell (so they get their normal interactive setup) and respects
// `$SHELL` so zsh/fish users aren't forced into bash.
function terminalCommand(sessionName: string, command: string, args: string[]) {
  const argv = [command, ...args].map(shellQuote).join(" ");
  const envPrefix = "env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1";
  const sentinel = shellQuote(agentLiveSentinelPath(sessionName));
  const exitHint = "[citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume <sessionId>`).";
  const script = [
    `touch ${sentinel}`,
    `trap 'rm -f ${sentinel}' EXIT`,
    `${envPrefix} ${argv}`,
    `rm -f ${sentinel}`,
    `printf '\\n%s\\n' ${shellQuote(exitHint)}`,
    'exec "${SHELL:-/bin/bash}" -l',
  ].join("; ");
  return `bash -c ${shellQuote(script)}`;
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

export function ensureTmuxExtendedKeys() {
  execFileSync("tmux", ["set-option", "-s", "extended-keys", "on"], { stdio: "ignore" });
  const features = execFileSync("tmux", ["show-options", "-s", "-g", "terminal-features"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!/xterm\*[^\n]*\bextkeys\b/.test(features)) {
    execFileSync("tmux", ["set-option", "-as", "terminal-features", ",xterm*:extkeys"], { stdio: "ignore" });
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
      last = execFileSync("tmux", ["display-message", "-p", "-t", sessionName, "#{pane_current_command}"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
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
    execFileSync("tmux", ["set-option", "-p", "-t", sessionName, "monitor-silence", String(seconds)], {
      stdio: "ignore",
    });
    // -b: run the touch in the background so tmux doesn't block its event loop on it.
    execFileSync(
      "tmux",
      [
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
    execFileSync("tmux", ["set-option", "-p", "-u", "-t", sessionName, "monitor-silence"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  try {
    execFileSync("tmux", ["set-hook", "-p", "-u", "-t", sessionName, "alert-silence-pane"], { stdio: "ignore" });
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
    return execFileSync("tmux", ["capture-pane", "-p", "-t", sessionName], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

// Submit a prompt or follow-up message into a tmux-backed runtime.
//
// Step-by-step, with the "why" for each:
//   1. Wait until the runtime's process is the foreground command in the pane
//      (`#{pane_current_command}` ≠ wrapper bash). This rules out the "we
//      sent keys while `bash -c …` was still doing setup" failure mode that
//      visual idle-detection can't see.
//   2. Wait for the pane to settle (silence-hook + capture-pane fallback).
//   3. Paste the prompt as a BRACKETED paste so the runtime sees one atomic
//      "this is text, not keystrokes" event. Solves the case where the
//      runtime's bracketed-paste mode flips on between our trim and our paste.
//   4. Verify by capture-pane that our prompt text actually appears in the
//      bottom rows of the pane (input area). If not, re-paste once.
//   5. Send Enter as a SEPARATE tmux call so it lands outside the paste
//      region.
//   6. Verify the prompt is no longer pending in the input area. If it is,
//      the Enter did not take (most common cause: runtime hadn't finished
//      committing the paste to input state). Send Enter again, up to 2
//      retries.
// Returns ok=false with an error string if any step exhausts its budget.
export async function submitPrompt(
  sessionName: string,
  prompt: string,
  options: {
    waitForReadyMs?: number;
    submitDelayMs?: number;
    submitKey?: string;
    runtimeReadyPredicate?: (cmd: string) => boolean;
    skipVerification?: boolean;
  } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!tmuxSessionExists(sessionName)) return { ok: false, error: "tmux_session_missing" };
  const submitKey = options.submitKey ?? "Enter";
  // Defaults are deliberately generous for cold-start TUIs (Claude Code with
  // MCP servers connecting can paint for 10+ seconds). Tests pass tighter
  // values explicitly.
  const waitForReadyMs = options.waitForReadyMs ?? 8000;
  const submitDelayMs = options.submitDelayMs ?? 3000;
  try {
    // 1. Runtime-foreground check — best-effort, never blocks the actual send.
    if (options.runtimeReadyPredicate) {
      await waitForPaneCommand(sessionName, options.runtimeReadyPredicate, { timeoutMs: waitForReadyMs });
    }
    // 2. Pane settle pre-paste. Use the silence hook (idleMs >= 1s) to lean
    //    on tmux's event loop rather than busy-polling capture-pane.
    await waitForTerminalIdle(sessionName, { timeoutMs: waitForReadyMs, idleMs: 1000 });

    // Trim trailing newlines so the paste itself never carries an LF the
    // runtime might treat as the submit keystroke — we always rely on the
    // explicit Enter that follows.
    const text = prompt.replace(/[\r\n]+$/u, "");
    const wantVerification = !options.skipVerification && text.length > 0;
    // Substring we expect to see in the input area after the paste. We use a
    // tail slice rather than the whole prompt because long prompts get
    // line-wrapped by the TUI and we'd never match the full text verbatim
    // against capture-pane's rendered output.
    const verifySnippet = verificationSnippet(text);
    if (text.length > 0) {
      // 3. Bracketed paste. We deliberately do NOT retry the paste: if the
      // verification snippet is missing, retrying just stacks two copies of
      // the prompt in the runtime's input box (the first paste DID land — we
      // just can't find the snippet because of wrap/animation). The Enter
      // retry below covers the genuine "Enter didn't submit" failure mode.
      pasteText(sessionName, text, { bracketed: true });
      // Post-paste settle: short, because we don't want to delay Enter
      // any longer than necessary, and capture-pane diff handles sub-second
      // idle better than the silence hook anyway.
      await waitForTerminalIdle(sessionName, {
        timeoutMs: submitDelayMs,
        idleMs: 200,
        pollMs: 60,
      });
      if (wantVerification && verifySnippet !== null && !pasteVisible(sessionName, verifySnippet)) {
        return { ok: false, error: "paste_not_visible" };
      }
    }

    // 5. Submit. We don't post-verify the Enter: most TUIs render the
    // submitted prompt in the conversation history (still in the bottom rows
    // of the pane), so "snippet still visible" doesn't distinguish "Enter
    // didn't submit" from "Enter submitted and the runtime is echoing the
    // history." The pre-paste idle wait + paste-visible verification above
    // are the load-bearing checks; this Enter is the easy part.
    execFileSync("tmux", ["send-keys", "-t", sessionName, submitKey]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "submit_prompt_failed" };
  }
}

// Last meaningful slice of the prompt we'll try to spot in the input region
// after pasting. We avoid matching on whitespace-only or extremely short
// snippets to keep false positives down. Returns null when verification
// should be skipped (e.g. prompts that are too short to fingerprint).
//
// Returned snippet is whitespace-collapsed (single spaces, no newlines) so
// the caller can compare against a similarly-normalized capture and the TUI
// line-wrap can't split the match.
function verificationSnippet(text: string): string | null {
  const normalized = collapseWhitespace(text);
  if (normalized.length < 4) return null;
  // The TAIL of the prompt is the most reliable signal: TUIs render the input
  // area bottom-aligned so the most recent chars are guaranteed to be visible
  // even when the start of a long prompt has scrolled. 24 chars is long
  // enough to be distinctive but short enough that we don't get unlucky and
  // straddle two wrap boundaries even when each wrapped segment is short.
  const tail = normalized.slice(-24);
  return tail.length >= 4 ? tail : null;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Is the verification snippet currently rendered anywhere in the bottom
// portion of the pane (i.e. the input area)? We check the last 12 visible
// rows — enough to cover multi-line input boxes without scanning the whole
// transcript. The capture is whitespace-collapsed before matching so TUI
// line-wrap (which inserts \n into the middle of a logical line) can't fool
// the substring check.
//
// Also accepts a TUI-specific "collapsed paste" marker as evidence: Claude
// Code replaces long pastes with `[Pasted text #N +K lines]` in the rendered
// input, so the snippet won't be on screen even though the paste landed
// fine in the runtime's internal buffer. The collapse marker is itself
// proof the paste was received.
function pasteVisible(sessionName: string, snippet: string): boolean {
  let captured: string;
  try {
    captured = execFileSync(
      "tmux",
      ["capture-pane", "-p", "-J", "-S", "-12", "-t", sessionName],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 },
    );
  } catch {
    return false;
  }
  const normalized = collapseWhitespace(captured);
  if (normalized.includes(snippet)) return true;
  // Claude Code: `[Pasted text #1 +101 lines]` (or "#1 paste again to expand").
  // We match loosely on "Pasted" + "#" + a digit because the exact suffix
  // varies with paste size and Claude version.
  return /\[Pasted [^\]]*#\d+/u.test(normalized);
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

// `bracketed: true` wraps the paste in `ESC[200~ … ESC[201~` so the receiving
// runtime knows it's literal text (not keys). TUIs that opt into bracketed
// paste mode (Claude Code, Codex, anything readline-based with the mode on)
// will atomically commit the chunk to their input buffer regardless of how
// long their initial paint takes — no idle-window race, no LF-inside-paste
// getting misread as Enter. Default stays off so plain-shell paste paths
// (tests, generic shell sessions) keep working byte-for-byte.
export function pasteText(sessionName: string, data: string, options: { bracketed?: boolean } = {}) {
  const bufferName = `citadel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync("tmux", ["load-buffer", "-b", bufferName, "-"], { input: data });
  const args = options.bracketed
    ? ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", sessionName]
    : ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName];
  execFileSync("tmux", args);
}

export function resizePane(sessionName: string, cols: number, rows: number) {
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(120, Math.max(5, Math.trunc(rows)));
  execFileSync("tmux", ["resize-pane", "-t", sessionName, "-x", String(safeCols), "-y", String(safeRows)]);
}

export function killTmuxSession(sessionName: string) {
  if (tmuxSessionExists(sessionName)) {
    execFileSync("tmux", ["kill-session", "-t", sessionName]);
  }
  try {
    fs.rmSync(agentLiveSentinelPath(sessionName), { force: true });
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
