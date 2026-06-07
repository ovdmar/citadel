import { describe, expect, it } from "vitest";
import {
  applySessionOrder,
  pruneSessionOrder,
  replaceSessionOrderId,
  spliceSessionOrder,
} from "./stage-session-order.js";

const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("applySessionOrder", () => {
  it("places ordered session ids first and keeps the rest stable", () => {
    expect(applySessionOrder(sessions, ["c", "a"]).map((session) => session.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores stale ids", () => {
    expect(applySessionOrder(sessions, ["x", "b"]).map((session) => session.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("can order by stable tab ids while still accepting legacy session ids", () => {
    const tabbed = [
      { id: "old", tabId: "tab_a" },
      { id: "fresh", tabId: "tab_b" },
      { id: "plain", tabId: null },
    ];

    expect(applySessionOrder(tabbed, ["tab_b", "old"], (session) => session.tabId ?? session.id)).toEqual([
      tabbed[1],
      tabbed[0],
      tabbed[2],
    ]);
  });
});

describe("spliceSessionOrder", () => {
  it("moves a dragged session into the visible index", () => {
    expect(spliceSessionOrder(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
  });
});

describe("replaceSessionOrderId", () => {
  it("replaces a reloaded session row id without changing order", () => {
    expect(replaceSessionOrderId(["a", "old", "c"], "old", "new")).toEqual(["a", "new", "c"]);
  });

  it("deduplicates when the replacement id is already present", () => {
    expect(replaceSessionOrderId(["a", "old", "new"], "old", "new")).toEqual(["a", "new"]);
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
