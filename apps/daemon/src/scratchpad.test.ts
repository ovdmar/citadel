import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBlocks } from "./scratchpad-blocks.js";
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
  addBlock,
  appendScratchpad,
  backfillScratchpadOnStartup,
  deleteBlock,
  listBlocks,
  readScratchpad,
  scratchpadPath,
  updateBlock,
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

// Convenience to keep test bodies short after the API moved from `dir` to
// `{ notesPath, dataDir }`. The default notes filename matches the legacy
// hardcoded path so pre-existing assertions continue to hold.
function paths(dir: string, notesPathOverride?: string) {
  return { notesPath: notesPathOverride ?? path.join(dir, "scratchpad.md"), dataDir: dir };
}

describe("scratchpad storage", () => {
  it("creates the data dir and seeds a stub on first read", () => {
    const parent = tmpDir();
    const nested = path.join(parent, "nested", "data");
    const snapshot = readScratchpad(paths(nested));
    expect(fs.existsSync(path.join(nested, "scratchpad.md"))).toBe(true);
    expect(snapshot.content).toContain("Scratchpad");
    expect(snapshot.updatedAt).toMatch(/T.*Z$/);
  });

  it("round-trips writes and reports mtime; legacy content migrates on next read", () => {
    const dir = tmpDir();
    const first = writeScratchpad(paths(dir), "hello world", "ui");
    expect(first.content).toBe("hello world");
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, "scratchpad.md"), earlier, earlier);
    const second = writeScratchpad(paths(dir), "second pass", "ui");
    expect(second.content).toBe("second pass");
    // readScratchpad migrates the legacy (no-fence) content into a fenced block.
    const blocks = parseBlocks(readScratchpad(paths(dir)).content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["second pass"]);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(earlier.getTime());
  });

  it("appendScratchpad creates a new fenced block per call, never merging", () => {
    const dir = tmpDir();
    appendScratchpad(paths(dir), "first line", "mcp:append_scratchpad");
    const after = appendScratchpad(paths(dir), "second line", "mcp:append_scratchpad");
    const blocks = parseBlocks(after.content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["first line", "second line"]);
    const after3 = appendScratchpad(paths(dir), "third line", "mcp:append_scratchpad");
    const blocks3 = parseBlocks(after3.content).blocks;
    expect(blocks3.map((b) => b.text)).toEqual(["first line", "second line", "third line"]);
  });

  it("appendScratchpad to an empty file produces one fenced block whose inner text matches", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratchpad.md"), "");
    const result = appendScratchpad(paths(dir), "note", "mcp:append_scratchpad");
    const blocks = parseBlocks(result.content).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("note");
    expect(result.content).toMatch(/^<!-- block:/);
  });

  it("rejects writes that exceed the size cap with a typed error", () => {
    const dir = tmpDir();
    const tooLarge = "x".repeat(SCRATCHPAD_MAX_BYTES + 1);
    expect(() => writeScratchpad(paths(dir), tooLarge, "ui")).toThrow(ScratchpadTooLargeError);
  });

  it("rejects appends that would push past the cap with a typed error", () => {
    const dir = tmpDir();
    writeScratchpad(paths(dir), "x".repeat(SCRATCHPAD_MAX_BYTES - 10), "ui");
    expect(() => appendScratchpad(paths(dir), "y".repeat(100), "mcp:append_scratchpad")).toThrow(
      ScratchpadTooLargeError,
    );
  });
});

