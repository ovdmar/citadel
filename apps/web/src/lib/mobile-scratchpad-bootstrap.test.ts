import { describe, expect, it, vi } from "vitest";
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
