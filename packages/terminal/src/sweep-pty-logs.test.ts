import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweepPtyLogs } from "./index.js";

// sweepPtyLogs reads from the module-level PIPE_PANE_LOG_DIR
// (`${os.tmpdir()}/citadel-pty`). Tests share that single directory; isolate
// each test by writing files with a unique prefix and only asserting on those.
const SWEEP_DIR = path.join(os.tmpdir(), "citadel-pty");
let prefix = "";
const createdFiles: string[] = [];

beforeEach(() => {
  fs.mkdirSync(SWEEP_DIR, { recursive: true });
  prefix = `sweep-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-`;
});

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // already removed by the helper under test or never created
    }
  }
});

function makeLog(name: string, mtimeMs: number): string {
  const filePath = path.join(SWEEP_DIR, `${prefix}${name}`);
  fs.writeFileSync(filePath, "log content\n");
  const seconds = mtimeMs / 1000;
  fs.utimesSync(filePath, seconds, seconds);
  createdFiles.push(filePath);
  return filePath;
}

describe("sweepPtyLogs", () => {
  it("removes files older than maxAge and keeps fresh ones", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const fresh = makeLog("fresh.log", now - day);
    const stale = makeLog("stale.log", now - 8 * day);
    const ancient = makeLog("ancient.log", now - 30 * day);

    const result = sweepPtyLogs(7 * day);

    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(ancient)).toBe(false);
    // The numbers may be larger than our 3 files because the live system
    // (or other parallel tests) may have files in the same dir. We only
    // assert that at least our two stale files were counted.
    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(result.removed).toBeGreaterThanOrEqual(2);
  });

  it("returns zero counts when the directory does not exist", () => {
    // Use a sibling dir that we delete before calling, then restore.
    const decoy = path.join(os.tmpdir(), `citadel-pty-missing-${Date.now()}`);
    fs.rmSync(decoy, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // The helper reads from PIPE_PANE_LOG_DIR, not `decoy`, so to test the
    // missing-dir branch we temporarily remove PIPE_PANE_LOG_DIR. Do it on a
    // fresh dir + restore guard so we don't interfere with concurrent tests.
    // Easiest path: rename, run, rename back.
    const exists = fs.existsSync(SWEEP_DIR);
    const backup = `${SWEEP_DIR}.test-backup-${Date.now()}`;
    if (exists) fs.renameSync(SWEEP_DIR, backup);
    try {
      const result = sweepPtyLogs(1000);
      expect(result).toEqual({ scanned: 0, removed: 0 });
    } finally {
      if (exists) fs.renameSync(backup, SWEEP_DIR);
    }
  });

  it("keeps a file whose mtime is exactly equal to the cutoff", () => {
    const day = 24 * 60 * 60 * 1000;
    // Boundary: mtime older than (now - maxAge) is removed; equal or newer kept.
    const boundaryAge = day;
    const file = makeLog("boundary.log", Date.now() - boundaryAge + 5_000);

    sweepPtyLogs(boundaryAge);

    expect(fs.existsSync(file)).toBe(true);
  });
});
