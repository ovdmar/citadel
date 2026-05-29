import type { ScratchpadBlockSummary } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { SEARCH_LIMITS, fuzzySearchBlocks } from "./scratchpad-search.js";

function block(id: string, text: string, updatedAt = "2026-05-25T00:00:00.000Z"): ScratchpadBlockSummary {
  return { id, text, createdAt: updatedAt, updatedAt };
}

const SAMPLE: ScratchpadBlockSummary[] = [
  block("a", "ship the scratchpad refine MCP"),
  block("b", "audit the agent launcher tmux paste"),
  block("c", "fuzzy search across cockpit blocks"),
  block("d", "render <user_id> placeholders correctly"),
  block("e", "ttyd cleanup storm — do NOT delete dirty worktrees"),
];

describe("fuzzySearchBlocks", () => {
  it("returns empty for empty query (whitespace-only counts as empty)", () => {
    expect(fuzzySearchBlocks(SAMPLE, "")).toEqual([]);
    expect(fuzzySearchBlocks(SAMPLE, "   ")).toEqual([]);
  });

  it("matches a single-word query and ranks by score", () => {
    const results = fuzzySearchBlocks(SAMPLE, "fuzzy");
    expect(results.length).toBeGreaterThan(0);
    // The most fuzzy-matching block should be the one containing the word.
    expect(results[0]?.block.id).toBe("c");
  });

  it("is case insensitive", () => {
    const lower = fuzzySearchBlocks(SAMPLE, "fuzzy");
    const upper = fuzzySearchBlocks(SAMPLE, "FUZZY");
    expect(lower.map((r) => r.block.id)).toEqual(upper.map((r) => r.block.id));
  });

  it("matches multi-word queries", () => {
    const results = fuzzySearchBlocks(SAMPLE, "refine mcp");
    expect(results[0]?.block.id).toBe("a");
  });

  it("returns match indices for each hit", () => {
    const results = fuzzySearchBlocks(SAMPLE, "ttyd");
    const target = results.find((r) => r.block.id === "e");
    expect(target).toBeDefined();
    const allIndices = target?.matches.flatMap((m) => m.indices) ?? [];
    expect(allIndices.length).toBeGreaterThan(0);
    // Indices reference the matched text in the block; should be within bounds.
    for (const [start, end] of allIndices) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThanOrEqual(start);
      expect(end).toBeLessThan(target?.block.text.length ?? 0);
    }
  });

  it("respects the limit parameter and clamps to MAX_LIMIT", () => {
    const lots: ScratchpadBlockSummary[] = Array.from({ length: 100 }, (_, i) => block(`b${i}`, "scratchpad note"));
    const five = fuzzySearchBlocks(lots, "scratchpad", 5);
    expect(five.length).toBeLessThanOrEqual(5);
    const clamped = fuzzySearchBlocks(lots, "scratchpad", 9999);
    expect(clamped.length).toBeLessThanOrEqual(SEARCH_LIMITS.max);
  });

  it("returns empty results when nothing matches", () => {
    const results = fuzzySearchBlocks(SAMPLE, "qweqweqweqweqwe");
    expect(results).toEqual([]);
  });

  it("does not mutate the input blocks array", () => {
    const before = SAMPLE.map((b) => b.id).join(",");
    fuzzySearchBlocks(SAMPLE, "fuzzy");
    const after = SAMPLE.map((b) => b.id).join(",");
    expect(after).toBe(before);
  });
});
