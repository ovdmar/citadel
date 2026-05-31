// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COLLAPSE_STORAGE_KEY,
  NAVIGATOR_COLLAPSE_EVENT,
  NAVIGATOR_GROUPING_EVENT,
  expandGroupPath,
  publishNavigatorGroupingChanged,
  readCollapsedMap,
  subscribeToCollapseChanges,
  subscribeToGroupingChanges,
} from "./navigator-collapse-store.js";

// happy-dom does not expose a real Storage by default; attach a minimal
// in-memory shim so the store module's getItem/setItem calls have a target.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

describe("navigator-collapse-store", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });

  afterEach(() => {
    window.localStorage.removeItem(COLLAPSE_STORAGE_KEY);
  });

  it("readCollapsedMap returns {} when localStorage is empty", () => {
    expect(readCollapsedMap()).toEqual({});
  });

  it("readCollapsedMap parses the stored JSON", () => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({ "repo=alpha": true }));
    expect(readCollapsedMap()).toEqual({ "repo=alpha": true });
  });

  it("readCollapsedMap returns {} on malformed JSON", () => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, "not json");
    expect(readCollapsedMap()).toEqual({});
  });

  it("expandGroupPath is a no-op when the path is not currently collapsed", () => {
    const before = window.localStorage.getItem(COLLAPSE_STORAGE_KEY);
    expandGroupPath("repo=alpha");
    expect(window.localStorage.getItem(COLLAPSE_STORAGE_KEY)).toBe(before);
  });

  it("expandGroupPath removes the path from the collapsed map and persists", () => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({ "repo=alpha": true, "repo=bravo": true }));
    expandGroupPath("repo=alpha");
    const stored = JSON.parse(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ "repo=bravo": true });
  });

  it("expandGroupPath also expands every ancestor path (uncollapses the whole chain)", () => {
    window.localStorage.setItem(
      COLLAPSE_STORAGE_KEY,
      JSON.stringify({
        "repo=alpha": true,
        "repo=alpha/status=idle": true,
        "repo=bravo": true,
      }),
    );
    expandGroupPath("repo=alpha/status=idle");
    const stored = JSON.parse(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) ?? "{}");
    expect(stored).toEqual({ "repo=bravo": true });
  });

  it("expandGroupPath dispatches a custom event so in-tab listeners can react", () => {
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({ "repo=alpha": true }));
    const handler = vi.fn();
    const unsubscribe = subscribeToCollapseChanges(handler);
    expandGroupPath("repo=alpha");
    expect(handler).toHaveBeenCalled();
    unsubscribe();
  });

  it("subscribeToCollapseChanges returns an unsubscribe that removes the listener", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToCollapseChanges(handler);
    unsubscribe();
    window.dispatchEvent(new CustomEvent(NAVIGATOR_COLLAPSE_EVENT));
    expect(handler).not.toHaveBeenCalled();
  });

  it("publishNavigatorGroupingChanged fires the grouping event so same-tab consumers refresh", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToGroupingChanges(handler);
    publishNavigatorGroupingChanged();
    expect(handler).toHaveBeenCalled();
    unsubscribe();
  });

  it("subscribeToGroupingChanges returns an unsubscribe that removes the listener", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToGroupingChanges(handler);
    unsubscribe();
    window.dispatchEvent(new CustomEvent(NAVIGATOR_GROUPING_EVENT));
    expect(handler).not.toHaveBeenCalled();
  });
});
