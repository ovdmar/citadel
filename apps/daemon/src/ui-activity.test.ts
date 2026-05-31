import { describe, expect, it } from "vitest";
import { createUiActivityTracker } from "./ui-activity.js";

describe("createUiActivityTracker", () => {
  it("reports focused visible pages as active viewers", () => {
    const tracker = createUiActivityTracker();

    tracker.recordClientEvent({ event: "page.focus", pageId: "p1", visibility: "visible", focused: true });

    expect(tracker.hasFocusedWindow()).toBe(true);
  });

  it("does not count hidden, blurred, stale, or closed pages", () => {
    let now = 1_000;
    const tracker = createUiActivityTracker({ now: () => now, staleAfterMs: 1_000 });

    tracker.recordClientEvent({ event: "page.focus", pageId: "p1", visibility: "hidden", focused: true });
    expect(tracker.hasFocusedWindow()).toBe(false);

    tracker.recordClientEvent({ event: "page.blur", pageId: "p1", visibility: "visible", focused: false });
    expect(tracker.hasFocusedWindow()).toBe(false);

    tracker.recordClientEvent({ event: "page.focus", pageId: "p1", visibility: "visible", focused: true });
    expect(tracker.hasFocusedWindow()).toBe(true);

    now += 1_001;
    expect(tracker.hasFocusedWindow()).toBe(false);

    tracker.recordClientEvent({ event: "page.focus", pageId: "p1", visibility: "visible", focused: true });
    expect(tracker.hasFocusedWindow()).toBe(true);
    tracker.recordClientEvent({ event: "page.pagehide", pageId: "p1", visibility: "hidden", focused: false });
    expect(tracker.hasFocusedWindow()).toBe(false);
  });
});
