import { describe, expect, it, vi } from "vitest";
import { applyBootstrapNavigation } from "./bootstrap-redirect.js";

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

function locOf(href: string) {
  // href may be "/" | "/foo?bar=1" | "/?modal=x" | "/foo#frag"
  const hashIdx = href.indexOf("#");
  const hash = hashIdx >= 0 ? href.slice(hashIdx) : "";
  const noHash = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
  const qIdx = noHash.indexOf("?");
  const search = qIdx >= 0 ? noHash.slice(qIdx) : "";
  const pathname = qIdx >= 0 ? noHash.slice(0, qIdx) : noHash;
  return { pathname, search, hash };
}

describe("applyBootstrapNavigation — mobile redirect wins over saved last-route", () => {
  it("narrow viewport + bare root + saved /settings → URL becomes /scratchpad (mobile wins)", () => {
    const history = { replaceState: vi.fn() };
    const storage = memoryStorage({ "citadel:lastRoute": "/settings" });
    applyBootstrapNavigation({ location: locOf("/"), history, storage, narrow: true });
    expect(history.replaceState).toHaveBeenCalledWith({}, "", "/scratchpad");
    expect(history.replaceState).toHaveBeenCalledTimes(1);
  });

  it("wide viewport + bare root + saved /settings → URL becomes /settings (bootstrap wins)", () => {
    const history = { replaceState: vi.fn() };
    const storage = memoryStorage({ "citadel:lastRoute": "/settings" });
    applyBootstrapNavigation({ location: locOf("/"), history, storage, narrow: false });
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/settings");
  });

  it("narrow viewport + /?modal=new-workspace → URL untouched (deeplink wins over mobile default)", () => {
    const history = { replaceState: vi.fn() };
    const storage = memoryStorage();
    applyBootstrapNavigation({ location: locOf("/?modal=new-workspace"), history, storage, narrow: true });
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("narrow viewport + deep path (/settings) → URL untouched", () => {
    const history = { replaceState: vi.fn() };
    const storage = memoryStorage();
    applyBootstrapNavigation({ location: locOf("/settings"), history, storage, narrow: true });
    expect(history.replaceState).not.toHaveBeenCalled();
  });

  it("wide viewport + bare root + no saved route → URL untouched", () => {
    const history = { replaceState: vi.fn() };
    const storage = memoryStorage();
    applyBootstrapNavigation({ location: locOf("/"), history, storage, narrow: false });
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
