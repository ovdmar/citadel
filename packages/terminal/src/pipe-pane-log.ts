import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote, tmuxPrefix } from "./index.js";

// Side-channel byte log of everything a pane emits. Lives under tmpdir so it
// gets cleaned up on reboot. `pipe-pane -o` toggles: passing the command once
// opens the pipe, calling again with no command closes it. We don't bother
// closing on session teardown — when the tmux session goes away tmux severs
// the pipe automatically.
export const PIPE_PANE_LOG_DIR = path.join(os.tmpdir(), "citadel-pty");

export function pipePaneLogPath(sessionName: string): string {
  return path.join(PIPE_PANE_LOG_DIR, `${sessionName}.log`);
}

// Periodic retention sweep for the pipe-pane log directory. tmux pipe-pane
// streams every byte a pane emits to disk and never rotates; without this
// the directory grows without bound (we observed >9000 files in production).
// Called from the daemon's terminal reaper on an hourly cadence.
//
// Returns { scanned, removed }. A missing directory is treated as no-op
// (zeros). Per-file errors (ENOENT race against another sweep, EPERM on a
// foreign file in $TMPDIR) are swallowed; we still count the scan attempt.
export function sweepPtyLogs(maxAgeMs: number, dir = PIPE_PANE_LOG_DIR): { scanned: number; removed: number } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { scanned: 0, removed: 0 };
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    const filePath = path.join(dir, entry);
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
  return { scanned: entries.length, removed };
}

export function attachPipePaneLog(sessionName: string): void {
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
