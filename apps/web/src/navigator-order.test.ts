import { describe, expect, it } from "vitest";
import { applyLocalOrder, encodeReorderMimeType, parseReorderMimeType } from "./navigator-order.js";

type Entry = { workspace: { id: string }; label: string };

const entries: Entry[] = [
  { workspace: { id: "a" }, label: "A" },
  { workspace: { id: "b" }, label: "B" },
  { workspace: { id: "c" }, label: "C" },
  { workspace: { id: "d" }, label: "D" },
];

describe("applyLocalOrder", () => {
  it("returns entries unchanged when no idOrder is supplied", () => {
    expect(applyLocalOrder(entries, undefined).map((e) => e.workspace.id)).toEqual(["a", "b", "c", "d"]);
    expect(applyLocalOrder(entries, []).map((e) => e.workspace.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("orders listed ids first in the given sequence", () => {
    const result = applyLocalOrder(entries, ["c", "a"]);
    expect(result.map((e) => e.workspace.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("appends entries not in idOrder in their default order", () => {
    // Only `b` is reordered; a/c/d follow in their original sequence.
    const result = applyLocalOrder(entries, ["b"]);
    expect(result.map((e) => e.workspace.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("drops idOrder entries that don't exist in entries (stale ids)", () => {
    // `x` and `y` are no longer present (workspace was removed). They must
    // not appear in the output and must not throw.
    const result = applyLocalOrder(entries, ["x", "c", "y", "b"]);
    expect(result.map((e) => e.workspace.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("is stable when idOrder fully covers entries in a different order", () => {
    const result = applyLocalOrder(entries, ["d", "c", "b", "a"]);
    expect(result.map((e) => e.workspace.id)).toEqual(["d", "c", "b", "a"]);
  });
});

describe("encode/parse reorder mime type", () => {
  it("roundtrips a group path without lowercasing it", () => {
    const mime = encodeReorderMimeType("repo=Citadel UI/status=Needs Review");
    expect(mime).toBe(mime.toLowerCase());
    expect(parseReorderMimeType(mime)).toBe("repo=Citadel UI/status=Needs Review");
  });

  it("recognizes the reorder prefix", () => {
    expect(encodeReorderMimeType("__flat").startsWith("application/x-citadel-workspace-reorder+")).toBe(true);
  });

  it("returns null for unrelated mime types", () => {
    expect(parseReorderMimeType("application/json")).toBe(null);
    expect(parseReorderMimeType("application/x-citadel-workspace-id")).toBe(null);
  });
});
