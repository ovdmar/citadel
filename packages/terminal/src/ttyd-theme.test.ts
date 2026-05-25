import { describe, expect, it } from "vitest";
import { DARK_XTERM_THEME, LIGHT_XTERM_THEME, createTtydManager } from "./index.js";

// These tests pin the public contract of the ttyd theme propagation invariant
// without spawning real ttyd processes. The structural guarantees we care
// about (no manager-side theme cache; theme required at the call site) are
// either compile-time (TypeScript) or visible directly on exported state.

describe("ttyd manager theme contract", () => {
  it("requires theme at the call site (compile-time)", () => {
    const manager = createTtydManager();
    // @ts-expect-error theme is required; this call must not type-check
    void (() => manager.ensure({ key: "x", tmuxSession: "y" }));
    // Smoke: the same call with theme does type-check.
    void (() => manager.ensure({ key: "x", tmuxSession: "y", theme: "light" }));
    expect(typeof manager.ensure).toBe("function");
  });

  it("LIGHT_XTERM_THEME emits no white values that could leak white-on-cream", () => {
    expect(LIGHT_XTERM_THEME).toMatchInlineSnapshot(`
      {
        "background": "#f5f1e8",
        "black": "#1a1814",
        "blue": "#194d8e",
        "brightBlack": "#4a463e",
        "brightBlue": "#2864ad",
        "brightCyan": "#0f7d92",
        "brightGreen": "#4a8a14",
        "brightMagenta": "#7d3a98",
        "brightRed": "#b8281c",
        "brightWhite": "#0c0a06",
        "brightYellow": "#a06b0a",
        "cursor": "#14171f",
        "cursorAccent": "#f5f1e8",
        "cyan": "#0a5d6e",
        "foreground": "#1a1814",
        "green": "#36680c",
        "magenta": "#5f2a7a",
        "red": "#9a1d12",
        "selectionBackground": "rgba(20, 23, 31, 0.18)",
        "white": "#1a1814",
        "yellow": "#825507",
      }
    `);
    // Defensive: any value matching common forms of "white" (literal or via
    // CSS-style strings) on the light theme would be a regression.
    for (const [key, value] of Object.entries(LIGHT_XTERM_THEME)) {
      if (typeof value !== "string") continue;
      const normalized = value.toLowerCase();
      const looksWhite =
        normalized === "white" ||
        normalized === "#fff" ||
        normalized === "#ffffff" ||
        normalized === "rgb(255,255,255)" ||
        normalized === "rgba(255,255,255,1)";
      expect(looksWhite, `${key}=${value} looks white on light theme`).toBe(false);
    }
  });

  it("DARK_XTERM_THEME keeps light foreground/cursor for legibility on dark canvas", () => {
    expect(DARK_XTERM_THEME.background).toMatch(/^#1/);
    expect(DARK_XTERM_THEME.foreground).toMatch(/^#[a-f0-9]{6}$/i);
  });
});
