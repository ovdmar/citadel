import { describe, expect, it } from "vitest";
import { pickReadableForeground } from "./color-contrast.js";

// relativeLuminance is internal; its behavior is exercised end-to-end through
// pickReadableForeground (the only public export). The cases below pin both
// the foreground choice and — implicitly — the luminance formula's results
// against WCAG reference points (#000 → max contrast with #fff, #fff → max
// contrast with #000, etc.). A regression in the luminance math will flip a
// case here before it ever reaches a caller.

describe("pickReadableForeground", () => {
  it("picks white on pure black and black on pure white", () => {
    expect(pickReadableForeground("#000")).toBe("#fff");
    expect(pickReadableForeground("#000000")).toBe("#fff");
    expect(pickReadableForeground("#fff")).toBe("#000");
    expect(pickReadableForeground("#ffffff")).toBe("#000");
  });

  it("picks black on light colors and white on dark colors", () => {
    // Operator's typical bright pastel pinks/greens/yellows — black wins.
    expect(pickReadableForeground("#ffeb3b")).toBe("#000"); // bright yellow
    expect(pickReadableForeground("#80c8ff")).toBe("#000"); // sky blue
    expect(pickReadableForeground("#bbdefb")).toBe("#000"); // pastel blue

    // Deep saturated reds/blues/purples — white wins.
    expect(pickReadableForeground("#00008b")).toBe("#fff"); // dark blue
    expect(pickReadableForeground("#5f2a7a")).toBe("#fff"); // deep magenta
    expect(pickReadableForeground("#1a1814")).toBe("#fff"); // near-black warm
  });

  it("picks the higher-contrast option on saturated mid-tones", () => {
    // Pure red (#f00) — luminance ≈ 0.213; contrast vs white ≈ 4.0, vs black ≈ 5.25 → black wins.
    expect(pickReadableForeground("#f00")).toBe("#000");
    // Pure blue (#00f) — luminance ≈ 0.072; vs white ≈ 8.6, vs black ≈ 2.4 → white wins.
    expect(pickReadableForeground("#00f")).toBe("#fff");
    // Pure green (#0f0) — luminance ≈ 0.715; clearly favours black.
    expect(pickReadableForeground("#0f0")).toBe("#000");
    // Dark green (#080) — luminance ≈ 0.153; favours white.
    expect(pickReadableForeground("#080")).toBe("#fff");
  });

  it("handles the mid-grey parity point (#888 ≈ L 0.216) deterministically", () => {
    // At the parity point we always return a value, never throw. The
    // contrast values are 3.95 (vs white) and 5.32 (vs black) — black wins.
    expect(pickReadableForeground("#888")).toBe("#000");
  });

  it("falls back to black for malformed input (cannot validate, default to readable on light)", () => {
    expect(pickReadableForeground("oklch(50% 0.1 250)")).toBe("#000"); // not hex
    expect(pickReadableForeground("rgb(255,0,0)")).toBe("#000"); // not hex
    expect(pickReadableForeground("")).toBe("#000");
  });
});
