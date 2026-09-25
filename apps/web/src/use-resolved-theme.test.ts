import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// JSDOM is not configured in this repo, so we stub out the minimal DOM surface
// subscribeResolvedTheme touches: `document.documentElement`, `MutationObserver`,
// and `window.matchMedia`. The point is to exercise the dedupe logic, not the
// real DOM.

type Listener = () => void;

class FakeMutationObserver {
  private static instances: FakeMutationObserver[] = [];
  constructor(public callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe() {
    /* noop */
  }
  disconnect() {
    /* noop */
  }
  static fire() {
    for (const i of FakeMutationObserver.instances) i.callback();
  }
  static reset() {
    FakeMutationObserver.instances = [];
  }
}

type FakeMedia = {
  matches: boolean;
  addEventListener: (event: "change", listener: Listener) => void;
  removeEventListener: (event: "change", listener: Listener) => void;
  dispatchChange: () => void;
};

function setupDom(initial: { dataTheme?: "light" | "dark"; prefersDark?: boolean }) {
  FakeMutationObserver.reset();
  const listeners = new Set<Listener>();
  const media: FakeMedia = {
    matches: !!initial.prefersDark,
    addEventListener: (_event, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_event, listener) => {
      listeners.delete(listener);
    },
    dispatchChange: () => {
      for (const l of listeners) l();
    },
  };

  vi.stubGlobal("MutationObserver", FakeMutationObserver);
  vi.stubGlobal("document", {
    documentElement: { dataset: { theme: initial.dataTheme } as Record<string, string | undefined> },
  });
  vi.stubGlobal("window", { matchMedia: () => media });
  return { media };
}

beforeEach(() => {
  // Clean state per test — vi.stubGlobal scope is per-test.
});
afterEach(() => {
  vi.unstubAllGlobals();
  FakeMutationObserver.reset();
});

describe("subscribeResolvedTheme", () => {
  it("emits the callback when the resolved theme actually changes", async () => {
    setupDom({ dataTheme: "dark" });
    const { subscribeResolvedTheme } = await import("./use-resolved-theme.js");
    const callback = vi.fn();
    const cleanup = subscribeResolvedTheme(callback);

    // Switch to light → MutationObserver fires.
    (document.documentElement.dataset as Record<string, string | undefined>).theme = "light";
    FakeMutationObserver.fire();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenLastCalledWith("light");

    cleanup();
  });

  it("dedupes consecutive identical resolved values", async () => {
    setupDom({ dataTheme: "dark" });
    const { subscribeResolvedTheme } = await import("./use-resolved-theme.js");
    const callback = vi.fn();
    const cleanup = subscribeResolvedTheme(callback);

    // No actual change — still on dark.
    FakeMutationObserver.fire();
    FakeMutationObserver.fire();
    expect(callback).not.toHaveBeenCalled();

    // Real change → one call.
    (document.documentElement.dataset as Record<string, string | undefined>).theme = "light";
    FakeMutationObserver.fire();
    expect(callback).toHaveBeenCalledTimes(1);

    // Set again to the SAME (light) value — no extra call.
    FakeMutationObserver.fire();
    expect(callback).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("coalesces simultaneous data-theme and matchMedia events to one callback per resolved change", async () => {
    const { media } = setupDom({ prefersDark: false });
    const { subscribeResolvedTheme } = await import("./use-resolved-theme.js");
    const callback = vi.fn();
    const cleanup = subscribeResolvedTheme(callback);

    // Simulate: user has data-theme unset (system), and the OS theme flips to dark.
    // Both event channels fire in the same tick. Both compute resolved="dark"
    // (the data-theme attr is still unset → matchMedia matches → dark). One emit.
    media.matches = true;
    media.dispatchChange();
    FakeMutationObserver.fire(); // would also resolve to "dark" — must dedupe
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("dark");

    cleanup();
  });

  it("returns a no-op cleanup on non-DOM environments (SSR safety)", async () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("window", undefined);
    const { subscribeResolvedTheme } = await import("./use-resolved-theme.js");
    const cleanup = subscribeResolvedTheme(() => {
      /* noop */
    });
    expect(typeof cleanup).toBe("function");
    cleanup(); // must not throw
  });
});
