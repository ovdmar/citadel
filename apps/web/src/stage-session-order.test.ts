import { describe, expect, it } from "vitest";
import { applySessionOrder, pruneSessionOrder, spliceSessionOrder } from "./stage-session-order.js";

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("applySessionOrder", () => {
  it("places ordered session ids first and keeps the rest stable", () => {
    expect(applySessionOrder(sessions, ["c", "a"]).map((session) => session.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores stale ids", () => {
    expect(applySessionOrder(sessions, ["x", "b"]).map((session) => session.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("spliceSessionOrder", () => {
  it("moves a dragged session into the visible index", () => {
    expect(spliceSessionOrder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });
});

describe("pruneSessionOrder", () => {
  it("removes stale session ids and empty workspace buckets", () => {
    expect(
      pruneSessionOrder(
        {
          ws1: ["a", "gone"],
          ws2: ["missing"],
        },
        new Set(["a"]),
      ),
    ).toEqual({ ws1: ["a"] });
  });
});
