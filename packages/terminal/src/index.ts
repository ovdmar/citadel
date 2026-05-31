import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export { submitPrompt } from "./submit-prompt.js";
export {
  DEFAULT_TMUX_HISTORY_LIMIT,
  ensureTmuxExtendedKeys,
  tmuxHistoryLimit,
  tmuxPrefix,
  tmuxSocketNameForWorkspace,
} from "./tmux.js";
export type { TmuxSocketName } from "./tmux.js";
import { ensureTmuxExtendedKeys, tmuxPrefix } from "./tmux.js";

import { tokenizeTerminalInput } from "./input-tokens.js";
export { keyForControlCharacter, keyForEscapeSequence, tokenizeTerminalInput } from "./input-tokens.js";
export type { InputToken } from "./input-tokens.js";

import { captureTmuxSnapshot, waitForTerminalIdle } from "./capture.js";
export {
  attachTerminalWebSocket,
  attachTmuxPty,
  clampSize as clampTerminalPtySize,
  parseTerminalSocketMessage,
} from "./tmux-pty-bridge.js";

const execFileAsync = promisify(execFile);

/**
 * Shell-first session request. The pane's PID is `bash -l` — the agent (if
 * any) is launched as a child of the shell via `launchAgentInSession` after
 * `ensureTmuxSession` returns. The legacy wrapper that exec'd the agent as
 * the pane process is gone; with it go the /tmp sentinel files, the EXIT
 * trap, and the post-exit fallback shell.
 *
 * For the background-hook path that must run a command that exits cleanly
 * (no shell phase, pane terminates with the command), use
 * `ensureTmuxSessionRaw` instead.
 */
export type TerminalSessionRequest = {
  sessionName: string;
  cwd: string;
  terminal?: {
    command: string;
    args?: string[];
  };
  socketName?: string | null;
};

