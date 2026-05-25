import { describe, expect, it } from "vitest";
import { MAX_DIFF_LINES, sideBySideDiff } from "./scratchpad-diff.js";

describe("sideBySideDiff", () => {
  it("returns no rows when both sides are identical", () => {
    const result = sideBySideDiff("a\nb\nc", "a\nb\nc");
    if (result.kind !== "diff") throw new Error("expected diff");
    // All-context with no surrounding changes collapses entirely into a single skip row.
    expect(result.rows.every((row) => row.kind === "context" || row.kind === "skip")).toBe(true);
    expect(result.rows.some((row) => row.kind === "add" || row.kind === "remove")).toBe(false);
  });

  it("produces only add rows when the older side has no overlapping content", () => {
    // Use one shared anchor so the empty-line ambiguity (''.split('\n') === ['']) doesn't muddy the assertion.
    const result = sideBySideDiff("a", "a\nx\ny");
    if (result.kind !== "diff") throw new Error("expected diff");
    const adds = result.rows.filter((row) => row.kind === "add");
    expect(adds).toHaveLength(2);
    expect(result.rows.some((row) => row.kind === "remove")).toBe(false);
  });

  it("produces only remove rows when the newer side drops trailing lines", () => {
    const result = sideBySideDiff("a\nx\ny", "a");
    if (result.kind !== "diff") throw new Error("expected diff");
    const removes = result.rows.filter((row) => row.kind === "remove");
    expect(removes).toHaveLength(2);
    expect(result.rows.some((row) => row.kind === "add")).toBe(false);
  });

  it("assigns monotonic line numbers per side", () => {
    const result = sideBySideDiff("a\nb\nc\nd", "a\nB\nc\nD", 3);
    if (result.kind !== "diff") throw new Error("expected diff");
    const oldNos = result.rows
      .filter((row) => row.kind === "context" || row.kind === "remove")
      .map((row) => (row.kind === "context" ? row.oldNo : row.oldNo));
    const newNos = result.rows
      .filter((row) => row.kind === "context" || row.kind === "add")
      .map((row) => (row.kind === "context" ? row.newNo : row.newNo));
    expect(oldNos).toEqual([...oldNos].sort((a, b) => a - b));
    expect(newNos).toEqual([...newNos].sort((a, b) => a - b));
  });

  it("collapses long unchanged runs into a skip row with the correct hiddenCount", () => {
    const same = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const result = sideBySideDiff(`${same}\nchanged-old\n${same}`, `${same}\nchanged-new\n${same}`, 3);
    if (result.kind !== "diff") throw new Error("expected diff");
    const skips = result.rows.filter((row) => row.kind === "skip");
    expect(skips).toHaveLength(2);
    // 20 lines surround each change; 3 lines of trail (or lead) are kept, so 17 are hidden.
    expect(skips.every((row) => row.kind === "skip" && row.hiddenCount === 17)).toBe(true);
  });

  it("uses lead=0 at the start and trail=0 at the end", () => {
    const same = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const result = sideBySideDiff(`${same}\nx`, `${same}\ny`, 3);
    if (result.kind !== "diff") throw new Error("expected diff");
    // 20 leading unchanged lines, then a single-line change at the end. Lead is
    // unused at start (out.length === 0), so a single skip absorbs all but
    // contextLines=3 trailing lines.
    const first = result.rows[0];
    expect(first?.kind).toBe("skip");
    if (first?.kind === "skip") expect(first.hiddenCount).toBe(17);
  });

  it("does not split a runLen exactly equal to 2*contextLines", () => {
    // Unchanged run of length 6 between two changes, contextLines=3 → lead+trail = 6 → no skip.
    const result = sideBySideDiff("x\na\nb\nc\nd\ne\nf\ny", "X\na\nb\nc\nd\ne\nf\nY", 3);
    if (result.kind !== "diff") throw new Error("expected diff");
    expect(result.rows.some((row) => row.kind === "skip")).toBe(false);
  });

  it("returns a too_large sentinel above the line-count threshold", () => {
    const oversize = Array.from({ length: MAX_DIFF_LINES + 5 }, (_, i) => `line${i}`).join("\n");
    const result = sideBySideDiff(oversize, "single line");
    expect(result.kind).toBe("too_large");
    if (result.kind === "too_large") {
      expect(result.oldLines).toBe(MAX_DIFF_LINES + 5);
      expect(result.newLines).toBe(1);
      expect(result.limit).toBe(MAX_DIFF_LINES);
    }
  });

  it("honors a custom maxLines override", () => {
    const result = sideBySideDiff("a\nb\nc\nd", "a\nb\nc\nd\ne", 3, 3);
    expect(result.kind).toBe("too_large");
  });

  it("handles trailing newline without producing a stray remove/add", () => {
    // 'a\nb\n' splits to ['a','b',''] — same on both sides, so all context.
    const result = sideBySideDiff("a\nb\n", "a\nb\n");
    if (result.kind !== "diff") throw new Error("expected diff");
    expect(result.rows.every((row) => row.kind === "context" || row.kind === "skip")).toBe(true);
  });
});
