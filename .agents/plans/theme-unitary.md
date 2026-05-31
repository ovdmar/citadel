Activate the /implement-task skill first.

# Plan: Theming — unified cockpit + xterm pass

## Acceptance Criteria

Verbatim from the scratchpad assignment + user clarifications.

- [ ] Theme selector is a **single button** that cycles three states: Light → Dark → System → Light. The icon reflects the current state (Sun / Moon / Monitor). Aria-label / tooltip names the current mode and what the next click will do. Persisted to `localStorage["citadel.theme"]` (same key as today).
- [ ] **No white text on a light background anywhere in the cockpit or xterm.** Light theme remains the existing warm-cream surface (canvas `#ece7da`); the bug is white text leaking through, not the canvas color.
- [ ] **Toggling theme re-themes every currently-open terminal in place.** No `window.confirm` prompt. No full cockpit reload. The respawn is staggered so it cannot regress the ttyd cleanup-storm history (see project memory).
- [ ] xterm no longer "starts correct, then randomly falls back to the other theme mid-session." Root cause is identified in the same PR; the fix is **a single source of truth**: the daemon's existing `ThemePrefStore` is the only persistence layer, and `ttyd.ensure()` requires an explicit `theme` (no silent `"dark"` fallback).
- [ ] Jira chip stays legible in BOTH cockpit themes AND on dark workspace surfaces inside a light cockpit. Targeted fix (chip variant), not a design-system primitive.

## Context and problem statement

Five tightly-related theming items, shipped as one PR per the user's scope decision.

**What exists today**

- `apps/web/src/theme-controls.tsx` renders three separate buttons (Monitor/Sun/Moon) and uses `window.confirm("Theme updated… reload now?")` on every change, followed by `window.location.reload()` if confirmed.
- `apps/web/src/use-resolved-theme.ts` resolves `system` to `light|dark` from `data-theme` on `<html>` + `matchMedia`, and re-fires on either source changing.
- `apps/web/src/terminal-pane.tsx` captures `useResolvedTheme()` into a ref, ships the resolved theme to the daemon as `?theme=…` only on the next ensure call, and exposes a `reload()` that the tab actions can call to force a respawn (`ensure({ force: true, bumpFrame: true })`).
- `apps/daemon/src/terminal-routes.ts` already persists `sessionId → theme` to a disk-backed `ThemePrefStore` sidecar (`<dataDir>/terminal-theme-prefs.json`). The route at lines 196-203 sources `theme ?? themePreferences.get(sessionId)` before calling `ensureWithHeal`. The `reviveProxyTarget` heal path (line 150) does the same. **This is already the single source of truth on the daemon side** — the gap is downstream.
- `packages/terminal/src/ttyd.ts` `ensure()` declares `theme?: TtydTheme` as **optional** with `const desiredTheme: TtydTheme = args.theme ?? "dark"` at line 101. **This silent default is the actual regression risk** — any new internal heal path or refactor that omits the theme arg silently spawns dark. Splitting the source of truth across two layers (daemon-side store + a manager-side cache) would re-create the original bug. The fix is to *tighten the signature*: make `theme` required, force every caller to explicitly source it from the daemon's `ThemePrefStore` (already done for the two production paths).
- `LIGHT_XTERM_THEME` (lines 286-308) already remaps `white` (ansi 7) and `brightWhite` (ansi 15) to dark values so a program that prints white doesn't disappear into the cream. Cockpit CSS still contains four hard `color: white` / `color: #fff` declarations: `inspector-meta.css:202`, `cockpit-extras.css:362`, `modals.css:511`, `scheduled-agents-shell.css:402` — each must be audited. Plus `workspace-card.tsx:185` (inline `color: "#fff"` on namespace pill).
- The Jira chip in `apps/web/src/inspector-stats.css` themes some elements off `[data-theme="dark"]` (e.g. `.cit-jira-key`, `.cit-jira-status--*`) but has no concept of a **local** dark surface.

**What needs to change**

1. **Theme selector** — collapse to a single cycling button.
2. **Light-theme legibility** — fix every `color: white|#fff` declaration that lands on a light canvas. Verify the xterm palette emits nothing white in the light branch.
3. **Live re-theme of open terminals** — drop the `window.confirm`, drop the `window.location.reload()`. Mount an orchestrator at the cockpit root that subscribes to the **same channel as `useResolvedTheme`** (covers both button clicks AND OS theme flips), iterates the existing `TerminalPane` registry, passes the new theme **explicitly** to each handle's `reload(theme)` (no `themeRef` race), and staggers respawns. Coalesce rapid toggles with a sequence token.
4. **xterm fallback bug** — **single source of truth.** Tighten `ttyd.ensure()` so `theme` is required (no `?? "dark"` default). Audit every call site and confirm it sources from the daemon's `ThemePrefStore` (production paths already do). Remove the silent default; if a caller has no theme to pass, that's a bug, not a silent dark spawn. Daemon-side `themePreferences.set(sessionId, theme)` already fires on every `?theme=…` query — and item 3's orchestrator will now hit the route for every open terminal on every cockpit toggle, so the store stays current.
5. **Jira chip** — add `data-cit-on-dark="true"` (namespaced) on parent surfaces that are deliberately dark regardless of cockpit theme; add corresponding chip overrides in `inspector-stats.css`. Verify across both cockpit themes.

