import crypto from "node:crypto";
import type { ScratchpadHistoryEntry } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  type Block,
  computeBlockTimestamps,
  migrateIfNeeded,
  parseBlocks,
  serializeBlocks,
} from "./scratchpad-blocks.js";
import { DEFAULT_STUB } from "./scratchpad.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fence(id: string, body: string) {
  return `<!-- block:${id} -->\n${body}\n<!-- /block:${id} -->`;
}

function uuid(label: string): string {
  // Deterministic v4-shaped IDs for test fixtures; hash the label to 8 hex chars
  // so distinct labels always produce distinct UUIDs (no character-strip collision).
  const hash = crypto.createHash("sha1").update(label).digest("hex").slice(0, 8);
  return `${hash}-aaaa-4bbb-8ccc-aaaaaaaaaaaa`;
}

describe("parseBlocks", () => {
  it("round-trips canonical input — parse → serialize === input", () => {
    const input = `${fence(uuid("alpha"), "first idea")}\n\n${fence(uuid("beta"), "second idea")}\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(needsRewrite).toBe(false);
    expect(blocks).toEqual<Block[]>([
      { id: uuid("alpha"), text: "first idea" },
      { id: uuid("beta"), text: "second idea" },
    ]);
    expect(serializeBlocks(blocks)).toBe(input);
  });

  it("is idempotent — parse → serialize → parse preserves UUIDs and content", () => {
    const input = `${fence(uuid("idemp"), "stable text\n\nwith blank line inside")}\n`;
    const first = parseBlocks(input);
    const second = parseBlocks(serializeBlocks(first.blocks));
    expect(second.blocks).toEqual(first.blocks);
    expect(second.needsRewrite).toBe(false);
  });

  it("accepts non-v4 UUIDs (any 8-4-4-4-12 hex)", () => {
    const v1Like = "11111111-2222-1333-9444-555555555555";
    const input = `${fence(v1Like, "non-v4 still parses")}\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(blocks).toEqual([{ id: v1Like, text: "non-v4 still parses" }]);
    expect(needsRewrite).toBe(false);
  });

  it("rejects malformed UUID (wrong length) as a fence — falls through to lenient handling", () => {
    const malformed = "12345-aaaa-4bbb-8ccc-aaaaaaaaaaaa"; // 5-4-4-4-12, first group too short
    const input = `<!-- block:${malformed} -->\nbody\n<!-- /block:${malformed} -->\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    // Treated as unfenced content; promoted to a fresh block.
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain("body");
    expect(blocks[0]?.id).toMatch(UUID_V4);
    expect(needsRewrite).toBe(true);
  });

  it("unmatched open fence consumes to next open fence or EOF (needsRewrite)", () => {
    const id1 = uuid("noclose");
    const id2 = uuid("good");
    const input = `<!-- block:${id1} -->\norphan body\nmore\n${fence(id2, "ok")}\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(needsRewrite).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).toBe(id1);
    expect(blocks[0]?.text).toContain("orphan body");
    expect(blocks[0]?.text).toContain("more");
    expect(blocks[1]?.id).toBe(id2);
  });

  it("unmatched open fence followed by close with different UUID is treated as open-only", () => {
    const id1 = uuid("openA");
    const id2 = uuid("closeB");
    const input = `<!-- block:${id1} -->\nbody\n<!-- /block:${id2} -->\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(needsRewrite).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe(id1);
    expect(blocks[0]?.text).toContain("body");
    expect(blocks[0]?.text).toContain("/block:");
  });

  it("unfenced content at top is promoted to a new block on rewrite", () => {
    const id = uuid("rest");
    const input = `stray text at top\n\n${fence(id, "real block")}\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(needsRewrite).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.text).toBe("stray text at top");
    expect(blocks[0]?.id).toMatch(UUID_V4);
    expect(blocks[1]?.id).toBe(id);
  });

  it("DEFAULT_STUB at top yields zero blocks and needsRewrite=false", () => {
    const { blocks, needsRewrite } = parseBlocks(DEFAULT_STUB);
    expect(blocks).toEqual([]);
    expect(needsRewrite).toBe(false);
  });

  it("empty blocks are dropped on serialize", () => {
    const blocks: Block[] = [
      { id: uuid("alpha"), text: "real" },
      { id: uuid("empty"), text: "" },
      { id: uuid("ws"), text: "   \n  " },
      { id: uuid("beta"), text: "also real" },
    ];
    const out = serializeBlocks(blocks);
    const back = parseBlocks(out).blocks;
    expect(back).toEqual([
      { id: uuid("alpha"), text: "real" },
      { id: uuid("beta"), text: "also real" },
    ]);
  });

  it("blank lines inside a block are preserved", () => {
    const id = uuid("blank");
    const inner = "line one\n\nline two\n\n\nline three";
    const input = `${fence(id, inner)}\n`;
    const { blocks } = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(inner);
  });

  it("is lenient — never throws on garbage input", () => {
    const inputs = [
      "",
      "\n\n\n",
      "<!-- block: -->",
      "<!-- block:not-a-uuid -->",
      "<!-- /block:orphan -->",
      "<<<<<>>>>>>",
      "<!-- block:9a3f1b2c-7e44-4f01-8b1d-a2c3d4e5f6a7 -->",
    ];
    for (const input of inputs) {
      expect(() => parseBlocks(input)).not.toThrow();
    }
  });

  it("treats <!-- block:UUID --> inside a triple-backtick code fence as content, not a new block", () => {
    const outer = uuid("outer");
    const fenceInside = uuid("innera");
    const inner = [
      "here is documentation:",
      "```markdown",
      `<!-- block:${fenceInside} -->`,
      "inner body",
      `<!-- /block:${fenceInside} -->`,
      "```",
      "and that's it",
    ].join("\n");
    const input = `${fence(outer, inner)}\n`;
    const { blocks } = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.id).toBe(outer);
    expect(blocks[0]?.text).toBe(inner);
  });

  it("two blocks with duplicate UUIDs produce two blocks with distinct UUIDs + needsRewrite", () => {
    const same = uuid("dupe");
    const input = `${fence(same, "first body")}\n\n${fence(same, "second body")}\n`;
    const { blocks, needsRewrite } = parseBlocks(input);
    expect(needsRewrite).toBe(true);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).toBe(same);
    expect(blocks[1]?.id).not.toBe(same);
    expect(blocks[1]?.id).toMatch(UUID_V4);
    expect(blocks[0]?.text).toBe("first body");
    expect(blocks[1]?.text).toBe("second body");
  });

  it("preserves multi-byte content inside a block", () => {
    const id = uuid("mb");
    const inner = "📝 emoji + RTL ‏ مرحبا ‎ end";
    const input = `${fence(id, inner)}\n`;
    const { blocks } = parseBlocks(input);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toBe(inner);
  });
});

