import { beforeEach, describe, expect, it } from "vitest";
import { clearLastRoute, isBareRootLanding, loadLastRoute, saveLastRoute } from "./last-route.js";

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
