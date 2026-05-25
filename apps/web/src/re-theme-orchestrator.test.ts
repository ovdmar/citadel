import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReThemeableHandle, defaultShuffle, setupReThemeOrchestrator } from "./re-theme-orchestrator.js";
import type { ResolvedTheme } from "./use-resolved-theme.js";

// Test-friendly subscriber: returns a `trigger` to fire the theme-change
// callback, plus a `getCleanupCount` so HMR / idempotency tests can verify
// no double-subscription.
function makeFakeSubscriber() {
  let callback: ((theme: ResolvedTheme) => void) | null = null;
  let cleanupCount = 0;
  return {
    subscribe(cb: (theme: ResolvedTheme) => void): () => void {
      callback = cb;
      return () => {
        cleanupCount += 1;
        callback = null;
      };
    },
    trigger(theme: ResolvedTheme) {
      callback?.(theme);
    },
    isSubscribed() {
      return callback !== null;
    },
    getCleanupCount() {
      return cleanupCount;
    },
  };
}

function makeHandle(initial: ResolvedTheme | null = null): {
  handle: ReThemeableHandle;
  reload: ReturnType<typeof vi.fn>;
  setLast: (theme: ResolvedTheme | null) => void;
} {
  const reload = vi.fn();
  let lastKnown = initial;
  return {
    reload,
    setLast(theme) {
      lastKnown = theme;
    },
    handle: {
      get lastKnownTheme() {
        return lastKnown;
      },
      reload: (theme: ResolvedTheme) => {
        reload(theme);
        lastKnown = theme;
      },
    },
  };
}

