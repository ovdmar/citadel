import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard: forbid `color: white|#fff|rgb(255,255,255)|hsl(0,0%,100%)|oklch(100% …)`
// outside of two safe contexts:
//   1. The rule is gated by `[data-theme="dark"]` or `[data-cit-on-dark="true"]`
//      — white text is correct on those (deliberately-dark) surfaces.
//   2. The rule is in the explicit allowlist below — saturated danger/error
//      buttons (red/orange) where white text is the established pattern in
//      both themes. These are baselined here so any NEW white-on-light leak
//      is loud, but the existing intentional uses stay green.
//
// Limits documented up front so future maintainers don't expect more than the
// test delivers:
//   - The test does NOT resolve CSS variables. A `--c-on-dark: #fff` used in
//     a light context would slip through. (We don't currently do this, but the
//     test cannot prove we won't.)
//   - The test scans `*.css` rule-by-rule (split on `}`). Highly nested or
//     malformed CSS could confuse the split — fix the CSS, not the test.
//   - For `.tsx` files we look for inline `color: "#fff"` / `color: 'white'`
//     style props; anything indirected through a constant or computed expression
//     is invisible to a regex. That's fine — those are caught at code review.
//
// The actual user-facing AC is "no white text on a LIGHT canvas anywhere in
// the cockpit or xterm". This test catches the regression class for the four
// representative CSS files we audited; full coverage lives in Playwright.

// Match `color:` followed by any common form of pure white:
//   - literal `white`
//   - 3, 4, 6, or 8-digit all-F hex (#fff, #ffff, #ffffff, #ffffffff)
//   - rgb(255,255,255) / rgba(255,255,255,…)
//   - hsl(0,0%,100%)
//   - oklch(100% 0 0 …) — only flags 100% lightness with zero chroma
const WHITE_PATTERN =
  /color\s*:\s*(?:white\b|#(?:fff|ffff|ffffff|ffffffff)\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,[^)]+\)|hsl\(\s*0\s*,\s*0%\s*,\s*100%\s*\)|oklch\(\s*100%\s+0[^)]*\))/i;

const DARK_GATE_PATTERN = /\[data-(theme="dark"|cit-on-dark="true")\]/;

/** Class names whose rules legitimately paint white text on a saturated background.
 *  Each entry must include a citation (file + selector) so reviewers can verify.
 *  Only add entries here when the background is a saturated color whose own
 *  contrast with white is acceptable in BOTH cockpit themes. */
const ALLOWLISTED_SELECTORS = new Set([
  // cockpit-extras.css — danger drop-confirm button on var(--color-danger) red.
  ".drop-workspace-confirm",
  // modals.css — danger-action variant on var(--color-danger) red.
  ".danger-action",
  // scheduled-agents-shell.css — danger confirm on var(--c-bad) red.
  ".sched-delete-confirm",
  // inspector-meta.css — avatar circle text on a generated saturated color.
  ".ins-av",
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));

function scanCssFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  const violations: string[] = [];
  // Naive rule split — adequate for the cockpit's flat CSS.
  const ruleBlocks = content.split("}");
  for (const block of ruleBlocks) {
    if (!WHITE_PATTERN.test(block)) continue;
    if (DARK_GATE_PATTERN.test(block)) continue;
    const selectorRaw = (block.split("{")[0] ?? "").trim();
    const allowlisted = Array.from(ALLOWLISTED_SELECTORS).some((sel) =>
      selectorRaw.split(",").some((s) => s.trim().includes(sel)),
    );
    if (allowlisted) continue;
    violations.push(`${path.basename(filePath)}: ${selectorRaw}`);
  }
  return violations;
}

function scanTsxFile(filePath: string): string[] {
  const content = fs.readFileSync(filePath, "utf8");
  const violations: string[] = [];
  // Inline style props: `style={{ ..., color: "#fff" }}` or `color: 'white'`.
  // We deliberately allow `color: pickReadableForeground(...)` — that's the fix.
  const inlinePattern = /color\s*:\s*['"](#fff(?:[a-f0-9]{3})?|#ffffff|white)['"]/gi;
  let match = inlinePattern.exec(content);
  while (match) {
    const line = content.slice(0, match.index).split("\n").length;
    violations.push(`${path.basename(filePath)}:${line}: ${match[0]}`);
    match = inlinePattern.exec(content);
  }
  return violations;
}

describe("no white text on light backgrounds (regression guard)", () => {
  it("no .css file in apps/web/src emits white text outside dark-gated or allowlisted rules", () => {
    const files = fs
      .readdirSync(HERE)
      .filter((name) => name.endsWith(".css"))
      .map((name) => path.join(HERE, name));
    const allViolations = files.flatMap(scanCssFile);
    expect(allViolations).toEqual([]);
  });

  it("no .tsx file in apps/web/src has an inline color: white style prop", () => {
    const files = fs
      .readdirSync(HERE)
      .filter((name) => name.endsWith(".tsx"))
      .map((name) => path.join(HERE, name));
    const allViolations = files.flatMap(scanTsxFile);
    expect(allViolations).toEqual([]);
  });

  it("rejects the white-color CSS patterns the regression guard claims to catch", () => {
    // Tiny meta-test so a future regex refactor that accidentally weakens
    // the pattern shows up here, not silently in green CSS tests.
    expect(WHITE_PATTERN.test("color: white")).toBe(true);
    expect(WHITE_PATTERN.test("color: #fff")).toBe(true);
    expect(WHITE_PATTERN.test("color: #ffffff")).toBe(true);
    expect(WHITE_PATTERN.test("color: #ffff")).toBe(true); // 4-hex form (RGBA)
    expect(WHITE_PATTERN.test("color: rgb(255, 255, 255)")).toBe(true);
    expect(WHITE_PATTERN.test("color: rgba(255, 255, 255, 0.9)")).toBe(true);
    expect(WHITE_PATTERN.test("color: hsl(0, 0%, 100%)")).toBe(true);
    expect(WHITE_PATTERN.test("color: oklch(100% 0 0)")).toBe(true);
    // Negative: var(--c-on-dark) is fine — token's value is theme-gated upstream.
    expect(WHITE_PATTERN.test("color: var(--c-on-dark)")).toBe(false);
    // Negative: #fefefe (off-white but not actually #fff*) does not match.
    expect(WHITE_PATTERN.test("color: #fefefe")).toBe(false);
  });
});