## Spec alignment

Reading from the extension's spec-mapping, every globbed area is touched:

- `apps/web/**` → `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md`
- `packages/terminal/**`, daemon terminal plumbing → `specs/B.3-agent-sessions-terminal.md`

Findings:

- **B.8 UI #5** (`The UI has theme support`) is the live AC. **Spec update required** (Spec gate) to record the now-invariant behaviors introduced by this PR: single-button cycling selector, live re-theme without reload, theme propagation invariant across respawns. First implementation step (see below).
- **B.2 cockpit chrome** — spec update on the theme controls being a single cycling button rather than three buttons.
- **B.8 UI #12** declares the default theme as "dark-blue v1-inspired palette: deep navy/slate background, lighter slate panels, cyan/sky accent". The current implementation uses a warm dark (`#15130f` canvas) — a **pre-existing divergence** unrelated to this PR. **Out of scope per user** ("Do NOT change the cockpit canvas color"). No spec update proposed here; flag for a separate decision when the warm/navy direction is finalized.
- **B.3 Terminal #4-12** unchanged. The live-respawn-on-toggle work happens at the cockpit layer + via the same daemon route that already exists; no new contract.
- Domain glossary: language used in the plan and code (Workspace, Agent session, Terminal) matches `specs/A-shared-definitions.md`.

## Implementation approach

**Picked approach: ship all five items as one cohesive PR with a sequenced implementation order.**

Order matters because items 3 and 4 share plumbing (both touch how the theme reaches a ttyd respawn); doing 4 first means item 3's live-respawn inherits the corrected propagation for free.

0. **Spec updates first** (Spec gate). Update `specs/B.8-ui-performance-quality.md` item #5 with the live re-theme invariant + propagation contract; update `specs/B.2-ade-cockpit.md` with the single-button cycling selector behavior.
1. **Item 4 first — tighten `ttyd.ensure()` to require `theme`.** Single source of truth restored. Make `theme: TtydTheme` (not optional). Remove the `?? "dark"` default. Audit every call site (terminal-routes.ts heal + revive paths, any test mock) and ensure each passes a theme sourced from the daemon's `ThemePrefStore`. Add a regression test that the type signature now refuses callers without a theme.
2. **Item 1 — single cycling button.** Pure cockpit-side rewrite of `theme-controls.tsx`. No dependency on the others.
3. **Item 2 — white-text audit.** CSS-only + one `.tsx` inline style; touches four CSS files plus xterm palette confirmation. No dependency on the others.
4. **Item 3 — live re-theme.** Replaces the confirm/reload UX. Mounts an orchestrator at the cockpit root that subscribes to the same channel as `useResolvedTheme` (so OS theme flips trigger re-theme too). Calls each registered terminal handle's `reload(theme)` with the new theme passed **explicitly**. Staggers respawns. Coalesces rapid toggles with a sequence token. Skips no-op changes (idempotent).
5. **Item 5 — Jira chip dark-bg variant.** Add `data-cit-on-dark="true"` (namespaced — matches `.cit-*` convention) on the active workspace card and any deliberately-dark inspector pane; add CSS overrides. Verify across both cockpit themes.

**Why this approach:** locks down the propagation invariant (no respawn ever drops to "dark" by accident, ever) before stacking new respawn paths on top of it.

### Migration strategy

No schema changes. The `ThemePrefStore` JSON sidecar already exists at `<dataDir>/terminal-theme-prefs.json`; this PR does not alter its format. No new in-memory cache is added (we deliberately collapse to a single source of truth). Confirmed: no DB tables, no `schema_migrations` row needed, `PRAGMA foreign_keys` unaffected.

## Alternatives considered

1. **Split into two PRs (visuals now / behavior later).** Rejected: user explicitly chose "all five in one PR".
2. **Auto-respawn only the focused terminal (lazy for background tabs).** Rejected during clarification.
3. **Add a manager-side `lastRequested` cache as a second persistence layer.** Rejected during review: creates a dual source of truth with the daemon's `ThemePrefStore`, undefined precedence, and a race in `release()` wipe. The chosen single-source-of-truth approach (tighten `ensure()` signature, daemon's store is canonical) eliminates the class entirely.
4. **Contrast-aware chip primitive for item 5.** Rejected during clarification.
5. **Browser-side defensive fix for item 4.** Rejected: pushes the invariant to the wrong layer.
6. **Spike then ship item 4 as a separate PR.** Rejected: the spike's findings are tractable; folding into this PR avoids re-onboarding context twice.

## Implementation steps

Grouped by logical unit. Each unit becomes one "Implement: [unit]" task in the implementation session. TDD: tests in each unit land in the **same commit** as the implementation so CI is never red mid-PR.

### Unit 0 — Spec updates (Spec gate)

