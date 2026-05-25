import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("scratchpad storage", () => {
  it("creates the data dir and seeds a stub on first read", () => {
    const parent = tmpDir();
    const nested = path.join(parent, "nested", "data");
    const snapshot = readScratchpad(nested);
    expect(fs.existsSync(scratchpadPath(nested))).toBe(true);
    expect(snapshot.content).toContain("Scratchpad");
    expect(snapshot.updatedAt).toMatch(/T.*Z$/);
  });

  it("round-trips writes and reports mtime; legacy content migrates on next read", () => {
    const dir = tmpDir();
    const first = writeScratchpad(dir, "hello world", "ui");
    expect(first.content).toBe("hello world");
    const earlier = new Date(Date.now() - 60_000);
    fs.utimesSync(scratchpadPath(dir), earlier, earlier);
    const second = writeScratchpad(dir, "second pass", "ui");
    expect(second.content).toBe("second pass");
    // readScratchpad migrates the legacy (no-fence) content into a fenced block.
    const blocks = parseBlocks(readScratchpad(dir).content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["second pass"]);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(earlier.getTime());
  });

  it("appendScratchpad creates a new fenced block per call, never merging", () => {
    const dir = tmpDir();
    appendScratchpad(dir, "first line", "mcp:append_scratchpad");
    const after = appendScratchpad(dir, "second line", "mcp:append_scratchpad");
    const blocks = parseBlocks(after.content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["first line", "second line"]);
    const after3 = appendScratchpad(dir, "third line", "mcp:append_scratchpad");
    const blocks3 = parseBlocks(after3.content).blocks;
    expect(blocks3.map((b) => b.text)).toEqual(["first line", "second line", "third line"]);
  });

  it("appendScratchpad to an empty file produces one fenced block whose inner text matches", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scratchpadPath(dir), "");
    const result = appendScratchpad(dir, "note", "mcp:append_scratchpad");
    const blocks = parseBlocks(result.content).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe("note");
    expect(result.content).toMatch(/^<!-- block:/);
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
      writeScratchpad(dir, `body-${i}`, `restore:src-${i}`, { now: () => ts });
    }
    const entries = readHistory(dir);
    expect(entries).toHaveLength(100);
    expect(entries[0]?.content).toBe("body-1");
    expect(entries[entries.length - 1]?.content).toBe("body-100");
  });

  it("retains by byte budget", () => {
    const dir = tmpDir();
    const now = (i: number) => new Date(2026, 4, 25, 12, 0, i, 0);
    writeScratchpad(dir, "x".repeat(2000), "restore:a", { maxBytes: 1500, now: () => now(0) });
    writeScratchpad(dir, "y".repeat(2000), "restore:b", { maxBytes: 1500, now: () => now(1) });
    const entries = readHistory(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("restore:b");
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

describe("scratchpad migration on read", () => {
  it("auto-migrates a legacy file and records exactly one migrate-to-blocks history entry", () => {
    const dir = tmpDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(scratchpadPath(dir), "alpha\n\nbeta\n");
    const snap = readScratchpad(dir);
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
    fs.writeFileSync(scratchpadPath(dir), "alpha\n\nbeta\n");
    readScratchpad(dir);
    readScratchpad(dir);
    const entries = readHistory(dir);
    const migrationEntries = entries.filter((e) => e.source === "migrate-to-blocks");
    expect(migrationEntries).toHaveLength(1);
  });

  it("does NOT migrate empty / stub files", () => {
    const dir = tmpDir();
    readScratchpad(dir); // seeds stub
    readScratchpad(dir); // second call
    const entries = readHistory(dir);
    expect(entries.filter((e) => e.source === "migrate-to-blocks")).toHaveLength(0);
  });
});

describe("writeScratchpad byte-faithfulness", () => {
  it("writes the exact bytes it is given (no internal normalization)", () => {
    const dir = tmpDir();
    const weird = "raw text with no fences\n\nand another paragraph\n";
    writeScratchpad(dir, weird, "ui");
    const onDisk = fs.readFileSync(scratchpadPath(dir), "utf8");
    expect(onDisk).toBe(weird);
  });

  it("non-canonical fenced content survives writeScratchpad verbatim", () => {
    const dir = tmpDir();
    const noisy =
      "<!-- block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\nbody\n<!-- /block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\nTRAILING JUNK\n";
    writeScratchpad(dir, noisy, "ui");
    const onDisk = fs.readFileSync(scratchpadPath(dir), "utf8");
    expect(onDisk).toBe(noisy);
  });
});

describe("block CRUD", () => {
  it("addBlock at end appends after existing blocks", () => {
    const dir = tmpDir();
    addBlock(dir, "first", "end", "ui:add_block");
    const result = addBlock(dir, "second", "end", "ui:add_block");
    if ("error" in result) throw new Error(result.error);
    const blocks = parseBlocks(result.snapshot.content).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["first", "second"]);
  });

  it("addBlock with afterId inserts after the given block", () => {
    const dir = tmpDir();
    const a = addBlock(dir, "a", "end", "ui:add_block");
    addBlock(dir, "c", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    addBlock(dir, "b", { afterId: a.block.id }, "ui:add_block");
    const blocks = listBlocks(dir).blocks;
    expect(blocks.map((b) => b.text)).toEqual(["a", "b", "c"]);
  });

  it("addBlock with unknown afterId returns block_not_found", () => {
    const dir = tmpDir();
    addBlock(dir, "real", "end", "ui:add_block");
    const result = addBlock(dir, "x", { afterId: "missing-id" }, "ui:add_block");
    expect(result).toEqual({ error: "block_not_found" });
  });

  it("addBlock with empty/whitespace text returns text_required", () => {
    const dir = tmpDir();
    expect(addBlock(dir, "", "end", "ui:add_block")).toEqual({ error: "text_required" });
    expect(addBlock(dir, "  \n\t ", "end", "ui:add_block")).toEqual({ error: "text_required" });
  });

  it("updateBlock overwrites a block's text while preserving its UUID", () => {
    const dir = tmpDir();
    const a = addBlock(dir, "before", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    const r = updateBlock(dir, a.block.id, "after", "ui:edit_block");
    if ("error" in r) throw new Error(r.error);
    if (!("block" in r)) throw new Error("update with non-empty text must return a block");
    expect(r.block.id).toBe(a.block.id);
    expect(r.block.text).toBe("after");
  });

  it("updateBlock with empty text deletes the block", () => {
    const dir = tmpDir();
    const a = addBlock(dir, "doomed", "end", "ui:add_block");
    if ("error" in a) throw new Error(a.error);
    const r = updateBlock(dir, a.block.id, "", "ui:delete_block");
    expect("error" in r).toBe(false);
    expect(listBlocks(dir).blocks).toHaveLength(0);
  });

  it("updateBlock with unknown id returns block_not_found", () => {
    const dir = tmpDir();
    expect(updateBlock(dir, "missing", "text", "ui:edit_block")).toEqual({ error: "block_not_found" });
  });

  it("deleteBlock removes the block and preserves all other UUIDs", () => {
    const dir = tmpDir();
    const a = addBlock(dir, "a", "end", "ui:add_block");
    const b = addBlock(dir, "b", "end", "ui:add_block");
    const c = addBlock(dir, "c", "end", "ui:add_block");
    if ("error" in a || "error" in b || "error" in c) throw new Error("seed failed");
    deleteBlock(dir, b.block.id, "ui:delete_block");
    const ids = listBlocks(dir).blocks.map((x) => x.id);
    expect(ids).toEqual([a.block.id, c.block.id]);
  });

  it("deleteBlock with unknown id returns block_not_found", () => {
    const dir = tmpDir();
    expect(deleteBlock(dir, "missing", "ui:delete_block")).toEqual({ error: "block_not_found" });
  });

  it("listBlocks returns blocks with createdAt/updatedAt derived from history", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T10:00:00Z");
    const t1 = new Date("2026-05-25T10:30:00Z");
    const a = addBlock(dir, "v1", "end", "ui:add_block", { now: () => t0 });
    if ("error" in a) throw new Error(a.error);
    // Different source so the second write opens a fresh history entry rather than coalescing.
    updateBlock(dir, a.block.id, "v2", "mcp:update_block", { now: () => t1 });
    const blocks = listBlocks(dir).blocks;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.createdAt).toBe(t0.toISOString());
    expect(blocks[0]?.updatedAt).toBe(t1.toISOString());
  });

  it("block CRUD writes inside the same coalesce window collapse into one history entry", () => {
    const dir = tmpDir();
    const t0 = new Date("2026-05-25T10:00:00Z");
    const t30 = new Date("2026-05-25T10:00:30Z");
    addBlock(dir, "first", "end", "ui:add_block", { now: () => t0 });
    addBlock(dir, "second", "end", "ui:add_block", { now: () => t30 });
    const entries = readHistory(dir).filter((e) => e.source === "ui:add_block");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.coalescedCount).toBe(2);
  });
});
