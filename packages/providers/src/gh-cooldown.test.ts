import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GH_COOLDOWN_MS,
  clearGhCooldown,
  getGhCooldown,
  getGhCooldownReason,
  getGhCooldownUntil,
  setGhCooldown,
} from "./gh-cooldown.js";

// Module state is process-global, so every test must clear after itself or
// the next test sees a stale cooldown window.
afterEach(() => {
  clearGhCooldown();
});

describe("setGhCooldown / getGhCooldown", () => {
  it("installs a future window getGhCooldown observes", () => {
    const reason = "API rate limit exceeded for user ID 42";
    const until = setGhCooldown(reason, 60_000);
    const observed = getGhCooldown();
    expect(observed).not.toBeNull();
    expect(observed?.reason).toBe(reason);
    expect(observed?.until).toBe(until);
    expect(observed?.until).toBeGreaterThan(Date.now());
  });

  it("uses DEFAULT_GH_COOLDOWN_MS when durationMs is omitted", () => {
    const before = Date.now();
    const until = setGhCooldown("secondary rate limit");
    // Allow a few ms for the call to settle; the window should be ~15 min ahead.
    expect(until).toBeGreaterThanOrEqual(before + DEFAULT_GH_COOLDOWN_MS - 100);
    expect(until).toBeLessThanOrEqual(before + DEFAULT_GH_COOLDOWN_MS + 100);
  });

  it("getGhCooldown returns null once the window has elapsed", () => {
    setGhCooldown("rate limit", 1); // 1ms cooldown
    // Sleep slightly past the window — synchronous wait via a tight loop, since
    // vitest's fake timers aren't installed here.
    const deadline = Date.now() + 5;
    while (Date.now() < deadline) {
      /* spin briefly */
    }
    expect(getGhCooldown()).toBeNull();
  });

  it("getGhCooldownUntil and getGhCooldownReason mirror setGhCooldown state", () => {
    const until = setGhCooldown("the literal reason", 30_000);
    expect(getGhCooldownUntil()).toBe(until);
    expect(getGhCooldownReason()).toBe("the literal reason");
  });

  it("a later setGhCooldown extends / overwrites the prior window and reason", () => {
    setGhCooldown("first reason", 10_000);
    const second = setGhCooldown("second reason", 60_000);
    expect(getGhCooldown()).toEqual({ until: second, reason: "second reason" });
  });
});

describe("clearGhCooldown", () => {
  it("empties getGhCooldown synchronously", () => {
    setGhCooldown("x", 60_000);
    expect(getGhCooldown()).not.toBeNull();
    clearGhCooldown();
    expect(getGhCooldown()).toBeNull();
  });

  it("zeros getGhCooldownUntil and nulls getGhCooldownReason", () => {
    setGhCooldown("x", 60_000);
    clearGhCooldown();
    expect(getGhCooldownUntil()).toBe(0);
    expect(getGhCooldownReason()).toBeNull();
  });

  it("is a no-op when no cooldown is active", () => {
    expect(getGhCooldown()).toBeNull();
    clearGhCooldown();
    expect(getGhCooldown()).toBeNull();
  });
});
