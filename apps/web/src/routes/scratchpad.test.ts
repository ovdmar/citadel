import { describe, expect, it } from "vitest";
import { __testing__ } from "./scratchpad.js";

const { appendScratchpadParam } = __testing__;

describe("appendScratchpadParam (scratchpad redirect helper)", () => {
  it("appends to a bare path", () => {
    expect(appendScratchpadParam("/")).toBe("/?scratchpad=1");
    expect(appendScratchpadParam("/settings")).toBe("/settings?scratchpad=1");
  });

  it("merges into an existing query string with `&`", () => {
    expect(appendScratchpadParam("/operations?tab=runs")).toBe("/operations?tab=runs&scratchpad=1");
  });

  it("preserves a trailing hash fragment", () => {
    // The redirect target may legitimately include a hash (e.g. anchor links
    // saved by the last-route persistence layer); the helper must keep it.
    expect(appendScratchpadParam("/settings#agents")).toBe("/settings?scratchpad=1#agents");
    expect(appendScratchpadParam("/operations?tab=runs#latest")).toBe("/operations?tab=runs&scratchpad=1#latest");
  });
});
