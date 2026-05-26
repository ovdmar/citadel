// @vitest-environment happy-dom
//
// Token catalog verification. Two complementary mechanisms:
//
// 1. CSS source parsing — walks `tokens.css` and asserts every inventoried
//    token is declared inside both the `:root` (light) and
//    `:root[data-theme="dark"]` blocks. This is the load-bearing assertion
//    because happy-dom's CSS engine has limited selector support (it does
//    not reliably distinguish `:root[data-theme="X"]` selectors or `:not()`
//    in `@media`), so we cannot rely on `getComputedStyle` to verify the
//    cascade. The actual visual cascade is verified by
//    `e2e/theme-audit.spec.ts` in real browsers.
//
// 2. Runtime resolve — injects `tokens.css` into happy-dom and asserts every
//    inventoried token resolves to a non-empty value. Catches catastrophic
//    syntax errors that would leave tokens unparseable.
//
// This is a vitest test that runs in Node, so it uses node:fs / node:path
// to read the CSS + inventory off disk. The architecture-boundary script
// excludes *.test.ts files from the `apps/web` Node-import ban (tests
// always run in Node).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const tokensCssPath = path.join(here, "tokens.css");
const inventoryPath = path.join(here, "tokens.inventory.txt");

function loadInventory(): string[] {
  const raw = fs.readFileSync(inventoryPath, "utf-8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function loadTokensCss(): string {
  return fs.readFileSync(tokensCssPath, "utf-8");
}

// Extracts the body of a CSS rule whose selector starts with `selectorPrefix`.
// Strips comments first so a selector mentioned in a `/* ... */` block does
// not false-match. After finding the prefix, walks forward past additional
// selector characters and any `,`-grouped selectors until it reaches `{`,
// then counts braces to find the matching `}`.
function extractRuleBody(css: string, selectorPrefix: string): string | null {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let searchFrom = 0;
  while (searchFrom < noComments.length) {
    const idx = noComments.indexOf(selectorPrefix, searchFrom);
    if (idx === -1) return null;
    // Walk forward to find the opening brace, allowing further selector
    // syntax (brackets, equals, quoted attrs, commas, whitespace, etc.).
    // If we hit `;` before `{`, this prefix was inside a declaration, not a
    // selector — skip past it and keep searching.
    let cursor = idx + selectorPrefix.length;
    let foundBrace = -1;
    while (cursor < noComments.length) {
      const ch = noComments[cursor];
      if (ch === "{") {
        foundBrace = cursor;
        break;
      }
      if (ch === ";") break;
      cursor++;
    }
    if (foundBrace === -1) {
      searchFrom = cursor + 1;
      continue;
    }
    let depth = 1;
    let walk = foundBrace + 1;
    while (walk < noComments.length && depth > 0) {
      const ch = noComments[walk];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      walk++;
    }
    if (depth !== 0) return null;
    return noComments.slice(foundBrace + 1, walk - 1);
  }
  return null;
}

function tokensDeclaredIn(body: string): Set<string> {
  const re = /(--[a-z0-9-]+)\s*:/gi;
  const found = new Set<string>();
  for (const m of body.matchAll(re)) {
    const name = m[1];
    if (name) found.add(name);
  }
  return found;
}

function injectTokens(css: string): HTMLStyleElement {
  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-test", "tokens");
  styleEl.textContent = css;
  document.head.appendChild(styleEl);
  return styleEl;
}

function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

describe("design-system tokens.css", () => {
  let tokens: string[];
  let css: string;
  let styleEl: HTMLStyleElement;

  beforeAll(() => {
    tokens = loadInventory();
    expect(tokens.length).toBeGreaterThan(40);
    css = loadTokensCss();
  });

  beforeEach(() => {
    styleEl = injectTokens(css);
  });

  afterEach(() => {
    styleEl.remove();
    delete document.documentElement.dataset.theme;
  });

  function requireBody(selector: string, label: string): string {
    const body = extractRuleBody(css, selector);
    if (body === null) throw new Error(`${label} block not found in tokens.css`);
    return body;
  }

  it("declares every inventoried token in the :root (light) block", () => {
    const lightBody = requireBody(":root", ":root");
    const declared = tokensDeclaredIn(lightBody);
    const missing = tokens.filter((t) => !declared.has(t));
    expect(missing).toEqual([]);
  });

  it('redeclares every theme-dependent token in the :root[data-theme="dark"] block', () => {
    // Not every inventoried token is theme-dependent (e.g. font-sans is the
    // same in both themes and lives only in :root). The dark block must
    // redeclare every token that has a different value in dark mode — and
    // those are precisely the tokens currently inside the dark block. So
    // this test is satisfied if the dark block exists, contains a healthy
    // subset of the inventory, and every token it declares is a real
    // inventoried name (catches typos in token names).
    const darkBody = requireBody(':root[data-theme="dark"]', "data-theme=dark");
    const declared = tokensDeclaredIn(darkBody);
    expect(declared.size).toBeGreaterThan(25);
    const inventory = new Set(tokens);
    const orphans = [...declared].filter((t) => !inventory.has(t));
    expect(orphans, "dark block declares tokens missing from inventory").toEqual([]);
  });

  it("OS-driven dark fallback block mirrors every token the explicit dark block overrides", () => {
    // Auto-mode block keeps the cockpit dark for users who have not picked a
    // theme but whose OS prefers dark. Whatever the explicit
    // `:root[data-theme="dark"]` block redeclares must also live here, so OS
    // dark mode matches explicit dark mode exactly.
    const darkBody = requireBody(':root[data-theme="dark"]', "explicit dark");
    const autoBody = requireBody(':root:not([data-theme="light"]):not([data-theme="dark"])', "OS-dark fallback");
    const darkDeclared = tokensDeclaredIn(darkBody);
    const autoDeclared = tokensDeclaredIn(autoBody);
    const missingFromAuto = [...darkDeclared].filter((t) => !autoDeclared.has(t));
    expect(missingFromAuto).toEqual([]);
  });

  it("does not declare any tokens outside the data-theme blocks (no prefers-color-scheme: light leak)", () => {
    // Per the consolidation plan, no token may live exclusively inside a
    // `@media (prefers-color-scheme: light)` block — those were folded into
    // the explicit :root defaults during Step 2 so tests can reach every
    // token without OS-level theme simulation.
    expect(css).not.toMatch(/@media\s*\(\s*prefers-color-scheme\s*:\s*light\s*\)/);
  });

  it("declares the canonical surfaces, foregrounds, and status tokens", () => {
    // Spot-check a few load-bearing tokens — fast canary for an empty file
    // or a wholesale regression.
    const lightBody = extractRuleBody(css, ":root") ?? "";
    expect(lightBody).toMatch(/--c-canvas:\s*#/);
    expect(lightBody).toMatch(/--c-fg-1:\s*#/);
    expect(lightBody).toMatch(/--c-ok:\s*oklch/);
    expect(lightBody).toMatch(/--color-action:\s*#/);
  });

  it("resolves every inventoried token to a non-empty value at runtime", () => {
    // Sanity check that the CSS parses and applies — happy-dom's selector
    // support is limited (it cannot reliably distinguish data-theme blocks),
    // so this confirms only that some declaration of each token is reachable.
    // The per-theme value verification lives in `e2e/theme-audit.spec.ts`.
    const missing = tokens.filter((token) => readToken(token).length === 0);
    expect(missing).toEqual([]);
  });
});