- Update `specs/B.8-ui-performance-quality.md` item #5: change `[ ]` to `[~]` (in-progress) and annotate: "Theme has three states — light, dark, system. Toggling re-themes the cockpit AND every open terminal in place without reloading. Theme propagation through to `ttyd.ensure()` is a hard invariant: callers must source from the daemon's `ThemePrefStore`; the manager rejects calls without an explicit theme."
- Update `specs/B.2-ade-cockpit.md`: add a short note on the cycling theme selector (single button, three states) under the cockpit chrome section.
- No spec tests; spec files are documentation.

### Unit A — Tighten `ttyd.ensure()` + `parseTheme` (Item 4 — xterm fallback root cause)

- In `packages/terminal/src/ttyd.ts`:
  - Change `theme?: TtydTheme` to `theme: TtydTheme` on the `ensure()` argument type (both the public interface and the internal function).
  - Remove the `const desiredTheme: TtydTheme = args.theme ?? "dark"` line. Use `args.theme` directly.
  - No new state — no `lastRequested` map. The daemon's `ThemePrefStore` remains the single source of truth.
- In `apps/daemon/src/terminal-routes.ts`:
  - Audit `ensureWithHeal` (currently line 161-190): both call sites at line 173 and line 188 use spread `...(theme ? { theme } : {})` to optionally include `theme`. Change to **always** pass theme — sourced from `parseTheme(req.query.theme) ?? themePreferences.get(sessionId) ?? "dark"`. The trailing `"dark"` here is a documented last-resort default for the very-first ensure() before the cockpit has set anything; it lives at the boundary (HTTP route), NOT in the manager. **Log a warning** (`console.warn("[terminal] no theme available for session <id>, defaulting to dark — this is a bug if it happens after first paint")`) whenever the trailing fallback fires, so any regression that empties the store is loud, not silent.
  - **Tighten `parseTheme`** (currently silent `undefined` for unknown values): when `value` is present but unrecognized (e.g. cockpit accidentally sends `"system"`), log a warning with the raw value before returning `undefined`. This closes the parallel-gap to the manager tightening — both layers fail loudly on unexpected input.
  - The cockpit `useResolvedTheme()` resolves before sending `?theme=…`, so in practice the trailing fallback should never fire in production except on a brand-new session where ttyd is somehow ensure()'d before the cockpit makes its first call (rare; revive path).
- Audit every other ttyd.ensure() call site via `grep -rn "ttyd\.ensure\|\.ensure({" apps/ packages/` — none should exist outside `terminal-routes.ts` and `ttyd.test.ts`.
- Tests in `packages/terminal/src/ttyd.test.ts` (or new `ttyd-theme.test.ts` — verify presence at impl time):
  - **Type-level test (compile-time):** the type signature refuses a call without `theme` — a `// @ts-expect-error` line proves this.
  - **Cross-session isolation:** `ensure({key:'A', theme:'light'})` then `ensure({key:'B', theme:'dark'})` produces two ttyd processes; neither's stored theme leaks. (This is trivial under the new design because there's no manager-side per-key state.)
  - **Explicit-respawn:** `ensure({key:'A', theme:'light'})` then `ensure({key:'A', force:true, theme:'dark'})` respawns dark.
- Tests in `apps/daemon/src/terminal-routes.test.ts`:
  - **Reconnect precedence:** with a populated `ThemePrefStore` for session A = light, simulate a daemon-side `reviveProxyTarget` call; assert the spawn args include `LIGHT_XTERM_THEME`.
  - **Boundary fallback warning (SUGGESTION G):** with empty `ThemePrefStore` and no `?theme=` query, the route call ensures with `"dark"` AND emits the warning (spy on `console.warn`).
  - **`parseTheme` warning:** call with `value="system"`; assert it returns `undefined` AND logs a warning.

### Unit B — Cockpit theme selector: single cycling button (Item 1)

- Rewrite `apps/web/src/theme-controls.tsx`:
  - Replace three buttons with one `<button>` whose icon is Sun / Moon / Monitor depending on the current selection.
  - Click cycles Light → Dark → System → Light.
  - `aria-label` includes the current mode AND the next mode (e.g. "Theme: Light. Click for Dark.") — announced by screen readers.
  - `title` (tooltip) mirrors the aria-label.
  - Persistence key unchanged: `localStorage["citadel.theme"]`. Initial state read order: localStorage → "system". `normalize()` helper rejects unknown values and falls back to "system".
  - **Remove** the `window.confirm` and `window.location.reload()` block. The live re-theme orchestrator (Unit D) handles open-terminal updates.
- Tests in `apps/web/src/theme-controls.test.tsx` (new file):
  - Click cycle: Light → Dark → System → Light.
  - Icon swaps correctly per state.
  - `data-theme` on `<html>` is `"light"`, `"dark"`, or absent after each click.
  - `localStorage["citadel.theme"]` matches active mode after each click.
  - `aria-label` and `title` reflect current + next mode.
  - `normalize()` falls back to "system" for unknown localStorage values.

### Unit C — White-text audit (Item 2)