describe("scratchpad history", () => {
  it("creates one entry per single write", () => {
    const dir = tmpDir();
    writeScratchpad(paths(dir), "alpha", "ui");
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
    writeScratchpad(paths(dir), "alpha", "ui", { now: () => t0 });
    writeScratchpad(paths(dir), "alpha-2", "ui", { now: () => t1 });
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
    writeScratchpad(paths(dir), "alpha", "ui", { now: () => t0 });
    writeScratchpad(paths(dir), "beta", "ui", { now: () => t1 });
    expect(readHistory(dir)).toHaveLength(2);
  });

  it("splits entries when source switches within the window", () => {
    const dir = tmpDir();
    const t = new Date("2026-05-25T12:00:00.000Z");
    writeScratchpad(paths(dir), "alpha", "ui", { now: () => t });
    writeScratchpad(paths(dir), "alpha-mcp", "mcp:write_scratchpad", { now: () => t });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.source)).toEqual(["ui", "mcp:write_scratchpad"]);
  });

  it("does not record when content is unchanged", () => {
    const dir = tmpDir();
    writeScratchpad(paths(dir), "alpha", "ui");
    writeScratchpad(paths(dir), "alpha", "ui");
    expect(readHistory(dir)).toHaveLength(1);
  });

  it("retains the newest N entries by count", () => {
    const dir = tmpDir();
    for (let i = 0; i < 101; i += 1) {
      const ts = new Date(2026, 4, 25, 12, 0, i, 0);
      writeScratchpad(paths(dir), `body-${i}`, `restore:src-${i}`, { now: () => ts });
    }
    const entries = readHistory(dir);
    expect(entries).toHaveLength(100);
    expect(entries[0]?.content).toBe("body-1");
    expect(entries[entries.length - 1]?.content).toBe("body-100");
  });

  it("retains by byte budget", () => {
    const dir = tmpDir();
    const now = (i: number) => new Date(2026, 4, 25, 12, 0, i, 0);
    writeScratchpad(paths(dir), "x".repeat(2000), "restore:a", { maxBytes: 1500, now: () => now(0) });
    writeScratchpad(paths(dir), "y".repeat(2000), "restore:b", { maxBytes: 1500, now: () => now(1) });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("restore:b");
  });

  it("summary excludes content and adds preview", () => {
    const dir = tmpDir();
    writeScratchpad(paths(dir), "Z".repeat(500), "ui");
    const [summary] = listHistorySummaries(dir);
    expect(summary).toBeDefined();
    expect((summary as unknown as { content?: string }).content).toBeUndefined();
    expect(summary?.preview).toHaveLength(200);
  });

  it("findHistoryEntry returns full content or null", () => {
    const dir = tmpDir();
    writeScratchpad(paths(dir), "alpha", "ui");
    const entries = readHistory(dir);
    const id = entries[0]?.id;
    if (!id) throw new Error("expected an entry id");
    expect(findHistoryEntry(dir, id)?.content).toBe("alpha");
    expect(findHistoryEntry(dir, "missing")).toBeNull();
  });

  it("backfillIfEmpty seeds one entry only when history is missing", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratchpad.md"), "pre-existing");
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

describe("scratchpad migration on read", () => {
  it("auto-migrates a legacy file and records exactly one migrate-to-blocks history entry", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratchpad.md"), "alpha\n\nbeta\n");
    const snap = readScratchpad(paths(dir));
    const parsed = parseBlocks(snap.content);
    expect(parsed.blocks.map((b) => b.text)).toEqual(["alpha", "beta"]);
    expect(parsed.needsRewrite).toBe(false);
    const entries = readHistory(dir);
    const migrationEntries = entries.filter((e) => e.source === "migrate-to-blocks");
    expect(migrationEntries).toHaveLength(1);
  });

  it("is idempotent — second read does not record another migrate-to-blocks entry", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratchpad.md"), "alpha\n\nbeta\n");
    readScratchpad(paths(dir));
    readScratchpad(paths(dir));
    const entries = readHistory(dir);
    const migrationEntries = entries.filter((e) => e.source === "migrate-to-blocks");
    expect(migrationEntries).toHaveLength(1);
  });

  it("does NOT migrate empty / stub files", () => {
    const dir = tmpDir();
    readScratchpad(paths(dir)); // seeds stub
    readScratchpad(paths(dir)); // second call
    const entries = readHistory(dir);
    expect(entries.filter((e) => e.source === "migrate-to-blocks")).toHaveLength(0);
  });
});

describe("writeScratchpad byte-faithfulness", () => {
  it("writes the exact bytes it is given (no internal normalization)", () => {
    const dir = tmpDir();
    const weird = "raw text with no fences\n\nand another paragraph\n";
    writeScratchpad(paths(dir), weird, "ui");
    const onDisk = fs.readFileSync(path.join(dir, "scratchpad.md"), "utf8");
    expect(onDisk).toBe(weird);
  });

  it("non-canonical fenced content survives writeScratchpad verbatim", () => {
    const dir = tmpDir();
    const noisy =
      "<!-- block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\nbody\n<!-- /block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\nTRAILING JUNK\n";
    writeScratchpad(paths(dir), noisy, "ui");
    const onDisk = fs.readFileSync(path.join(dir, "scratchpad.md"), "utf8");
    expect(onDisk).toBe(noisy);
  });
});