export async function ensureTmuxSession(input: TerminalSessionRequest) {
  const exists = tmuxSessionExists(input.sessionName, input.socketName);
  const freshlyCreated = !exists;
  if (!exists) {
    const terminal = input.terminal ?? { command: "bash", args: ["-l"] };
    // Shell-first: the pane PID is `bash -l`. The agent, if there is one, is
    // launched into this shell via send-keys (see launchAgentInSession). The
    // -e flags propagate the colour-env tokens the legacy wrapper used to set
    // via `env -u NO_COLOR ...` — same tokens, just exported into the shell
    // (and from there, into any child process the shell launches).
    await execFileAsync(
      "tmux",
      [
        ...tmuxPrefix(input.socketName),
        "new-session",
        "-d",
        "-s",
        input.sessionName,
        "-c",
        input.cwd,
        "-e",
        "TERM=xterm-256color",
        "-e",
        "COLORTERM=truecolor",
        "-e",
        "FORCE_COLOR=1",
        "-e",
        "CLICOLOR_FORCE=1",
        terminal.command,
        ...(terminal.args ?? []),
      ],
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
      attachPipePaneLog(input.sessionName, input.socketName);
    } catch {
      /* noop */
    }
  }
  ensureTmuxExtendedKeys(input.socketName);
  const id = execFileSync(
    "tmux",
    [...tmuxPrefix(input.socketName), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  // Wait for the shell prompt to settle so callers can immediately
  // `launchAgentInSession` or `submitPrompt` without losing keystrokes to
  // bash's startup window.
  if (freshlyCreated)
    await waitForTerminalIdle(input.sessionName, {
      timeoutMs: 1500,
      idleMs: 200,
      socketName: input.socketName ?? null,
    });
  return { tmuxSessionName: input.sessionName, tmuxSessionId: id, tmuxSocketName: input.socketName ?? null };
}

import { attachPipePaneLog } from "./pipe-pane-log.js";
export { pipePaneLogPath, readPipePaneTail, sweepPtyLogs } from "./pipe-pane-log.js";
export {
  COMM_TRUNCATION,
  DEFAULT_SENTINEL_MARKER_PATH,
  DEFAULT_SENTINEL_MAX_AGE_MS,
  DEFAULT_SENTINEL_SAFEGUARD,
  agentExitHintCommand,
  launchAgentInSession,
  panePidProcess,
  sweepLegacyAgentSentinels,
} from "./pane-lifecycle.js";
export type { AgentExitHint, PanePidProcess, SweepLegacySentinelsResult } from "./pane-lifecycle.js";

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
 * Background-run session. Runs `command args` as the pane process directly
 * — when the command exits, the pane terminates. This is distinct from
 * `ensureTmuxSession`'s shell-first model because background scheduled-agent
 * runs:
 *  - Have no human to "fall back" to a shell for.
 *  - Do NOT want a shell prompt streamed into the per-run pipe-pane log file.
 *  - DO want the reconciler to see `tmuxSessionExists === false` on the next
 *    tick after the command exits so the run row closes promptly.
 *
 * Background runs continue to produce a /tmp/citadel-agent-<name>.live
 * sentinel pre-creation guard because they don't go through the shell-first
 * code path; the reconciler tolerates legacy sentinels for raw sessions.
 */
export type RawTerminalSessionRequest = {
  sessionName: string;
  cwd: string;
  command: string;
  args: string[];
  socketName?: string | null;
};

export async function ensureTmuxSessionRaw(input: RawTerminalSessionRequest) {
  if (tmuxSessionExists(input.sessionName, input.socketName)) {
    const id = execFileSync(
      "tmux",
      [...tmuxPrefix(input.socketName), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
      {
        encoding: "utf8",
      },
    ).trim();
    return { tmuxSessionName: input.sessionName, tmuxSessionId: id, tmuxSocketName: input.socketName ?? null };
  }
  try {
    fs.writeFileSync(agentLiveSentinelPath(input.sessionName), "");
  } catch {
    // best-effort
  }
  // tmux new-session takes a single `shell-command` string and hands it to
  // /bin/sh -c. Build it ourselves with shellQuote so an arg with spaces is
  // preserved correctly.
  const shellCommand = [input.command, ...input.args].map(shellQuote).join(" ");
  await execFileAsync(
    "tmux",
    [...tmuxPrefix(input.socketName), "new-session", "-d", "-s", input.sessionName, "-c", input.cwd, shellCommand],
    {
      timeout: 10000,
      maxBuffer: 128 * 1024,
    },
  );
  ensureTmuxExtendedKeys(input.socketName);
  const id = execFileSync(
    "tmux",
    [...tmuxPrefix(input.socketName), "display-message", "-p", "-t", input.sessionName, "#{session_id}"],
    {
      encoding: "utf8",
    },
  ).trim();
  return { tmuxSessionName: input.sessionName, tmuxSessionId: id, tmuxSocketName: input.socketName ?? null };
}

/**
 * Start streaming a tmux pane to a per-run log file via `tmux pipe-pane -O`.
 * Bounded by `head -c LOG_TRUNCATION_BYTES` so a runaway agent can't fill
 * disk. `logFilePath` is shellQuoted; we never hand pipe-pane an unquoted
 * user-controlled path.
 */
export function pipeBackgroundSessionToLog(sessionName: string, logFilePath: string, socketName?: string | null) {
  const quoted = shellQuote(logFilePath);
  const command = `head -c ${LOG_TRUNCATION_BYTES} >> ${quoted}`;
  execFileSync("tmux", [...tmuxPrefix(socketName), "pipe-pane", "-O", "-t", sessionName, command]);
}

/** Stop the pipe-pane stream on a session (no command = stop streaming). */
export function stopBackgroundSessionPipe(sessionName: string, socketName?: string | null) {
  execFileSync("tmux", [...tmuxPrefix(socketName), "pipe-pane", "-t", sessionName]);
}

/**
 * Returns true when the pane's command has exited (regardless of whether
 * `remain-on-exit` is keeping the pane visible). Useful for background
 * sessions where we never injected the wrapper's `isAgentLive` sentinel —
 * the reconciler relies on this signal to close the matching run row.
 */
export function tmuxPaneDead(sessionName: string, socketName?: string | null): boolean {
  try {
    const output = execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "list-panes", "-t", sessionName, "-F", "#{pane_dead}"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    // First pane's value — for our single-pane background sessions this is
    // the only one we care about.
    const first = output.split(/\s+/)[0] ?? "0";
    return first === "1";
  } catch {
    // Session itself is gone → treat as dead.
    return true;
  }
}

export function tmuxSessionExists(sessionName: string, socketName?: string | null) {
  try {
    execFileSync("tmux", [...tmuxPrefix(socketName), "has-session", "-t", sessionName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Snapshot of every session currently on the citadel tmux socket. Returns a
// Set when the tmux server is reachable (possibly empty if it has zero
// sessions), or `null` when the server itself isn't reachable — the caller
// can distinguish "server up with no sessions" from "server down / not yet
// started," which matters for the fresh-boot reconciler: in tests and in
// pre-tmux-service environments we don't want to mass-flip live DB rows
// just because we couldn't talk to a server. Used by:
//   - boot-restore's reconciler (flip DB rows whose tmux is missing)
//   - orphan reaper (find tmux sessions no DB row knows about)
export function listAllTmuxSessions(socketName?: string | null): Set<string> | null {
  try {
    const output = execFileSync("tmux", [...tmuxPrefix(socketName), "list-sessions", "-F", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch (error) {
    // `list-sessions` on a reachable server with zero sessions exits 1 with
    // stderr "no server running on …" — distinguish that from the
    // server-is-up-with-sessions case using has-session as a probe. A bare
    // `has-session` (no `-t`) returns 0 when the server is up and has at
    // least one session, 1 when up with zero sessions, and non-zero with
    // stderr "no server running" when the socket is unbound.
    try {
      execFileSync("tmux", [...tmuxPrefix(socketName), "has-session"], { stdio: ["ignore", "ignore", "pipe"] });
      // Server up with sessions — list-sessions shouldn't have failed; fall through.
      return new Set();
    } catch (probeError) {
      const stderr =
        probeError && typeof probeError === "object" && "stderr" in probeError
          ? String((probeError as { stderr: unknown }).stderr ?? "")
          : "";
      // "no server running" → unreachable. Any other failure (e.g. has-session
      // saying "no sessions") still means the server IS up, just empty.
      if (stderr.includes("no server running")) return null;
      // Fall back to the original execFileSync error's stderr.
      const origStderr =
        error && typeof error === "object" && "stderr" in error
          ? String((error as { stderr: unknown }).stderr ?? "")
          : "";
      if (origStderr.includes("no server running")) return null;
      return new Set();
    }
  }
}

// Inspect who actually owns `/tmp/tmux-<uid>/<socket>` vs. who systemd thinks
// should own it. Three kinds:
//   - "absent": no socket / no server bound to the socket.
//   - "supervised": socket owner PID == citadel-tmux.service's MainPID.
//   - "orphan": socket owner is a tmux process NOT under citadel-tmux.service
//     (e.g. auto-spawned by a stray `tmux -L citadel new-session` call from
//     the daemon or a user shell). The unit can't bind a second server to the
//     same socket name, so `systemctl start citadel-tmux.service` fails until
//     the orphan exits. The daemon surfaces this state in /api/health so the
//     cockpit can show a degraded banner with a "Run make tmux-service to
//     reconcile" hint — that command is the only safe way to graceful-restart
//     into a supervised tmux server, and it's destructive (every live agent
//     pane dies and is `claude --resume`d back).
export type TmuxServerOwnership =
  | { kind: "absent" }
  | { kind: "supervised"; pid: number }
  | { kind: "orphan"; pid: number; supervisedPid: number | null }
  | { kind: "worktree-self"; pid: number; socket: string };

export function getTmuxServerOwnership(): TmuxServerOwnership {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  // Without a configured socket the daemon has no opinion (legacy/test mode).
  // Report absent so callers don't gate on a state that doesn't apply.
  if (!sock) return { kind: "absent" };
  const socketPath = path.join(`/tmp/tmux-${process.getuid?.() ?? ""}`, sock);
  if (!fs.existsSync(socketPath)) return { kind: "absent" };
  // `fuser` is in psmisc on every distro we ship to and answers in O(ms).
  // Output format: "<path>: <pid>". A single owner is the normal case (tmux's
  // server holds the listening fd); multiple owners are abnormal but we just
  // take the first since they're all under the same tmux server.
  let ownerPid: number | null = null;
  try {
    const out = execFileSync("fuser", [socketPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const match = out.match(/(\d+)/);
    if (match?.[1]) ownerPid = Number(match[1]);
  } catch {
    return { kind: "absent" };
  }
  if (!ownerPid) return { kind: "absent" };
  // `systemctl --user show -p MainPID --value citadel-tmux.service` returns
  // the supervised PID, or "0" when the unit is inactive. Failing the call
  // (no systemd, not a user session) just means we can't make the supervised
  // determination — treat the owner as orphan with supervisedPid=null and
  // let the caller decide.
  let supervisedPid: number | null = null;
  try {
    const out = execFileSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", "citadel-tmux.service"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = Number(out.trim());
    supervisedPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    supervisedPid = null;
  }
  if (supervisedPid !== null && supervisedPid === ownerPid) return { kind: "supervised", pid: ownerPid };
  return { kind: "orphan", pid: ownerPid, supervisedPid };
}

// Make sure citadel-tmux.service is running before we issue tmux commands the
// daemon needs to spawn through it. The contract:
//   - "supervised": no-op, return ok.
//   - "absent": start the unit and re-probe; return ok if it's now supervised.
//   - "orphan": refuse to take action (starting the unit will fail anyway and
//     SIGKILLing the orphan would lose every live pane). Return the ownership
//     so the caller can degrade the daemon's state.
// Idempotent and safe to call from many places. The systemctl start is
// allowed even with RefuseManualStop=true — that directive only blocks stop
// and restart.
// Worktree daemons own a tmux server on a per-checkout socket (set via
// CITADEL_TMUX_SOCKET=citadel-w-<hash> by `make deploy`). The server is
// spawned detached so it survives `tsx watch` HMR restarts of the daemon —
// agent panes keep their tmux home across reloads. Idempotent: re-running
// after the server is up is a no-op.
//
// Why per-worktree (not the systemd-managed `citadel` socket): every daemon's
// orphan-reaper SIGKILLs tmux sessions not in its own DB. A worktree daemon
// sharing the prod socket would see prod's sessions as orphans and reap them
// — the bug that took out 162 live panes on 2026-05-27.
//
// NOT for the prod daemon. That path goes through ensureCitadelTmuxRunning,
// which probes systemd ownership (citadel-tmux.service); worktrees aren't
// systemd-supervised and the unit isn't aware of them.
export async function ensureWorktreeTmuxRunning(socket: string): Promise<TmuxServerOwnership> {
  if (!socket) throw new Error("ensureWorktreeTmuxRunning requires a non-empty socket name");
  const socketPath = path.join(`/tmp/tmux-${process.getuid?.() ?? ""}`, socket);
  const probePid = (): number | null => {
    if (!fs.existsSync(socketPath)) return null;
    try {
      execFileSync("tmux", ["-L", socket, "list-sessions"], {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 2000,
      });
    } catch {
      return null;
    }
    try {
      const out = execFileSync("fuser", [socketPath], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const match = out.match(/(\d+)/);
      return match?.[1] ? Number(match[1]) : null;
    } catch {
      return null;
    }
  };

  let pid = probePid();
  if (pid) return { kind: "worktree-self", pid, socket };

  // `-D` runs the server in foreground with exit-empty=off (stays alive with
  // zero sessions). `detached: true` puts the child in its own process group
  // so `make stop` (which kills the daemon's pgid) doesn't take the tmux
  // server down — agent panes survive daemon restarts.
  const subproc = spawn("tmux", ["-L", socket, "-D"], { detached: true, stdio: "ignore" });
  subproc.unref();

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    pid = probePid();
    if (pid) return { kind: "worktree-self", pid, socket };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Worktree tmux server on socket "${socket}" failed to bind within 3s`);
}

export async function ensureCitadelTmuxRunning(): Promise<TmuxServerOwnership> {
  const initial = getTmuxServerOwnership();
  if (initial.kind === "supervised" || initial.kind === "orphan") return initial;
  // absent — try to start the unit. Best-effort: the install/uninstall script
  // is the source of truth for the unit definition; we just nudge it active.
  try {
    execFileSync("systemctl", ["--user", "start", "citadel-tmux.service"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 5000,
    });
  } catch {
    // Fall through to re-probe; the caller decides what to do with absent.
  }
  // Poll for readiness. tmux can take ~200ms to bind its socket after the
  // process starts. Cap the wait so we don't hold up daemon boot indefinitely.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const current = getTmuxServerOwnership();
    if (current.kind !== "absent") return current;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return getTmuxServerOwnership();
}

export {
  captureTmux,
  captureTmuxAsync,
  captureTmuxSnapshot,
  captureTmuxVisibleScreen,
  captureTranscript,
  waitForPaneCommand,
  waitForTerminalIdle,
} from "./capture.js";
export type { TerminalTranscript, TerminalTranscriptError } from "./capture.js";

export function sendKeys(sessionName: string, data: string, socketName?: string | null) {
  for (const token of tokenizeTerminalInput(data)) {
    if (token.literal) {
      execFileSync("tmux", [...tmuxPrefix(socketName), "send-keys", "-l", "-t", sessionName, token.value]);
    } else {
      execFileSync("tmux", [...tmuxPrefix(socketName), "send-keys", "-t", sessionName, token.value]);
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
export function pasteText(
  sessionName: string,
  data: string,
  options: { bracketed?: boolean; socketName?: string | null } = {},
) {
  const bufferName = `citadel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  execFileSync("tmux", [...tmuxPrefix(options.socketName), "load-buffer", "-b", bufferName, "-"], { input: data });
  const args = options.bracketed
    ? ["paste-buffer", "-p", "-d", "-b", bufferName, "-t", sessionName]
    : ["paste-buffer", "-d", "-b", bufferName, "-t", sessionName];
  execFileSync("tmux", [...tmuxPrefix(options.socketName), ...args]);
}

export function resizePane(sessionName: string, cols: number, rows: number, socketName?: string | null) {
  const safeCols = Math.min(400, Math.max(20, Math.trunc(cols)));
  const safeRows = Math.min(120, Math.max(5, Math.trunc(rows)));
  execFileSync("tmux", [
    ...tmuxPrefix(socketName),
    "resize-pane",
    "-t",
    sessionName,
    "-x",
    String(safeCols),
    "-y",
    String(safeRows),
  ]);
}

export function killTmuxSession(sessionName: string, socketName?: string | null) {
  try {
    if (tmuxSessionExists(sessionName, socketName)) {
      execFileSync("tmux", [...tmuxPrefix(socketName), "kill-session", "-t", sessionName]);
    }
  } catch {
    // The server/session can disappear between has-session and kill-session.
    // Cleanup callers should still remove sentinels and continue.
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