- Inspect each hit from `apps/web/src/*.css` where `color: white | #fff | #ffffff` appears:
  - `apps/web/src/inspector-meta.css:202` — small chip badge text. Replace with `var(--c-on-dark)` only if the badge background is `var(--c-dark)` (dark-on-light); else replace with a contrast-safe token. Verify by reading the immediate ruleset's `background`.
  - `apps/web/src/cockpit-extras.css:362` — same audit.
  - `apps/web/src/modals.css:511` — `color: white !important` is a red flag; check the modal's background. If always-dark surface, swap to `var(--c-on-dark)`.
  - `apps/web/src/scheduled-agents-shell.css:402` — same audit.
- Inline TSX style audit: `apps/web/src/workspace-card.tsx:185` — `style={{ background: namespace.color, color: "#fff" }}`. Replace with `pickReadableForeground(namespace.color)`. Implementation in new `apps/web/src/color-contrast.ts`:
  - Use WCAG 2.1 relative luminance formula. `srgbToLinear(c) = c <= 0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`. Luminance `L = 0.2126*R + 0.7152*G + 0.0722*B`. Per WCAG 2.1, contrast ratio against white = `(1.05) / (L + 0.05)`, against black = `(L + 0.05) / 0.05`. Pick black if contrast-against-black ≥ contrast-against-white, else white. Threshold for the parity point: L ≈ 0.179. Reference impl: `pickReadableForeground(hex: string): "#fff" | "#000"`.
  - Handle 3-digit hex (`#fff`), 6-digit hex (`#ffffff`), case-insensitive. Return `"#000"` for invalid input (defensive).
- Verify `LIGHT_XTERM_THEME` in `packages/terminal/src/ttyd.ts`: confirm `cursorAccent` (`#f5f1e8`, light cream) does NOT produce a white cursor — it's the *block under the cursor's text*, expected to match background. Confirm `selectionBackground` (translucent dark) does not leak white. Confirm no field defaults to a white value via xterm.js own defaults — explicitly set any missing field if so. **Add a snapshot test** that pins `LIGHT_XTERM_THEME` so a future xterm.js semantics change is a CI signal.
- **Regression guard** as a Vitest test (avoids new check script + Makefile change). New file `apps/web/src/__tests__/no-white-on-light.test.ts`:
  - Glob `apps/web/src/**/*.css` + `apps/web/src/**/*.tsx`.
  - Regex: `color:\s*(white\b|#fff\b|#fff[a-f0-9]{3}\b|#ffffff\b|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\)|rgba\(\s*255\s*,\s*255\s*,\s*255\s*,[^)]+\)|hsl\(\s*0\s*,\s*0%\s*,\s*100%\s*\)|oklch\(\s*100%\s*[^)]+\))` (white in any common form).
  - Walk each match's containing block (CSS) or JSX (TSX). Allowlist:
    - Inside a `[data-theme="dark"]` or `[data-cit-on-dark="true"]` selector chain.
    - Inside a `style={{ color: pickReadableForeground(...) }}` computed value.
  - Fail with file:line of every disallowed match. Initial run is red (4 CSS hits + 1 TSX hit); turns green after Unit C lands.
  - **Documented limits:** does not resolve CSS variables (a hypothetical `--c-on-dark: #fff` used in light context would slip through); not a substitute for browser verification.
- Tests:
  - `apps/web/src/__tests__/no-white-on-light.test.ts` (new) — described above.
  - `apps/web/src/color-contrast.test.ts` (new) — `pickReadableForeground` cases: `#000` → `#fff`; `#fff` → `#000`; `#888` → assert WCAG-preferred (computed against both — should pick `#000` because 4.5+ for mid-grey is closer to white reference; document expected value in test); `#f00` (red, L≈0.213) → `#000`; `#00f` (blue, L≈0.072) → `#fff`; `#080` (dark green) → `#fff`; `#0f0` (bright green) → `#000`; malformed input → `#000`.
  - `packages/terminal/src/ttyd.test.ts` or `ttyd-theme.test.ts` — snapshot of `LIGHT_XTERM_THEME`.

### Unit D — Live re-theme of running terminals (Item 3)

- Extend `apps/web/src/use-resolved-theme.ts`:
  - Export `subscribeResolvedTheme(callback: (theme: ResolvedTheme) => void): () => void` — combines the `MutationObserver` on `<html data-theme>` with the `matchMedia("(prefers-color-scheme: dark)")` listener. **Dedupes by tracking the last emitted resolved value** — only invokes the callback when the resolved theme actually changes. This prevents the orchestrator from firing twice for a single user action that touches both `data-theme` and matchMedia in the same tick (CONCERN A).
  - The existing `useResolvedTheme()` hook may be refactored to use this subscribe API internally — keep its public contract.
  - Test in `apps/web/src/use-resolved-theme.test.ts`: triggering both `data-theme` mutation AND a matchMedia change in the same tick yields ONE callback invocation, not two. Triggering the same resolved theme twice (e.g. set `data-theme="light"` when already "light") yields zero callbacks.