describe("block CRUD", () => {
  it("addBlock at end appends after existing blocks", () => {
    const dir = tmpDir();
    addBlock(paths(dir), "first", "end", "ui:add_block");
    const result = addBlock(paths(dir), "second", "end", "ui:add_block");
    if ("error" in result) throw new Error(result.error);
    const blocks = parseBlocks(result.snapshot.content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["first", "second"]);
  });

  it("addBlock with afterId inserts after the given block", () => {
    const dir = tmpDir();
    const a = addBlock(paths(dir), "a", "end", "ui:add_block");
    addBlock(paths(dir), "c", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    addBlock(paths(dir), "b", { afterId: a.block.id }, "ui:add_block");
    const blocks = listBlocks(paths(dir)).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["a", "b", "c"]);
  });

  it("addBlock with unknown afterId returns block_not_found", () => {
    const dir = tmpDir();
    addBlock(paths(dir), "real", "end", "ui:add_block");
    const result = addBlock(paths(dir), "x", { afterId: "missing-id" }, "ui:add_block");
    expect(result).toEqual({ error: "block_not_found" });
  });

  it("addBlock with empty/whitespace text returns text_required", () => {
    const dir = tmpDir();
    expect(addBlock(paths(dir), "", "end", "ui:add_block")).toEqual({ error: "text_required" });
    expect(addBlock(paths(dir), "  \n\t ", "end", "ui:add_block")).toEqual({ error: "text_required" });
  });

  it("updateBlock overwrites a block's text while preserving its UUID", () => {
    const dir = tmpDir();
    const a = addBlock(paths(dir), "before", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    const r = updateBlock(paths(dir), a.block.id, "after", "ui:edit_block");
    if ("error" in r) throw new Error(r.error);
    if (!("block" in r)) throw new Error("update with non-empty text must return a block");
    expect(r.block.id).toBe(a.block.id);
    expect(r.block.text).toBe("after");
  });

  it("updateBlock with empty text deletes the block", () => {
    const dir = tmpDir();
    const a = addBlock(paths(dir), "doomed", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    const r = updateBlock(paths(dir), a.block.id, "", "ui:delete_block");
    expect("error" in r).toBe(false);
    expect(listBlocks(paths(dir)).blocks).toHaveLength(0);
  });

  it("updateBlock with unknown id returns block_not_found", () => {
    const dir = tmpDir();
    expect(updateBlock(paths(dir), "missing", "text", "ui:edit_block")).toEqual({ error: "block_not_found" });
  });

  it("deleteBlock removes the block and preserves all other UUIDs", () => {
    const dir = tmpDir();
    const a = addBlock(paths(dir), "a", "end", "ui:add_block");
    const b = addBlock(paths(dir), "b", "end", "ui:add_block");
    const c = addBlock(paths(dir), "c", "end", "ui:add_block");
    if ("error" in a || "error" in b || "error" in c) throw new Error("seed failed");
    deleteBlock(paths(dir), b.block.id, "ui:delete_block");
    const ids = listBlocks(paths(dir)).blocks.map((x) => x.id);
    expect(ids).toEqual([a.block.id, c.block.id]);
  });

  it("deleteBlock with unknown id returns block_not_found", () => {
    const dir = tmpDir();
    expect(deleteBlock(paths(dir), "missing", "ui:delete_block")).toEqual({ error: "block_not_found" });
  });

  it("listBlocks returns blocks with createdAt/updatedAt derived from history", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T10:00:00Z");
    const t1 = new Date("2026-05-25T10:30:00Z");
    const a = addBlock(paths(dir), "v1", "end", "ui:add_block", { now: () => t0 });
    if ("error" in a) throw new Error(a.error);
    // Different source so the second write opens a fresh history entry rather than coalescing.
    updateBlock(paths(dir), a.block.id, "v2", "mcp:update_block", { now: () => t1 });
    const blocks = listBlocks(paths(dir)).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.createdAt).toBe(t0.toISOString());
    expect(blocks[0]?.updatedAt).toBe(t1.toISOString());
  });

  it("block CRUD writes inside the same coalesce window collapse into one history entry", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T10:00:00Z");
    const t30 = new Date("2026-05-25T10:00:30Z");
    addBlock(paths(dir), "first", "end", "ui:add_block", { now: () => t0 });
    addBlock(paths(dir), "second", "end", "ui:add_block", { now: () => t30 });
    const entries = readHistory(dir).filter((e) => e.source === "ui:add_block");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.coalescedCount).toBe(2);
  });
});

