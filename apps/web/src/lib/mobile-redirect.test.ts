import { describe, expect, it } from "vitest";
import { mobileScratchpadRedirect } from "./mobile-redirect.js";

const loc = (pathname: string, search = "", hash = "") => ({ pathname, search, hash });

describe("mobileScratchpadRedirect", () => {
  it("redirects to /scratchpad only when the URL is bare AND the viewport is narrow", () => {
    expect(mobileScratchpadRedirect(loc("/"), true)).toBe("/scratchpad");
  });

  it("returns null when the viewport is wide", () => {
    expect(mobileScratchpadRedirect(loc("/"), false)).toBeNull();
  });

  it("returns null when the path is not the bare root", () => {
    expect(mobileScratchpadRedirect(loc("/scratchpad"), true)).toBeNull();
    expect(mobileScratchpadRedirect(loc("/settings"), true)).toBeNull();
    expect(mobileScratchpadRedirect(loc("/operations"), true)).toBeNull();
  });

  it("returns null when the root carries a query string (regression: ?modal=new-workspace must NOT be eaten on mobile)", () => {
    expect(mobileScratchpadRedirect(loc("/", "?modal=new-workspace"), true)).toBeNull();
    expect(mobileScratchpadRedirect(loc("/", "?anything=x"), true)).toBeNull();
  });

  it("returns null when the root carries a hash fragment", () => {
    expect(mobileScratchpadRedirect(loc("/", "", "#foo"), true)).toBeNull();
  });
});