- Create `apps/web/src/re-theme-orchestrator.ts`:
  - Export `setupReThemeOrchestrator(): () => void` (returns a cleanup function).
  - Subscribes via `subscribeResolvedTheme()`.
  - On every (deduped) change:
    1. List handles via `listTerminalHandles()` (new helper in `terminal-pane.tsx` exporting `Array.from(REGISTRY.entries())`).
    2. **Shuffle iteration order** per loop (Fisher-Yates) to amortize tail starvation under sustained toggling (CONCERN C). Without this, the last handles in registry order can be starved when rapid toggles keep canceling at the same iteration boundaries.
    3. For each handle, compare new theme against `handle.lastKnownTheme`; skip if unchanged (idempotent, addresses CONCERN 6).
    4. Otherwise call `handle.reload(theme)` — **theme passed explicitly** (no `themeRef` race; addresses BLOCKER 3). The orchestrator path always wants a fresh ttyd process (theme only applies at boot), so the handle's reload(theme) impl always passes `{ force: true, bumpFrame: true, theme }` to `ensure()` (CONCERN E).
    5. **Stagger:** sequential `for` loop with `await delay(80)` between calls. No new dependency (no `p-map`).
    6. **Sequence token:** orchestrator holds a `let currentSeq = 0`; each invocation increments. After each `await delay()`, check `if (mySeq !== currentSeq) return` and bail (addresses BLOCKER 5).
  - Errors per-handle are caught + logged (`console.warn`); they do not abort the loop.
- Modify `apps/web/src/terminal-pane.tsx`:
  - Change `TerminalHandle.reload` signature from `() => void` to `(theme?: ResolvedTheme) => void`. When called with a theme, the pane passes `{ force: true, bumpFrame: true, theme }` to ensure(). When called without a theme (existing tab-action manual-reload UX), the pane passes `{ force: true, bumpFrame: true }` (theme sourced from `themeRef.current` — unchanged behavior). **The `lastKnownTheme` idempotency check lives ONLY in the orchestrator; manual `reload()` always respawns** (CONCERN F).
  - Add `lastKnownTheme: ResolvedTheme | null` to `TerminalHandle`. Updated each time `ensure()` succeeds with a known theme.
  - Add `listTerminalHandles(): Array<[string, TerminalHandle]>` export.
- Mount `setupReThemeOrchestrator()` once in `apps/web/src/main.tsx`, **BEFORE** `createRoot().render(...)` so subscription is live before first render (CONCERN B). Store the cleanup function in a module-level variable; on Vite HMR re-import, call the prior cleanup before remounting to prevent double-subscribe.
- Tests in `apps/web/src/re-theme-orchestrator.test.ts` (new):
  - Toggling theme calls `reload(theme)` on each registered handle, with the new theme passed explicitly.
  - Reloads are staggered: with `vi.useFakeTimers`, second call only fires after the 80ms delay.
  - **Reload calls `ensure` with `force:true`** (CONCERN E): mock the handle's reload impl and assert the underlying ensure() invocation includes `force: true, bumpFrame: true, theme: <new>`.
  - No-op (same theme as `lastKnownTheme`) does NOT call `reload`.
  - Rapid toggles coalesce: trigger two toggles within the stagger window; assert only the latest theme is reloaded per handle, and earlier in-flight loops abort cleanly.
  - **Tail fairness (CONCERN C):** 10 handles + 5 rapid toggles → all 10 handles eventually reach the final theme. Use `vi.useFakeTimers()` and `vi.runAllTimersAsync()` to drain the post-final-toggle stagger window deterministically before asserting (no real-time waits, no flake).
  - One handle throwing inside `reload()` does not block subsequent handles.
  - OS theme flip (simulate `matchMedia` change) triggers re-theme when user is on "system".
  - **Idempotent HMR mount:** calling `setupReThemeOrchestrator()` twice in a row, then invoking the first returned cleanup, leaves exactly one active subscription (assert by counting MutationObserver disconnect calls or by a callback count).
- Tests in `apps/web/src/terminal-pane.test.tsx` (update or add):
  - `reload(theme)` passes `{ force: true, bumpFrame: true, theme }` into ensure(); `reload()` without a theme passes `{ force: true, bumpFrame: true }` (theme from `themeRef.current`).
  - `lastKnownTheme` is updated after a successful ensure().

### Unit E — Jira chip dark-bg variant (Item 5)