describe("serializeBlocks", () => {
  it("emits canonical form — one blank line between blocks, trailing newline", () => {
    const blocks: Block[] = [
      { id: uuid("a"), text: "first" },
      { id: uuid("b"), text: "second" },
    ];
    const out = serializeBlocks(blocks);
    expect(out).toBe(`${fence(uuid("a"), "first")}\n\n${fence(uuid("b"), "second")}\n`);
  });

  it("emits empty string for empty block list", () => {
    expect(serializeBlocks([])).toBe("");
  });
});

describe("migrateIfNeeded", () => {
  it("no migration for empty / whitespace-only / DEFAULT_STUB input", () => {
    for (const raw of ["", "   \n\n\t  ", DEFAULT_STUB]) {
      const { migrated, content } = migrateIfNeeded(raw);
      expect(migrated).toBe(false);
      expect(content).toBe(raw);
    }
  });

  it("no migration when content is already fenced and canonical", () => {
    const raw = `${fence(uuid("ok"), "fine")}\n\n${fence(uuid("ok2"), "also fine")}\n`;
    const { migrated, content } = migrateIfNeeded(raw);
    expect(migrated).toBe(false);
    expect(content).toBe(raw);
  });

  it("rewrites already-fenced content with trailing junk", () => {
    const raw = `${fence(uuid("a"), "body")}\nGARBAGE\n`;
    const { migrated, content } = migrateIfNeeded(raw);
    expect(migrated).toBe(true);
    // Trailing junk gets promoted to a new block by the lenient parser; both survive.
    const parsed = parseBlocks(content);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.blocks.map((b) => b.text)).toEqual(["body", "GARBAGE"]);
  });

  it("converts legacy blank-line-separated content into fenced blocks with fresh v4 UUIDs", () => {
    const raw = "first idea\n\nsecond idea\n\nthird idea\n";
    const { migrated, content } = migrateIfNeeded(raw);
    expect(migrated).toBe(true);
    const parsed = parseBlocks(content);
    expect(parsed.needsRewrite).toBe(false);
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[0]?.text).toBe("first idea");
    expect(parsed.blocks[1]?.text).toBe("second idea");
    expect(parsed.blocks[2]?.text).toBe("third idea");
    for (const b of parsed.blocks) expect(b.id).toMatch(UUID_V4);
    expect(new Set(parsed.blocks.map((b) => b.id)).size).toBe(3);
  });

  it("is idempotent — running twice yields the same blocks with the same UUIDs", () => {
    const raw = "alpha\n\nbeta\n";
    const first = migrateIfNeeded(raw);
    expect(first.migrated).toBe(true);
    const second = migrateIfNeeded(first.content);
    expect(second.migrated).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("promotes legacy content even when DEFAULT_STUB is the start, dropping the stub", () => {
    const raw = `${DEFAULT_STUB}real idea\n\nanother real idea\n`;
    const { migrated, content } = migrateIfNeeded(raw);
    expect(migrated).toBe(true);
    const parsed = parseBlocks(content);
    expect(parsed.blocks.map((b) => b.text)).toEqual(["real idea", "another real idea"]);
  });
});

