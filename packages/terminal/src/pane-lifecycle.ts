import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote, tmuxPrefix, waitForPaneCommand, waitForTerminalIdle } from "./index.js";

// Shell-first pane lifecycle helpers. The tmux pane PID is `bash -l`; the
// agent runs as a child of the shell. Killing the agent (Ctrl+C, /quit,
// crash) returns control to bash without ending the pane. There is no
// wrapper script, no /tmp sentinel files, no exec-to-shell post-exit trick.

// Linux's `comm` field (which tmux exposes as #{pane_current_command}) is
// truncated at 15 characters. Compare against the truncated form so long
// runtime binary names still match.
export const COMM_TRUNCATION = 15;

// Env tokens preserved byte-for-byte from the legacy wrapper at
// packages/terminal/src/index.ts:131. Dropping any one of these produces a
// visible TUI rendering regression in claude/codex (verified against the
// wrapper before the shell-first refactor).
const COLOR_ENV_PREFIX = "env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1";

export type PanePidProcess = { command: string; pid: number };

/**
 * Read the foreground process info for a tmux pane via a single
 * `tmux display-message -p '#{pane_current_command} #{pane_pid}'`. Returns
 * null if the session is missing (`has-session` failure equivalent — any
 * tmux IO error). The caller is responsible for treating null as the
 * tmux-missing signal (which maps to `status: 'unknown'`, NEVER `stopped`).
 */
export function panePidProcess(sessionName: string): PanePidProcess | null {
  try {
    const raw = execFileSync(
      "tmux",
      [...tmuxPrefix(), "display-message", "-p", "-t", sessionName, "#{pane_current_command} #{pane_pid}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!raw) return null;
    const space = raw.indexOf(" ");
    if (space < 0) return null;
    const command = raw.slice(0, space).trim();
    const pidStr = raw.slice(space + 1).trim();
    const pid = Number.parseInt(pidStr, 10);
    if (!command || !Number.isFinite(pid) || pid <= 0) return null;
    return { command, pid };
  } catch {
    return null;
  }
}

/**
 * Launch the agent inside an already-created shell-first tmux pane. Composes
 * the send-keys string as
 *   `env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor FORCE_COLOR=1 CLICOLOR_FORCE=1 <quoted-argv>`
 * (single env invocation, byte-for-byte matching the legacy wrapper), waits
 * for the shell to settle (~200ms), dispatches via send-keys, then waits
 * for the agent's foreground command to match the runtime binary.
 *
 * The predicate is POSITIVE (matches runtime binary, NOT "anything not a
 * shell") so transient subprocesses (claude shelling out to git/rg, slow
 * bash rc files starting direnv, etc.) don't satisfy the wait early.
 */
export async function launchAgentInSession(
  sessionName: string,
  runtimeBinary: string,
  argv: string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  if (!runtimeBinary) throw new Error("launchAgentInSession requires a runtimeBinary");
  await waitForTerminalIdle(sessionName, { timeoutMs: 1500, idleMs: 200 });
  const cmd = [COLOR_ENV_PREFIX, shellQuote(runtimeBinary), ...argv.map(shellQuote)].join(" ");
  execFileSync("tmux", [...tmuxPrefix(), "send-keys", "-t", sessionName, cmd, "Enter"], { stdio: "ignore" });
  // Positive predicate against the comm-truncated runtime binary.
  const target = runtimeBinary.slice(0, COMM_TRUNCATION);
  await waitForPaneCommand(sessionName, (cur) => cur === target, { timeoutMs: options.timeoutMs ?? 5000 });
}

// One-time sweep of leftover /tmp/citadel-agent-*.{live,exit} files from the
// pre-shell-first wrapper era. Bounded by age (default 1 hour — protects a
// concurrent old daemon's active wrappers during install rollovers), by a
// marker file (subsequent boots no-op), and by a hard count safeguard
// (refuse to unlink > 50_000 files in one sweep — log and bail).
//
// Returns counts + a `skipped` reason when the operation was a no-op.
export const DEFAULT_SENTINEL_MAX_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_SENTINEL_MARKER_PATH = path.join(os.tmpdir(), ".citadel-sentinel-swept-v1");
export const DEFAULT_SENTINEL_SAFEGUARD = 50_000;

export type SweepLegacySentinelsResult = {
  scanned: number;
  removed: number;
  skipped: "marker" | "safeguard" | null;
};

export function sweepLegacyAgentSentinels(
  options: { maxAgeMs?: number; markerPath?: string; safeguardCount?: number; tmpDir?: string } = {},
): SweepLegacySentinelsResult {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SENTINEL_MAX_AGE_MS;
  const markerPath = options.markerPath ?? DEFAULT_SENTINEL_MARKER_PATH;
  const safeguard = options.safeguardCount ?? DEFAULT_SENTINEL_SAFEGUARD;
  const tmpDir = options.tmpDir ?? os.tmpdir();

  if (fs.existsSync(markerPath)) return { scanned: 0, removed: 0, skipped: "marker" };

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(tmpDir).filter((name) => /^citadel-agent-.*\.(live|exit)$/.test(name));
  } catch {
    return { scanned: 0, removed: 0, skipped: null };
  }
  if (entries.length > safeguard) {
    return { scanned: entries.length, removed: 0, skipped: "safeguard" };
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const name of entries) {
    const filePath = path.join(tmpDir, name);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      removed += 1;
    } catch {
      // ignore — file vanished mid-sweep, or we lack permission
    }
  }
  try {
    fs.writeFileSync(markerPath, new Date().toISOString());
  } catch {
    // best-effort: next boot will sweep again (idempotent), worst case is one
    // extra scan
  }
  return { scanned: entries.length, removed, skipped: null };
}
