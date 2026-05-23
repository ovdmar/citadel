import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SCRATCHPAD_MAX_BYTES,
  ScratchpadTooLargeError,
  appendScratchpad,
  readScratchpad,
  scratchpadPath,
  writeScratchpad,
} from "./scratchpad.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scratchpad-"));
  dirs.push(dir);
  return dir;
}

describe("scratchpad storage", () => {
  it("creates the data dir and seeds a stub on first read", () => {
    const parent = tmpDir();
    const nested = path.join(parent, "nested", "data");
    const snapshot = readScratchpad(nested);
    expect(fs.existsSync(scratchpadPath(nested))).toBe(true);
    expect(snapshot.content).toContain("Scratchpad");
    expect(snapshot.updatedAt).toMatch(/T.*Z$/);
  });

  it("round-trips writes and reports mtime", () => {
    const dir = tmpDir();
    const first = writeScratchpad(dir, "hello world");
    expect(first.content).toBe("hello world");
    // Force mtime backward so we can assert the next write strictly advances it
    // without depending on filesystem clock granularity (some filesystems have
    // 1-second mtime resolution, which would make a sleep-based test flaky).
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(scratchpadPath(dir), earlier, earlier);
    const second = writeScratchpad(dir, "second pass");
    expect(second.content).toBe("second pass");
    expect(readScratchpad(dir).content).toBe("second pass");
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(earlier.getTime());
  });

  it("appends with a clean newline boundary", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "first line");
    const after = appendScratchpad(dir, "second line");
    expect(after.content).toBe("first line\n\nsecond line\n");
    const again = appendScratchpad(dir, "third line");
    expect(again.content).toBe("first line\n\nsecond line\n\nthird line\n");
  });

  it("appends to an empty file without leading separator", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scratchpadPath(dir), "");
    const result = appendScratchpad(dir, "note");
    expect(result.content).toBe("note\n");
  });

  it("rejects writes that exceed the size cap with a typed error", () => {
    const dir = tmpDir();
    const tooLarge = "x".repeat(SCRATCHPAD_MAX_BYTES + 1);
    expect(() => writeScratchpad(dir, tooLarge)).toThrow(ScratchpadTooLargeError);
  });

  it("rejects appends that would push past the cap with a typed error", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "x".repeat(SCRATCHPAD_MAX_BYTES - 10));
    expect(() => appendScratchpad(dir, "y".repeat(100))).toThrow(ScratchpadTooLargeError);
  });
});
