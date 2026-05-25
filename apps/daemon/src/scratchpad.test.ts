import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillIfEmpty,
  findHistoryEntry,
  historyPath,
  listHistorySummaries,
  readHistory,
} from "./scratchpad-history.js";
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
    const first = writeScratchpad(dir, "hello world", "ui");
    expect(first.content).toBe("hello world");
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(scratchpadPath(dir), earlier, earlier);
    const second = writeScratchpad(dir, "second pass", "ui");
    expect(second.content).toBe("second pass");
    expect(readScratchpad(dir).content).toBe("second pass");
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(earlier.getTime());
  });

  it("appends with a clean newline boundary", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "first line", "ui");
    const after = appendScratchpad(dir, "second line", "mcp:append_scratchpad");
    expect(after.content).toBe("first line\n\nsecond line\n");
    const again = appendScratchpad(dir, "third line", "mcp:append_scratchpad");
    expect(again.content).toBe("first line\n\nsecond line\n\nthird line\n");
  });

  it("appends to an empty file without leading separator", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scratchpadPath(dir), "");
    const result = appendScratchpad(dir, "note", "mcp:append_scratchpad");
    expect(result.content).toBe("note\n");
  });

  it("rejects writes that exceed the size cap with a typed error", () => {
    const dir = tmpDir();
    const tooLarge = "x".repeat(SCRATCHPAD_MAX_BYTES + 1);
    expect(() => writeScratchpad(dir, tooLarge, "ui")).toThrow(ScratchpadTooLargeError);
  });

  it("rejects appends that would push past the cap with a typed error", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "x".repeat(SCRATCHPAD_MAX_BYTES - 10), "ui");
    expect(() => appendScratchpad(dir, "y".repeat(100), "mcp:append_scratchpad")).toThrow(ScratchpadTooLargeError);
  });
});

describe("scratchpad history", () => {
  it("creates one entry per single write", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "alpha", "ui");
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ source: "ui", content: "alpha", coalescedCount: 1 });
    expect(entries[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entries[0]?.byteLength).toBe(5);
    expect(entries[0]?.id).toMatch(/^scratch_/);
  });

  it("coalesces same-source writes inside the 1-minute window", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T12:00:00.000Z");
    const t1 = new Date("2026-05-25T12:00:30.000Z");
    writeScratchpad(dir, "alpha", "ui", { now: () => t0 });
    writeScratchpad(dir, "alpha-2", "ui", { now: () => t1 });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      content: "alpha-2",
      coalescedCount: 2,
      firstWriteTs: t0.toISOString(),
      ts: t1.toISOString(),
    });
  });

  it("splits entries when same-source writes cross the coalesce window", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T12:00:00.000Z");
    const t1 = new Date("2026-05-25T12:01:30.000Z");
    writeScratchpad(dir, "alpha", "ui", { now: () => t0 });
    writeScratchpad(dir, "beta", "ui", { now: () => t1 });
    expect(readHistory(dir)).toHaveLength(2);
  });

  it("splits entries when source switches within the window", () => {
    const dir = tmpDir();
    const t = new Date("2026-05-25T12:00:00.000Z");
    writeScratchpad(dir, "alpha", "ui", { now: () => t });
    writeScratchpad(dir, "alpha-mcp", "mcp:write_scratchpad", { now: () => t });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.source)).toEqual(["ui", "mcp:write_scratchpad"]);
  });

  it("does not record when content is unchanged", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "alpha", "ui");
    writeScratchpad(dir, "alpha", "ui");
    expect(readHistory(dir)).toHaveLength(1);
  });

  it("retains the newest N entries by count", () => {
    const dir = tmpDir();
    for (let i = 0; i < 101; i += 1) {
      const ts = new Date(2026, 4, 25, 12, 0, i, 0);
      writeScratchpad(dir, `body-${i}`, `src-${i}`, { now: () => ts });
    }
    const entries = readHistory(dir);
    expect(entries).toHaveLength(100);
    expect(entries[0]?.content).toBe("body-1");
    expect(entries[entries.length - 1]?.content).toBe("body-100");
  });

  it("retains by byte budget", () => {
    const dir = tmpDir();
    const now = (i: number) => new Date(2026, 4, 25, 12, 0, i, 0);
    writeScratchpad(dir, "x".repeat(2000), "src-a", { maxBytes: 1500, now: () => now(0) });
    writeScratchpad(dir, "y".repeat(2000), "src-b", { maxBytes: 1500, now: () => now(1) });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("src-b");
  });

  it("summary excludes content and adds preview", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "Z".repeat(500), "ui");
    const [summary] = listHistorySummaries(dir);
    expect(summary).toBeDefined();
    expect((summary as unknown as { content?: string }).content).toBeUndefined();
    expect(summary?.preview).toHaveLength(200);
  });

  it("findHistoryEntry returns full content or null", () => {
    const dir = tmpDir();
    writeScratchpad(dir, "alpha", "ui");
    const entries = readHistory(dir);
    const id = entries[0]?.id;
    if (!id) throw new Error("expected an entry id");
    expect(findHistoryEntry(dir, id)?.content).toBe("alpha");
    expect(findHistoryEntry(dir, "missing")).toBeNull();
  });

  it("backfillIfEmpty seeds one entry only when history is missing", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scratchpadPath(dir), "pre-existing");
    const first = backfillIfEmpty(dir, { content: "pre-existing", updatedAt: new Date().toISOString() });
    expect(first?.source).toBe("backfill");
    expect(fs.existsSync(historyPath(dir))).toBe(true);
    const again = backfillIfEmpty(dir, { content: "pre-existing", updatedAt: new Date().toISOString() });
    expect(again).toBeNull();
    expect(readHistory(dir)).toHaveLength(1);
  });

  it("backfillIfEmpty no-op on empty content", () => {
    const dir = tmpDir();
    expect(backfillIfEmpty(dir, { content: "", updatedAt: new Date().toISOString() })).toBeNull();
    expect(fs.existsSync(historyPath(dir))).toBe(false);
  });
});
