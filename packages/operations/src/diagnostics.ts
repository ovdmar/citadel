// Lightweight structured event log for citadel's tmux/ttyd/lifecycle paths.
//
// Always on. Writes one JSON line per event to `<dataDir>/diagnostics.jsonl`
// and keeps the last MAX_RING_EVENTS in memory so the cockpit can render a
// quick "recent activity" tail without re-reading the file. When the file
// grows past MAX_FILE_BYTES it's rotated to `diagnostics.jsonl.1` (one
// generation kept; total disk footprint capped at ~2 × MAX_FILE_BYTES).
//
// The logger is intentionally a small, dependency-light primitive — every
// session-killing path in the daemon takes it via deps so the lifecycle
// trail is captured at the source, not derived after the fact. When a user
// hits "Download diagnostics bundle" in Settings → Debug, the daemon
// returns these JSONL files alongside a state snapshot for the recipient
// to triage.
//
// Categories (free-form `category` string, but these are the canonical
// ones every consumer should use):
//   - daemon     : boot/shutdown lifecycle, environment, version
//   - tmux       : has-session/list-sessions/list-panes calls (including
//                  failures), kill, create
//   - ttyd       : spawn/exit/adopt/release/reap, port reservation
//   - monitor    : status-monitor tick decisions (flips, deletions,
//                  debounce state, missing-tick counter)
//   - restore    : boot-restore reconcile flips, candidate count, results
//   - reaper     : orphan-reaper actions (what was killed and why)
//   - proxy      : terminal-routes ws upgrade, revive race, proxy errors
//
// Failure mode: if the underlying fs.appendFileSync throws (disk full,
// EACCES, etc.) we log the failure once to console and silently drop
// subsequent events to that file. The in-memory ring still keeps a record
// the cockpit can show.

import fs from "node:fs";
import path from "node:path";

const MAX_RING_EVENTS = 1_000;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

export type DiagnosticEvent = {
  ts: string; // ISO timestamp
  category: string; // e.g. "tmux", "ttyd"
  event: string; // free-form short name e.g. "has-session.failed"
  data?: Record<string, unknown>;
};

export interface DiagnosticsLogger {
  log(category: string, event: string, data?: Record<string, unknown>): void;
  /** Snapshot of the last N events from the in-memory ring (oldest → newest). */
  recent(limit?: number): DiagnosticEvent[];
  /** Absolute path to the active JSONL file. Returns null if file logging
   * is disabled (no dataDir was supplied). */
  filePath(): string | null;
  /** Absolute path to the rotated-older JSONL file (the .1). May not exist. */
  rotatedPath(): string | null;
}

export type DiagnosticsLoggerOptions = {
  /** Directory under which `diagnostics.jsonl` (+ `.1` rotation) live.
   * When omitted, the logger keeps only the in-memory ring — useful for
   * tests that don't want fs side-effects. */
  dataDir?: string;
  /** Override the on-disk filename. Defaults to "diagnostics.jsonl". */
  fileName?: string;
  /** Override the rotation threshold. Tests pass small values; production
   * uses MAX_FILE_BYTES. */
  maxFileBytes?: number;
  /** Override the in-memory ring capacity. */
  maxRingEvents?: number;
};

export function createDiagnosticsLogger(opts: DiagnosticsLoggerOptions = {}): DiagnosticsLogger {
  const ring: DiagnosticEvent[] = [];
  const maxRing = opts.maxRingEvents ?? MAX_RING_EVENTS;
  const maxBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;
  const fileName = opts.fileName ?? "diagnostics.jsonl";
  const file = opts.dataDir ? path.join(opts.dataDir, fileName) : null;
  const rotated = file ? `${file}.1` : null;
  let writeErrored = false;

  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      // Best-effort — if we can't create the dir, fall back to ring-only.
      writeErrored = true;
    }
  }

  function rotateIfNeeded(): void {
    if (!file || writeErrored) return;
    try {
      const stat = fs.statSync(file);
      if (stat.size < maxBytes) return;
    } catch {
      // File doesn't exist yet → nothing to rotate.
      return;
    }
    try {
      if (rotated) {
        // Remove the older rotated file first so rename can succeed even on
        // filesystems that refuse rename-over-existing.
        try {
          fs.unlinkSync(rotated);
        } catch {
          /* nonexistent — fine */
        }
        if (file) fs.renameSync(file, rotated);
      }
    } catch (error) {
      // Rotation failed; degrade to "stop writing to the file" rather than
      // letting it grow unbounded.
      writeErrored = true;
      console.warn(`[diagnostics] rotation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function log(category: string, event: string, data?: Record<string, unknown>): void {
    const entry: DiagnosticEvent = {
      ts: new Date().toISOString(),
      category,
      event,
      ...(data ? { data } : {}),
    };
    ring.push(entry);
    if (ring.length > maxRing) ring.splice(0, ring.length - maxRing);
    if (!file || writeErrored) return;
    rotateIfNeeded();
    try {
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { encoding: "utf8" });
    } catch (error) {
      writeErrored = true;
      console.warn(`[diagnostics] file write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    log,
    recent(limit?: number) {
      if (limit === undefined) return [...ring];
      if (limit <= 0) return [];
      return ring.slice(-limit);
    },
    filePath: () => file,
    rotatedPath: () => rotated,
  };
}

/** No-op logger for tests / callers that don't want diagnostics. Identical
 * surface to the real one — `recent()` returns []. */
export const noopDiagnosticsLogger: DiagnosticsLogger = {
  log() {},
  recent: () => [],
  filePath: () => null,
  rotatedPath: () => null,
};