function entry(input: { ts: string; firstWriteTs?: string; content: string }): ScratchpadHistoryEntry {
  return {
    id: `scratch_${Math.random().toString(36).slice(2)}`,
    ts: input.ts,
    firstWriteTs: input.firstWriteTs ?? input.ts,
    source: "ui",
    contentSha256: "x".repeat(64),
    byteLength: Buffer.byteLength(input.content, "utf8"),
    coalescedCount: 1,
    content: input.content,
  };
}

describe("computeBlockTimestamps", () => {
  it("oldest entry containing a UUID gives createdAt; newest content change gives updatedAt", () => {
    const idA = uuid("aaaa");
    const idB = uuid("bbbb");
    const e1 = entry({ ts: "2026-05-25T10:00:00Z", content: `${fence(idA, "v1")}\n` });
    const e2 = entry({ ts: "2026-05-25T11:00:00Z", content: `${fence(idA, "v2")}\n\n${fence(idB, "B-v1")}\n` });
    const e3 = entry({ ts: "2026-05-25T12:00:00Z", content: `${fence(idA, "v3")}\n\n${fence(idB, "B-v1")}\n` });

    const { map, fallbackMtime } = computeBlockTimestamps(
      [e1, e2, e3],
      [
        { id: idA, text: "v3" },
        { id: idB, text: "B-v1" },
      ],
      "2026-06-01T00:00:00Z",
    );

    expect(map.get(idA)?.createdAt).toBe("2026-05-25T10:00:00Z");
    expect(map.get(idA)?.updatedAt).toBe("2026-05-25T12:00:00Z");
    expect(map.get(idB)?.createdAt).toBe("2026-05-25T11:00:00Z");
    // B never changed across e2→e3, so updatedAt stays at createdAt.
    expect(map.get(idB)?.updatedAt).toBe("2026-05-25T11:00:00Z");
    expect(fallbackMtime).toBe("2026-06-01T00:00:00Z");
  });

  it("falls back to mtime when a block predates history", () => {
    const idA = uuid("hist");
    const idB = uuid("ghost"); // not in any history entry
    const e = entry({ ts: "2026-05-25T10:00:00Z", content: `${fence(idA, "x")}\n` });
    const mtime = "2026-05-26T00:00:00Z";
    const { map } = computeBlockTimestamps(
      [e],
      [
        { id: idA, text: "x" },
        { id: idB, text: "y" },
      ],
      mtime,
    );
    expect(map.get(idA)?.createdAt).toBe("2026-05-25T10:00:00Z");
    expect(map.get(idB)?.createdAt).toBe(mtime);
    expect(map.get(idB)?.updatedAt).toBe(mtime);
  });

  it("monotonicity invariant — createdAt <= updatedAt for every block", () => {
    const idA = uuid("mono");
    const e1 = entry({ ts: "2026-05-25T10:00:00Z", content: `${fence(idA, "v1")}\n` });
    const e2 = entry({ ts: "2026-05-25T11:00:00Z", content: `${fence(idA, "v2")}\n` });
    const { map } = computeBlockTimestamps([e1, e2], [{ id: idA, text: "v2" }], "2026-05-26T00:00:00Z");
    const ts = map.get(idA);
    expect(ts).toBeDefined();
    if (ts) expect(Date.parse(ts.createdAt)).toBeLessThanOrEqual(Date.parse(ts.updatedAt));
  });
});