describe("configurable notes location", () => {
  it("writes to the configured notesPath, not <dataDir>/scratchpad.md, when both are set", () => {
    const dir = tmpDir();
    const customDir = tmpDir();
    const customNotes = path.join(customDir, "elsewhere", "my-notes.md");
    writeScratchpad({ notesPath: customNotes, dataDir: dir }, "hello custom", "ui");
    expect(fs.readFileSync(customNotes, "utf8")).toBe("hello custom");
    expect(fs.existsSync(path.join(dir, "scratchpad.md"))).toBe(false);
  });

  it("creates the notes file with DEFAULT_STUB on first read at a custom path", () => {
    const dir = tmpDir();
    const customNotes = path.join(tmpDir(), "first-read.md");
    expect(fs.existsSync(customNotes)).toBe(false);
    const snap = readScratchpad({ notesPath: customNotes, dataDir: dir });
    expect(fs.existsSync(customNotes)).toBe(true);
    expect(snap.content).toContain("Scratchpad");
  });

  it("creates the notes parent directory if missing", () => {
    const dir = tmpDir();
    const customNotes = path.join(tmpDir(), "deeply", "nested", "tree", "notes.md");
    readScratchpad({ notesPath: customNotes, dataDir: dir });
    expect(fs.existsSync(path.dirname(customNotes))).toBe(true);
    expect(fs.existsSync(customNotes)).toBe(true);
  });

  it("writes history to <dataDir>/scratchpad-history.jsonl even when notes live elsewhere; no stray history beside notes", () => {
    const dir = tmpDir();
    const customDir = tmpDir();
    const customNotes = path.join(customDir, "synced", "notes.md");
    writeScratchpad({ notesPath: customNotes, dataDir: dir }, "content", "ui");
    expect(fs.existsSync(path.join(dir, "scratchpad-history.jsonl"))).toBe(true);
    // Negative assertion — daemon internal state must NOT leak into the user's
    // notes-folder (which may be a sync target like ~/Documents).
    expect(fs.existsSync(path.join(path.dirname(customNotes), "scratchpad-history.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(customDir, "scratchpad-history.jsonl"))).toBe(false);
  });

  it("leaves an already-fenced file alone — zero migrate-to-blocks history entries", () => {
    const dir = tmpDir();
    const customNotes = path.join(tmpDir(), "fenced.md");
    const fenced =
      "<!-- block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\nbody\n<!-- /block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\n";
    fs.mkdirSync(path.dirname(customNotes), { recursive: true });
    fs.writeFileSync(customNotes, fenced);
    readScratchpad({ notesPath: customNotes, dataDir: dir });
    const migrationEntries = readHistory(dir).filter((e) => e.source === "migrate-to-blocks");
    expect(migrationEntries).toHaveLength(0);
  });

  it("logs a console.warn naming the path when migrating a pre-existing non-fenced file at a custom path", () => {
    const dir = tmpDir();
    const customNotes = path.join(tmpDir(), "legacy.md");
    fs.mkdirSync(path.dirname(customNotes), { recursive: true });
    fs.writeFileSync(customNotes, "alpha\n\nbeta\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      readScratchpad({ notesPath: customNotes, dataDir: dir });
      const called = warnSpy.mock.calls.flat().join(" ");
      expect(called).toContain(customNotes);
      expect(called).toMatch(/migrat/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT log a console.warn when migrating the default <dataDir>/scratchpad.md (Citadel-owned)", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "scratchpad.md"), "alpha\n\nbeta\n");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      readScratchpad(paths(dir));
      const called = warnSpy.mock.calls.flat().join(" ");
      expect(called).not.toMatch(/migrat/i);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("backfillScratchpadOnStartup uses effectiveNotesPath, not the legacy dataDir-based path", () => {
    const dir = tmpDir();
    const customDir = tmpDir();
    const customNotes = path.join(customDir, "custom.md");
    fs.writeFileSync(customNotes, "pre-existing content");
    backfillScratchpadOnStartup({ dataDir: dir, scratchpad: { path: customNotes } });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("backfill");
    expect(entries[0]?.content).toBe("pre-existing content");
  });

  it("backfillScratchpadOnStartup is a no-op when notes file is missing", () => {
    const dir = tmpDir();
    const customDir = tmpDir();
    backfillScratchpadOnStartup({ dataDir: dir, scratchpad: { path: path.join(customDir, "missing.md") } });
    expect(fs.existsSync(historyPath(dir))).toBe(false);
  });

  it("backfillScratchpadOnStartup is a no-op when notes file is empty", () => {
    const dir = tmpDir();
    const customDir = tmpDir();
    const customNotes = path.join(customDir, "empty.md");
    fs.writeFileSync(customNotes, "");
    backfillScratchpadOnStartup({ dataDir: dir, scratchpad: { path: customNotes } });
    expect(fs.existsSync(historyPath(dir))).toBe(false);
  });
});
