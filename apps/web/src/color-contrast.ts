/**
 * WCAG 2.1 contrast helpers for picking a readable foreground against an
 * operator-chosen background (e.g. namespace pills).
 *
 * The historical bug: any user-defined background was painted with white
 * text. When the operator picked a light color, the text disappeared into
 * the surface. This helper picks black or white based on whichever yields
 * the higher contrast ratio against the background, per WCAG 2.1's relative
 * luminance formula.
 */

const HEX_PATTERN = /^#([a-f0-9]{3}|[a-f0-9]{6})$/i;

export type Foreground = "#000" | "#fff";

/**
 * Parse a hex color string into normalized sRGB channels in [0, 1].
 * Accepts 3-digit (#fff) and 6-digit (#ffffff) forms, case-insensitive.
 * Returns null for anything else — callers should fall back defensively.
 */
function parseHex(input: string): [number, number, number] | null {
  const match = HEX_PATTERN.exec(input.trim());
  if (!match) return null;
  let hex = match[1] ?? "";
  if (hex.length === 3) {
    hex = hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return [r / 255, g / 255, b / 255];
}

/** WCAG 2.1 piecewise sRGB → linear-light conversion. */
function srgbToLinear(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. Range [0, 1]; black = 0, white = 1. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick the foreground (#fff or #000) that gives the highest WCAG contrast
 * against `background`. Invalid input → `#000` (defensive: a missed dark
 * accent is less harmful than invisible white-on-white, and our actual
 * caller — the namespace pill — sits on cards that are typically light).
 *
 * The luminance threshold where "white or black is more legible" against
 * an sRGB background sits at L ≈ 0.179 (the point where contrast-vs-white
 * equals contrast-vs-black). We compute both ratios directly so the
 * decision falls out of the math rather than a hard-coded threshold.
 */
export function pickReadableForeground(background: string): Foreground {
  const rgb = parseHex(background);
  if (!rgb) return "#000";
  const [r, g, b] = rgb.map(srgbToLinear) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  return contrastWithBlack >= contrastWithWhite ? "#000" : "#fff";
}
