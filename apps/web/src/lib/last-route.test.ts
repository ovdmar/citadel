import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapLastRoute, clearLastRoute, isBareRootLanding, loadLastRoute, saveLastRoute } from "./last-route.js";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("last-route storage", () => {
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    storage = memoryStorage();
  });

  it("round-trips a saved route", () => {
    saveLastRoute("/operations?tab=runs", storage);
    expect(loadLastRoute(storage)).toBe("/operations?tab=runs");
  });

  it("clears the saved route", () => {
    saveLastRoute("/operations", storage);
    clearLastRoute(storage);
    expect(loadLastRoute(storage)).toBeNull();
  });

  it("ignores non-absolute hrefs", () => {
    saveLastRoute("https://evil.example/x", storage);
    expect(loadLastRoute(storage)).toBeNull();
  });

  it("rejects protocol-relative paths on save", () => {
    saveLastRoute("//evil.example/x", storage);
    expect(loadLastRoute(storage)).toBeNull();
  });

  it("rejects protocol-relative paths on load even if smuggled in", () => {
    storage.setItem("citadel:lastRoute", "//evil.example/x");
    expect(loadLastRoute(storage)).toBeNull();
  });

  it("rejects backslash-prefixed paths", () => {
    saveLastRoute("/\\evil.example/x", storage);
    expect(loadLastRoute(storage)).toBeNull();
  });

  it("returns null when no value is stored", () => {
    expect(loadLastRoute(storage)).toBeNull();
  });
});

describe("isBareRootLanding", () => {
  it("is true only on /", () => {
    expect(isBareRootLanding({ pathname: "/", search: "", hash: "" })).toBe(true);
    expect(isBareRootLanding({ pathname: "/operations", search: "", hash: "" })).toBe(false);
    expect(isBareRootLanding({ pathname: "/", search: "?x=1", hash: "" })).toBe(false);
    expect(isBareRootLanding({ pathname: "/", search: "", hash: "#a" })).toBe(false);
  });
});

describe("bootstrapLastRoute", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let replaceState: ReturnType<typeof vi.fn>;
  const history = () => ({ replaceState });

  beforeEach(() => {
    storage = memoryStorage();
    replaceState = vi.fn();
  });

  it("restores the saved route when landing on bare /", () => {
    saveLastRoute("/operations?tab=runs", storage);
    const result = bootstrapLastRoute({ pathname: "/", search: "", hash: "" }, history(), storage);
    expect(result).toBe("/operations?tab=runs");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/operations?tab=runs");
  });

  it("does nothing when no saved route exists", () => {
    const result = bootstrapLastRoute({ pathname: "/", search: "", hash: "" }, history(), storage);
    expect(result).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("does nothing when saved route equals /", () => {
    saveLastRoute("/", storage);
    const result = bootstrapLastRoute({ pathname: "/", search: "", hash: "" }, history(), storage);
    expect(result).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("respects a deep-link landing (non-root path)", () => {
    saveLastRoute("/operations", storage);
    const result = bootstrapLastRoute({ pathname: "/settings", search: "", hash: "" }, history(), storage);
    expect(result).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("respects a deep-link landing on / with a query string", () => {
    saveLastRoute("/operations", storage);
    const result = bootstrapLastRoute({ pathname: "/", search: "?workspace=foo", hash: "" }, history(), storage);
    expect(result).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