// Awaitable delay backed by fake timers — `vi.runAllTimersAsync()` drains it.
const fakeDelay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("setupReThemeOrchestrator", () => {
  it("calls reload(theme) on each registered handle when the theme changes", async () => {
    const subscriber = makeFakeSubscriber();
    const h1 = makeHandle("dark");
    const h2 = makeHandle("dark");
    setupReThemeOrchestrator({
      getHandles: () => [
        ["a", h1.handle],
        ["b", h2.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      staggerMs: 80,
      shuffle: (items) => items, // pin order for deterministic assertion
    });

    subscriber.trigger("light");
    await vi.runAllTimersAsync();

    expect(h1.reload).toHaveBeenCalledWith("light");
    expect(h2.reload).toHaveBeenCalledWith("light");
  });

  it("skips handles whose lastKnownTheme already matches (idempotent)", async () => {
    const subscriber = makeFakeSubscriber();
    const stale = makeHandle("dark");
    const current = makeHandle("light");
    setupReThemeOrchestrator({
      getHandles: () => [
        ["stale", stale.handle],
        ["current", current.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      shuffle: (items) => items,
    });

    subscriber.trigger("light");
    await vi.runAllTimersAsync();

    expect(stale.reload).toHaveBeenCalledTimes(1);
    expect(stale.reload).toHaveBeenCalledWith("light");
    // `current` was already on light — skip.
    expect(current.reload).not.toHaveBeenCalled();
  });

  it("staggers respawns with the configured delay (not all at once)", async () => {
    const subscriber = makeFakeSubscriber();
    const h1 = makeHandle("dark");
    const h2 = makeHandle("dark");
    const h3 = makeHandle("dark");
    setupReThemeOrchestrator({
      getHandles: () => [
        ["a", h1.handle],
        ["b", h2.handle],
        ["c", h3.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      staggerMs: 80,
      shuffle: (items) => items,
    });

    subscriber.trigger("light");
    // First reload runs synchronously (no preceding delay).
    await Promise.resolve();
    expect(h1.reload).toHaveBeenCalledTimes(1);
    expect(h2.reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    expect(h2.reload).toHaveBeenCalledTimes(1);
    expect(h3.reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    expect(h3.reload).toHaveBeenCalledTimes(1);
  });

  it("coalesces rapid toggles: a newer change aborts the in-flight loop", async () => {
    const subscriber = makeFakeSubscriber();
    // Start everything on dark. Trigger light → loop 1 will run handles in
    // order. Before loop 1's second stagger, trigger dark → loop 2 cancels.
    // After loop 2 completes: h1 was visited by BOTH loops (light then dark);
    // h2 and h3 are skipped by loop 2 because they're still on dark (loop 1
    // never reached them to flip to light).
    const h1 = makeHandle("dark");
    const h2 = makeHandle("dark");
    const h3 = makeHandle("dark");
    setupReThemeOrchestrator({
      getHandles: () => [
        ["a", h1.handle],
        ["b", h2.handle],
        ["c", h3.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      staggerMs: 80,
      shuffle: (items) => items,
    });

    subscriber.trigger("light");
    await Promise.resolve();
    expect(h1.reload).toHaveBeenLastCalledWith("light");

    // Fire a new toggle before the stagger window for h2 elapses.
    subscriber.trigger("dark");
    await vi.runAllTimersAsync();

    // h1 was on "light" from loop 1; loop 2 calls reload("dark"). Two calls.
    expect(h1.reload).toHaveBeenCalledTimes(2);
    expect(h1.reload).toHaveBeenLastCalledWith("dark");
    // h2 and h3 were never visited by loop 1 (cancelled at the stagger). Loop 2's
    // target is "dark" — same as their current lastKnownTheme — so the idempotency
    // skip applies: zero calls. This is the CORRECT behavior, not a bug — under
    // sustained toggling we converge to the final theme without unneeded respawns.
    expect(h2.reload).toHaveBeenCalledTimes(0);
    expect(h3.reload).toHaveBeenCalledTimes(0);
  });

  it("tail fairness: with 10 handles and 5 rapid toggles, all handles reach the final theme", async () => {
    const subscriber = makeFakeSubscriber();
    const handles = Array.from({ length: 10 }, (_, i) => ({ key: `h${i}`, ...makeHandle("dark") }));
    setupReThemeOrchestrator({
      getHandles: () => handles.map((h) => [h.key, h.handle] as [string, ReThemeableHandle]),
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      staggerMs: 80,
      // Random shuffle is correct under sustained toggling — pin to a known
      // permutation so the test is deterministic but exercises the
      // shuffled-order path.
      shuffle: (items) => {
        const copy = items.slice();
        copy.reverse();
        return copy;
      },
    });

    // Fire 5 toggles, draining timers between each so each loop gets some
    // forward progress (otherwise all 5 cancel immediately and only the last
    // theme's first iteration runs — that would test cancellation, not
    // fairness).
    const sequence: ResolvedTheme[] = ["light", "dark", "light", "dark", "light"];
    for (const theme of sequence) {
      subscriber.trigger(theme);
      // Let each loop run through a couple of handles before the next toggle.
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.runAllTimersAsync();

    // After all toggles have drained, every handle's lastKnownTheme should be
    // "light" (the final triggered theme). The handle.reload impl updates
    // lastKnown on each call, so checking it is the cleanest end-state assert.
    for (const h of handles) {
      expect(h.handle.lastKnownTheme, `handle ${h.key} did not reach final theme`).toBe("light");
    }
  });

  it("one handle throwing inside reload does not stop subsequent handles", async () => {
    const subscriber = makeFakeSubscriber();
    const ok = makeHandle("dark");
    const bad: ReThemeableHandle = {
      lastKnownTheme: "dark",
      reload: () => {
        throw new Error("boom");
      },
    };
    const ok2 = makeHandle("dark");
    const onError = vi.fn();
    setupReThemeOrchestrator({
      getHandles: () => [
        ["ok", ok.handle],
        ["bad", bad],
        ["ok2", ok2.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      shuffle: (items) => items,
      onError,
    });

    subscriber.trigger("light");
    await vi.runAllTimersAsync();

    expect(ok.reload).toHaveBeenCalledWith("light");
    expect(ok2.reload).toHaveBeenCalledWith("light");
    expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
  });

  it("cleanup() invalidates the in-flight loop and unsubscribes (HMR-safe)", async () => {
    const subscriber = makeFakeSubscriber();
    const h1 = makeHandle("dark");
    const h2 = makeHandle("dark");
    const { cleanup } = setupReThemeOrchestrator({
      getHandles: () => [
        ["a", h1.handle],
        ["b", h2.handle],
      ],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
      shuffle: (items) => items,
    });

    subscriber.trigger("light");
    await Promise.resolve();
    expect(h1.reload).toHaveBeenCalledTimes(1);

    cleanup();
    expect(subscriber.isSubscribed()).toBe(false);
    expect(subscriber.getCleanupCount()).toBe(1);

    await vi.runAllTimersAsync();
    // h2 was about to be reloaded after the stagger — cleanup aborts it.
    expect(h2.reload).not.toHaveBeenCalled();
  });

  it("re-mounting after a prior cleanup leaves exactly one active subscription", () => {
    const subscriber = makeFakeSubscriber();
    const { cleanup } = setupReThemeOrchestrator({
      getHandles: () => [],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
    });
    expect(subscriber.isSubscribed()).toBe(true);
    cleanup();
    expect(subscriber.isSubscribed()).toBe(false);

    const { cleanup: cleanup2 } = setupReThemeOrchestrator({
      getHandles: () => [],
      subscribe: subscriber.subscribe.bind(subscriber),
      readNow: () => "dark",
      delay: fakeDelay,
    });
    expect(subscriber.isSubscribed()).toBe(true);
    cleanup2();
    expect(subscriber.getCleanupCount()).toBe(2);
  });
});

describe("defaultShuffle", () => {
  it("returns the same elements (no loss, no addition)", () => {
    const input = [1, 2, 3, 4, 5];
    const shuffled = defaultShuffle(input.slice());
    expect(shuffled.slice().sort()).toEqual(input);
  });

  it("handles edge cases without throwing", () => {
    expect(defaultShuffle<number>([])).toEqual([]);
    expect(defaultShuffle([42])).toEqual([42]);
  });
});
