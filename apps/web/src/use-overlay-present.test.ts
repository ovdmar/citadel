// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OVERLAY_COUNT_KEY,
  decrementOverlayCount,
  incrementOverlayCount,
  readOverlayCount,
} from "./use-overlay-present.js";

const overlayKey = OVERLAY_COUNT_KEY;

describe("overlay ref-count helpers (jsdom)", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>)[overlayKey];
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>)[overlayKey];
  });

  it("readOverlayCount returns 0 when key absent", () => {
    expect(readOverlayCount()).toBe(0);
  });

  it("incrementOverlayCount adds 1", () => {
    incrementOverlayCount();
    expect(readOverlayCount()).toBe(1);
  });

  it("decrementOverlayCount subtracts 1", () => {
    incrementOverlayCount();
    incrementOverlayCount();
    decrementOverlayCount();
    expect(readOverlayCount()).toBe(1);
  });

  it("decrementOverlayCount never goes negative", () => {
    decrementOverlayCount();
    decrementOverlayCount();
    expect(readOverlayCount()).toBe(0);
  });

  it("supports nested ref-counting", () => {
    incrementOverlayCount();
    incrementOverlayCount();
    incrementOverlayCount();
    expect(readOverlayCount()).toBe(3);
    decrementOverlayCount();
    decrementOverlayCount();
    decrementOverlayCount();
    expect(readOverlayCount()).toBe(0);
  });

  it("readOverlayCount falls back to 0 when the global is corrupted to a non-number", () => {
    (window as unknown as Record<string, unknown>)[overlayKey] = "not a number";
    expect(readOverlayCount()).toBe(0);
  });
});
