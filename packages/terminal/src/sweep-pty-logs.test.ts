import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPtyLogs } from "./index.js";

// Production sweepPtyLogs defaults to the module-level PIPE_PANE_LOG_DIR
// (`${os.tmpdir()}/citadel-pty`). Tests use a private directory so real tmux
// pipe logs or parallel test workers cannot race the missing-directory case.
let sweepDir = "";
let prefix = "";

beforeEach(() => {
  sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pty-sweep-"));
  prefix = `sweep-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;
});

afterEach(() => {
  fs.rmSync(sweepDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  sweepDir = "";
});

function makeLog(name: string, mtimeMs: number): string {
  const filePath = path.join(sweepDir, `${prefix}${name}`);
  fs.writeFileSync(filePath, "log content\n");
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
  return filePath;
}

describe("sweepPtyLogs", () => {
  it("removes files older than maxAge and keeps fresh ones", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const fresh = makeLog("fresh.log", now - day);
    const stale = makeLog("stale.log", now - 8 * day);
    const ancient = makeLog("ancient.log", now - 30 * day);

    const result = sweepPtyLogs(7 * day, sweepDir);

    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(ancient)).toBe(false);
    expect(result).toEqual({ scanned: 3, removed: 2 });
  });

  it("returns zero counts when the directory does not exist", () => {
    const missingDir = path.join(os.tmpdir(), `citadel-pty-missing-${Date.now()}`);
    fs.rmSync(missingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    const result = sweepPtyLogs(1000, missingDir);

    expect(result).toEqual({ scanned: 0, removed: 0 });
  });

  it("keeps a file whose mtime is exactly equal to the cutoff", () => {
    const day = 24 * 60 * 60 * 1000;
    // Boundary: mtime older than (now - maxAge) is removed; equal or newer kept.
    const boundaryAge = day;
    const file = makeLog("boundary.log", Date.now() - boundaryAge + 5_000);

    sweepPtyLogs(boundaryAge, sweepDir);

    expect(fs.existsSync(file)).toBe(true);
  });
});
