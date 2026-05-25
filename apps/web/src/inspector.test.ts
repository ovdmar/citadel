import { describe, expect, it } from "vitest";
import { aggregateReviewerCounts, shortenRelative } from "./inspector.js";

describe("aggregateReviewerCounts", () => {
  it("counts only approved/changes_requested/pending — never commented or dismissed", () => {
    const counts = aggregateReviewerCounts([
      { login: "a", name: null, state: "approved" },
      { login: "b", name: null, state: "approved" },
      { login: "c", name: null, state: "changes_requested" },
      { login: "d", name: null, state: "pending" },
      { login: "e", name: null, state: "commented" },
      { login: "f", name: null, state: "dismissed" },
    ]);
    expect(counts).toEqual({ approved: 2, changes: 1, pending: 1 });
  });

  it("returns zeros for an empty reviewer list", () => {
    expect(aggregateReviewerCounts([])).toEqual({ approved: 0, changes: 0, pending: 0 });
  });
});

describe("shortenRelative", () => {
  it("compacts each git relative-time unit and strips the trailing 'ago'", () => {
    expect(shortenRelative("3 seconds ago")).toBe("3s");
    expect(shortenRelative("1 minute ago")).toBe("1m");
    expect(shortenRelative("42 minutes ago")).toBe("42m");
    expect(shortenRelative("2 hours ago")).toBe("2h");
    expect(shortenRelative("9 days ago")).toBe("9d");
    expect(shortenRelative("3 weeks ago")).toBe("3w");
    // Order-sensitive: months must NOT be shortened by the minutes regex.
    expect(shortenRelative("5 months ago")).toBe("5mo");
    expect(shortenRelative("2 years ago")).toBe("2y");
  });

  it("returns an empty string for falsy input", () => {
    expect(shortenRelative("")).toBe("");
  });

  it("leaves non-numeric git phrases alone aside from the trailing 'ago'", () => {
    expect(shortenRelative("just now")).toBe("just now");
  });
});
