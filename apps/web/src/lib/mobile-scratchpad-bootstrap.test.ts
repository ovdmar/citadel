import { describe, expect, it, vi } from "vitest";
import { bootstrapLastRoute } from "./last-route.js";
import { bootstrapMobileScratchpad } from "./mobile-scratchpad-bootstrap.js";

describe("bootstrapMobileScratchpad", () => {
  it("rewrites narrow bare-root launches to the scratchpad query", () => {
    const replaceState = vi.fn();
    const result = bootstrapMobileScratchpad(
      { pathname: "/", search: "", hash: "" },
      { replaceState },
      matchMedia(true),
    );

    expect(result).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?scratchpad=1");
  });

  it("leaves wide bare-root launches for last-route restoration", () => {
    const replaceState = vi.fn();
    const result = bootstrapMobileScratchpad(
      { pathname: "/", search: "", hash: "" },
      { replaceState },
      matchMedia(false),
    );

    expect(result).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("wins over saved last-route restoration on narrow bare-root launches", () => {
    const replaceState = vi.fn();
    const location = { pathname: "/", search: "", hash: "" };
    const restored = bootstrapMobileScratchpad(location, { replaceState }, matchMedia(true))
      ? null
      : bootstrapLastRoute(location, { replaceState }, storageWithLastRoute("/settings"));

    expect(restored).toBeNull();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?scratchpad=1");
  });

  it("preserves root deeplinks and non-root routes", () => {
    const replaceState = vi.fn();

    expect(
      bootstrapMobileScratchpad(
        { pathname: "/", search: "?modal=new-workspace", hash: "" },
        { replaceState },
        matchMedia(true),
      ),
    ).toBe(false);
    expect(
      bootstrapMobileScratchpad({ pathname: "/", search: "", hash: "#hash" }, { replaceState }, matchMedia(true)),
    ).toBe(false);
    expect(
      bootstrapMobileScratchpad({ pathname: "/settings", search: "", hash: "" }, { replaceState }, matchMedia(true)),
    ).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

function matchMedia(matches: boolean): (query: string) => Pick<MediaQueryList, "matches" | "media"> {
  return (query: string) => ({ matches, media: query });
}

function storageWithLastRoute(route: string): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  return {
    getItem: () => route,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
}