- Use `data-cit-on-dark="true"` (namespaced; addresses SUGGESTION 15 — matches `.cit-*` class convention, avoids collisions).
- Surfaces:
  - `apps/web/src/workspace-card.tsx:113` — when `props.active`, add `data-cit-on-dark="true"` (the card's dark-navy fill).
  - Any inspector pane currently using an explicit dark surface (search `grep -rn 'background:\s*var(--c-dark)\b\|background:\s*#15130f' apps/web/src/inspector*.css`) — gets `data-cit-on-dark="true"` on its container.
  - **Browser verification first:** before writing the CSS, deploy locally, attach a Jira ticket to a workspace, identify exactly which surface the chip sits on in the inspector when the bug manifests (light cockpit + dark workspace card scenario). The chip is rendered in `InspectorAttach` in `inspector.tsx` lines 362-399; its actual parent surface depends on the workspace's render path. Adjust the marked surfaces based on this.
- Add CSS in `apps/web/src/inspector-stats.css`. Where the value matches the existing `[data-theme="dark"]` overrides, DRY by merging selector lists:

  ```css
  [data-theme="dark"] .cit-jira-key,
  [data-cit-on-dark="true"] .cit-jira-key {
    color: oklch(75% 0.13 250);
  }

  [data-cit-on-dark="true"] .cit-jira {
    background: var(--c-dark-2);
    border-color: var(--c-line-3);
    color: var(--c-on-dark);
  }
  [data-cit-on-dark="true"] .cit-jira-title { color: var(--c-on-dark); }

  [data-theme="dark"] .cit-jira-status--progress,
  [data-cit-on-dark="true"] .cit-jira-status--progress {
    background: oklch(40% 0.1 70 / 0.4);
    color: oklch(82% 0.13 70);
  }
  /* …same merge for --review, --done, --blocked… */

  [data-cit-on-dark="true"] .cit-jira-status--todo {
    background: var(--c-line-3);
    color: var(--c-on-dark);
  }
  [data-cit-on-dark="true"] .cit-jira-status--unknown {
    color: var(--c-on-dark-d);
    border-color: var(--c-line-3);
  }
  ```

- Tests:
  - `apps/web/src/jira-chip.test.tsx` (new): render the chip inside a `<div data-cit-on-dark="true">` wrapper, assert the attribute is present on the wrapper and the chip rendered, and that **no element in the chip subtree** has a hard-coded `color: white|#fff` inline style. Computed-style assertions in JSDOM are unreliable — leave that to Playwright (Unit F).
  - `apps/web/src/workspace-card.test.ts` (extend): assert `data-cit-on-dark="true"` is set when `props.active`, absent otherwise.

### Unit F — E2E (Playwright) smoke

- Add `e2e/theming.spec.ts`:
  - Boot the cockpit, click the theme button three times, assert `<html data-theme>` cycles correctly through three states (with the "system" state being either absent or matching media preference depending on emulation).
  - Open a workspace, open a terminal, toggle theme. **Pin the assertion:** `page.waitForRequest(req => req.url().includes('/api/agent-sessions/') && req.url().includes('/terminal') && new URL(req.url()).searchParams.get('theme') === '<expected>')` after toggling. Use `Promise.all([waitForRequest, themeButton.click()])`.
  - Visit a workspace with a Jira-attached ticket. Assert the chip's rendered text is non-empty in both cockpit themes. Take a screenshot in each theme for manual eyeball review; no visual-baseline diff (suite does not maintain one).
- Do NOT add a visual-regression baseline.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Theme controls cycling, ttyd theme signature tightening + cross-session isolation, re-theme orchestrator (stagger + coalescing + idempotent + OS flip), white-on-light regression guard, color-contrast helper, Jira chip wrapper presence, snapshot of LIGHT_XTERM_THEME. Colocated under `apps/web/src/`, `packages/terminal/src/`, `apps/daemon/src/`. |
| E2E (Playwright) | **Required** | Theme cycle through three states in real browser; live re-theme of a real terminal iframe with theme= query assertion; Jira chip visible across both themes. `e2e/theming.spec.ts`. |

### New tests to add

- `packages/terminal/src/ttyd.test.ts` (extend if exists; create otherwise):
  - Type-level: `// @ts-expect-error` on a call without `theme`.
  - Cross-session isolation: two keys, distinct themes, neither leaks.
  - Explicit-respawn: stored light, override dark, force=true → dark spawn.
  - Snapshot of `LIGHT_XTERM_THEME`.
- `apps/daemon/src/terminal-routes.test.ts` (extend if exists; create otherwise):
  - Reconnect precedence: populated `ThemePrefStore.get('A') = 'light'`, simulate revive, assert spawn args include LIGHT.
  - Audit: every ensure() call site in the file passes a theme.
- `apps/web/src/theme-controls.test.tsx` (new):
  - Cycle order Light → Dark → System → Light; icon and aria-label updates; localStorage persistence; `data-theme` attribute correctness; `normalize()` rejects unknown values.
- `apps/web/src/re-theme-orchestrator.test.ts` (new):
  - Toggling theme calls `reload(theme)` on each registered handle with the new theme passed explicitly.
  - Underlying ensure() invocation includes `force:true, bumpFrame:true, theme:<new>`.
  - Stagger with `vi.useFakeTimers`; second call only fires after 80ms.
  - No-op (same theme) does NOT call `reload`.
  - Rapid toggles coalesce: two toggles within the stagger window → only the latest theme is reloaded per handle.
  - Tail fairness: 10 handles + 5 rapid toggles → all 10 reach the final theme by end-of-test.
  - One handle throwing inside `reload()` does not block subsequent handles.
  - OS theme flip (matchMedia change event) triggers re-theme on "system" users.
  - Idempotent HMR mount: setting up twice + invoking the first cleanup leaves exactly one active subscription.
- `apps/web/src/use-resolved-theme.test.ts` (extend if exists; create otherwise):
  - `subscribeResolvedTheme()` dedupes: simultaneous `data-theme` mutation + matchMedia change yields one callback; setting the same resolved theme twice yields zero new callbacks.
- `apps/web/src/terminal-pane.test.tsx` (extend if exists; create otherwise):
  - `reload(theme)` passes explicit theme through to ensure().
  - `reload()` without theme falls back to `themeRef.current`.
- `apps/web/src/__tests__/no-white-on-light.test.ts` (new): expanded regex (rgb/rgba/hsl/oklch + TSX inline styles) outside dark/cit-on-dark-gated blocks.
- `apps/web/src/color-contrast.test.ts` (new): WCAG cases for `pickReadableForeground`.
- `apps/web/src/jira-chip.test.tsx` (new): `[data-cit-on-dark="true"]` wrapper presence + no hard-coded white in chip subtree.
- `apps/web/src/workspace-card.test.ts` (extend): `data-cit-on-dark="true"` on active card.
- `e2e/theming.spec.ts` (new): cycle, terminal iframe respawn with theme= query, Jira chip visible across themes.

### Existing tests to update

- Existing `ttyd.test.ts` calls that pass no `theme` arg will fail to compile — update each to pass an explicit theme.
- `apps/web/src/use-resolved-theme.test.ts` (if exists): may need an update if the subscribe API is extracted; verify and adjust.
- `apps/web/src/inspector.test.tsx` (if exists): if it asserts chip computed style, adjust to new tokens or move to dedicated chip test.

### Assertions to add/change/tighten

- `ttyd.test.ts`: the type-level assertion is new and explicit. Existing "spawn args include theme=…" assertions are tightened to cover the post-respawn case.
- `theme-controls.test.tsx`: explicitly assert `localStorage` value after each click, not just the attribute.
- `re-theme-orchestrator.test.ts`: assert orchestrator subscribes to `useResolvedTheme`'s channel, not to `ThemeControls` button click — verify by triggering a matchMedia change directly and observing the reload.
- `no-white-on-light.test.ts`: expanded form regex; clear baseline (post-Unit-C); fails the build on any new violation.

### Failure modes / edge cases / regression risks

- **Spawn-storm regression.** Mitigation: sequential stagger (80ms), idempotent no-op skip, coalescing via sequence token.
- **vitest cleanupStale regression.** MEMORY explicitly warns about `cleanupStale()` killing live ttyds in vitest. New tests must NOT trigger any ttyd cleanup against operator ports. Use mocked spawn or temp `dataDir`.
- **xterm "system" theme drift.** Orchestrator wires into the same channel as `useResolvedTheme` (MutationObserver + matchMedia), not into ThemeControls button click — covers OS flips. Tested.
- **Rapid-toggle coalescing.** Sequence token bails superseded loops. Tested with fake timers.
- **Idempotent no-op.** Per-handle `lastKnownTheme` prevents reloading when theme didn't actually change. Tested.
- **Theme propagation invariant.** Tightened `ensure()` signature means a future refactor that omits theme triggers a TYPE error (not a silent dark spawn). The Spec gate update records the invariant.
- **`window.confirm` removal.** Document in PR description that the toggle no longer prompts; users see a brief reconnect blip per terminal.
- **Jira chip surface mismatch.** Browser verification BEFORE writing the CSS rules — done as an explicit step in Unit E.
- **localStorage corruption.** `normalize()` rejects unknown values and falls back to "system". Tested.
- **Cockpit→daemon contract.** `parseTheme` accepts only `"light"|"dark"`. The cockpit resolves "system" to one of those before sending. No new contract change. **Tightened in Unit A**: unrecognized `?theme=` values now log a warning rather than silently returning `undefined`, closing the parallel-gap to the manager tightening.

### Adversarial analysis

- **How could this fail in production?** Cleanup-storm under heavy load. Mitigated by stagger + idempotency + coalescing.
- **What user actions trigger unexpected behavior?** Rapid toggling — coalesces. OS auto-night while on "system" — orchestrator wires the matchMedia channel.
- **What existing behavior could break?** The `ensure()` signature change will break any forgotten call site. The audit + type-check + the explicit test that ensures all production paths still compile is the safety net. Pre-existing `parseTheme` "system" drop is unchanged.
- **Which tests credibly catch those failures?** Stagger + coalescing tests catch spawn-storm class. `no-white-on-light` catches CSS regressions. `re-theme-orchestrator.test.ts` covers the matchMedia path. Cross-session isolation test covers theme leak. Reconnect precedence test covers `reviveProxyTarget`.
- **What gaps remain?** Multi-user-on-same-daemon scenarios; visual snapshot baseline. Both acceptable for this PR; flag in PR body.

### Terminal-completeness gate

Explicit per-dimension disposition (gate APPLIES because we touch `packages/terminal`):

| Dimension | Touched? | Coverage |
|-----------|----------|----------|
| Raw input | No | Pre-existing; out of scope. |
| Control/meta sequences | No | Pre-existing; out of scope. |
| Paste | No | Pre-existing; out of scope. |
| Resize | No | Resize is owned by xterm.js + ttyd; not touched. |
| Long output | No | Pre-existing scrollback bound; not touched. |
| Alternate screen | No | Pre-existing; not touched. |
| Reconnect | **Yes** | Reconnect precedence test in `terminal-routes.test.ts` verifies revive path sources from `ThemePrefStore`. |
| Cross-session isolation | **Yes** | Explicit test in `ttyd.test.ts` (two keys, distinct themes). |

### Architecture-boundary gate

`TtydTheme` is currently exported from `packages/terminal/src/ttyd.ts`. Web must NOT import it directly. Approach: define a local type alias `type ResolvedTheme = "light" | "dark"` in `apps/web` (already exists in `apps/web/src/use-resolved-theme.ts` as `export type ResolvedTheme`). Web uses its own type; types do not cross the package boundary. **Verified during impl.**

### File-size gate

No file approaches the 800-line limit. `ttyd.ts` is currently ~360 lines; this PR removes ~3 lines (the `??"dark"` default) and adds ~0 (no new state). `terminal-pane.tsx` is currently ~220 lines; this PR adds ~10 (handle signature + lastKnownTheme + listTerminalHandles). `theme-controls.tsx` is currently ~40 lines; rewrite stays under 100. New files (`re-theme-orchestrator.ts`, `color-contrast.ts`) are each well under 200 lines. **Verified at impl.**

### Lockfile-sensitivity gate

No new dependencies. The stagger uses a vanilla `setTimeout`-backed `delay()` helper; no `p-map`. **Satisfied.**

## Tests

Derived from QA/Test Strategy. TDD order: tests committed in the **same commit** as the implementation per unit, so CI is never red mid-PR (addresses SUGGESTION 16).

- **New files:**
  - `packages/terminal/src/ttyd-theme.test.ts` (only if `ttyd.test.ts` doesn't exist; verify at impl) — type-level test, cross-session, snapshot of LIGHT_XTERM_THEME.
  - `apps/daemon/src/terminal-routes.test.ts` (extend if exists; create otherwise) — reconnect precedence + ensure() audit.
  - `apps/web/src/theme-controls.test.tsx` — cycle, persistence, normalize.
  - `apps/web/src/re-theme-orchestrator.test.ts` — orchestrator behavior.
  - `apps/web/src/terminal-pane.test.tsx` (extend if exists) — reload signature.
  - `apps/web/src/__tests__/no-white-on-light.test.ts` — regression guard.
  - `apps/web/src/color-contrast.test.ts` — WCAG helper.
  - `apps/web/src/jira-chip.test.tsx` — chip wrapper.
  - `apps/web/src/workspace-card.test.ts` (extend if exists) — active card attribute.
  - `e2e/theming.spec.ts` — full-browser flow.
- **Existing files possibly modified:**
  - `packages/terminal/src/ttyd.test.ts` — any existing call without `theme` arg needs updating.
  - `apps/web/src/use-resolved-theme.test.ts` (if exists) — verify subscribe extraction does not break.
  - `apps/web/src/inspector.test.tsx` (if exists) — adjust if it asserts chip computed style.

## Schema or contract generation

Not applicable. The daemon's `?theme=…` query param contract is unchanged. The disk-backed `terminal-theme-prefs.json` format is unchanged. The internal `TtydTheme` type changes from optional-with-default to required, which is a SOURCE-LEVEL contract tightening, not an HTTP/SDK contract change.

## Verification

From the extension's verification commands:

- `make check` — full local gate: arch (validates web does not gain a cross-package import to packages/terminal), size (validates no file over 800 lines), typecheck (validates the `ensure()` signature tightening fanout), lint, vitest (incl. coverage), deps, build. **Must pass before push.**
- `make e2e` — Playwright. **Must pass** — adds `e2e/theming.spec.ts`.
- `make smoke` — local API smoke. **Required** — the daemon's terminal route (`POST /api/agent-sessions/:sessionId/terminal`) is touched indirectly via Unit A's tightened call sites. Run against a local daemon started via `make deploy`.
- `make performance` — **Optional/skip** unless impl reveals startup-path changes. Theme switching is not a hot path; document the decision in the PR body.

Browser verification (per CLAUDE.md: "UI changes need browser verification, not just type-check pass"):
- `make deploy` to start the worktree-isolated HMR stack. Cockpit URL is printed on success; do not use `:4010` (systemd long-term daemon).
- Toggle theme through all three states; confirm icon + aria-label + persistence + canvas color.
- Open 3+ terminal sessions; toggle theme; confirm all terminals re-theme in place with a brief reconnect blip per terminal. Toggle rapidly 3× and confirm the final theme is applied without spawn-storm symptoms.
- Switch OS theme (or `prefers-color-scheme` devtools toggle) with cockpit on "system"; confirm the cockpit AND open terminals follow.
- Attach a Jira ticket to a workspace; verify chip is legible in both cockpit themes, both on the regular inspector surface and on a dark workspace card.
- Confirm no white text visible on light canvas across: cockpit, navigator, inspector, stage, settings, scheduled-agents, modals.
