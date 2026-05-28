Activate the /implement-task skill first.

# Plan: Design system — tokens, primitives, and high-traffic migrations

## Acceptance Criteria

Sourced from the Citadel scratchpad topic (no formal ticket): "Build out reusable components / tokens so the cockpit looks/feels like a professional UI app." Reformulated as checkable items, grounded in `specs/B.2-ade-cockpit.md` and `specs/B.8-ui-performance-quality.md`:

- [ ] A single canonical token layer (`apps/web/src/design-system/tokens.css`) defines all color, typography, elevation, radius, spacing, and motion tokens used by the cockpit, in both light and dark themes.
- [ ] `apps/web/src/styles.css` no longer inlines token definitions; it imports the canonical token file. Legacy `--color-*`, `--panel*`, `--line*`, `--muted`, `--surface*`, `--topbar-*` aliases continue to resolve so existing CSS keeps rendering unchanged.
- [ ] A reusable React primitive library lives under `apps/web/src/components/ui/` with at least these primitives implemented and tested: `Button` (extended), `Badge` (extended), `Card`, `Panel` (+ header/body/footer subcomponents), `Input`, `Textarea`, `Select`, `Label`, `FormField`, `HelpText`, `Tabs` (+ list/trigger/content), `Dialog` (+ header/footer/title/description), `Tooltip`, `Chip`, `IconButton`, `EmptyState`, `Skeleton`, `Toast` (region + hook).
- [ ] Every primitive is keyboard-accessible (focus-visible ring on token), supports light/dark theming via tokens (no hard-coded hex colours in component files), and exposes the `className` escape hatch via `cn(...)`.
- [x] Four high-traffic surfaces are touched by primitives in the same PR to prove they work. Two are fully migrated, two are partial (scope narrowed during implementation — see notes):
  - [x] `modals.tsx` — all centered modals use `Dialog` (Modal scaffolding rewritten over Radix Dialog).
  - [x] Inspector tab strip in `inspector.tsx` uses `Tabs` (extracted into `inspector-tabs.tsx`; `data-active={tab}` preserved on the TabsList wrapper for the inspector-deploy.css contract).
  - [~] Scheduled-agent form (`scheduled-agent-form.tsx`) — **only the Name field** migrated to `FormField + Input`. Twelve other fields (schedule type, cron preset, cron, when/at, repo, runtime, run mode, background cwd, workspace strategy, existing workspace, base branch, overlap policy, description, prompt, enabled) keep their bespoke `<label><span>…</span><control/></label>` shape. Deferred because each carries conditional rendering + custom validation timing that needs case-by-case translation; full migration is a follow-up PR. New `scheduled-agent-form.test.tsx` locks in the FormField contract for the migrated field.
  - [~] Workspace-card status pills — **only the namespace pill** migrated to `Chip`. The approval-pill (icon-only, transparent fill, tonal icon colour) and the workspace-card-diff (two-tone +/- counter) remain bespoke; flagged with an in-code `TODO(implement-task)` comment. They don't map cleanly onto Badge/Chip's surface-fill conventions and need a design pass before rewriting.
- [ ] A dev-only route `/design-system` renders every primitive's variants in both themes. Hidden behind `import.meta.env.DEV` — not bundled into production builds.
- [ ] Spec **B.8 #4** ("shadcn-style components are used where they improve consistency and speed") is checked off and the spec's bullet annotated `[~]` or `[x]` with a line linking back to this design system layer.
- [ ] `make check` and `make e2e` pass.
- [ ] An existing visual regression in the migrated surfaces is not introduced — Playwright `theme-audit.spec.ts` continues to pass.

## Context and problem statement

The cockpit's visual layer today is ~8,700 lines of bespoke CSS spread across 19 files (`styles.css`, `chrome.css`, `cockpit-extras.css`, `inspector-*`, `settings-*`, `scheduled-agents*`, etc.) and only two React primitives (`Button`, `Badge`) under `apps/web/src/components/ui/`. The token layer already exists in `styles.css` (warm-cream / dark themes with `--c-*` semantic tokens plus `--color-*` legacy aliases) but:

1. Tokens live inline in `styles.css` with no separate "design system" home and no inventory document.
2. Higher-level patterns — modals, tabs, panels, form fields, tooltips, chips, empty states, skeletons — are reimplemented per screen in bespoke CSS, drifting in spacing, radius, and density.
3. `packages/ui` exists as a stub (single string export) but has no React deps and no consumers; it's reserved for v2 packaging, not the current target.
4. `apps/web/src/components/ui/button.tsx` and `badge.tsx` use `class-variance-authority` (CVA) + Tailwind + `cn()` — that's the right foundation but the library stops there.

The work is to **extend the existing primitive layer to cover the patterns the cockpit actually uses repeatedly**, migrate the highest-traffic surfaces to prove the primitives are sufficient, and leave a documented `/design-system` route for visual review. This satisfies the operator-facing AC in **B.2 #7** ("dark-blue v1-inspired palette… dense, no marketing hero areas"), **B.8 #3** ("calm, dense, premium, operational"), and **B.8 #4** ("shadcn-style components are used where they improve consistency and speed").

## Spec alignment

- `specs/B.2-ade-cockpit.md` — no behavioral change to cockpit ACs. The plan preserves all current cockpit semantics (three-column shell, no page scroll, modal centering, compact pill tab strip). Migration to primitives keeps visual treatment within token-defined ranges.
- `specs/B.8-ui-performance-quality.md` — directly serves AC **#4** ("shadcn-style components are used where they improve consistency and speed") and supports **#3**, **#6**, **#8**, **#12**. The implementation step "Spec annotations" updates B.8 #4 from `[ ]` to `[~]` (partial — first wave of primitives shipped; full surface migration deferred), and adds a one-line reference to `apps/web/src/design-system/README.md`.
- `specs/C-technical-stack.md` — three new dependencies (`@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-tabs`) are added to `apps/web/package.json`. These are first-party Radix packages, same maintainer as the already-installed `@radix-ui/react-slot`. The plan's Implementation Steps include the lockfile review and the post-install lifecycle audit per MEMORY (`feedback_codex_broken` is unrelated; the relevant guidance is the standard "treat pnpm-lock.yaml as security-sensitive" rule from `.agents/skills/extensions/review-pr.md`).

No spec file gets a *content* update beyond the B.8 #4 annotation; the design system is delivery against existing ACs, not new behavior.

## Implementation approach

The chosen strategy is **extend the existing CVA + Tailwind + token primitive layer** under `apps/web/src/components/ui/`, with tokens consolidated into a single imported `tokens.css` and primitive coverage expanded to the patterns the cockpit actually repeats. Migration of bespoke screens happens screen-by-screen, with **four high-traffic surfaces migrated in the same PR** to prove the primitives are sufficient. Remaining surfaces remain on their bespoke CSS until follow-up PRs.

Rationale:

- The codebase already standardised on CVA + Tailwind 4 + `cn()` (`apps/web/src/components/ui/button.tsx`, `badge.tsx`, `apps/web/src/lib/utils.ts`). Continuing on the same foundation avoids a rewrite tax and keeps the bundle small.
- Radix headless primitives (`@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-tabs`) give us accessibility (focus trap, Escape handling, ARIA wiring) without owning the behavior. Same vendor as `@radix-ui/react-slot` which is already installed.
- Tokens stay in `apps/web/src/design-system/tokens.css` (not `packages/ui`) because (a) `packages/ui` is currently a stub, has no React deps, and migrating there would expand the PR scope and (b) cockpit-specific tokens (dark-blue v1-inspired palette per B.2 #7) are not yet a shared design surface — there is no second consumer.
- Migrating four surfaces in the same PR proves the primitives cover real use cases (rather than landing a library that nothing uses, then discovering gaps in follow-ups). The four were chosen because they collectively exercise every new primitive type: `Dialog` (modals.tsx), `Tabs` (inspector), `FormField` family (scheduled-agent-form), `Badge`/`Chip` (workspace-card pills).

## Alternatives considered

**Alternative A — move primitives into `packages/ui` now.** Rejected. The package is currently a stub with no React peer-dep, no test setup, and no consumer beyond `apps/web`. Promoting it now would (a) inflate this PR with packaging work, (b) require adjustments to `pnpm` workspace dependency rules and the `check:arch` boundary script, and (c) deliver no immediate benefit because there is no second consumer. Leave `packages/ui` for a future "extract" PR once a second consumer (e.g. `apps/cli` web shell, or a hosted variant) actually exists.

**Alternative B — adopt `shadcn/ui` CLI and let it scaffold the components.** Rejected. shadcn copies components into the repo; we'd still own them. The bookkeeping cost of running the CLI plus matching its directory conventions outweighs the benefit when we already have CVA + `cn()` patterns established. We can borrow shadcn's ergonomics (CVA variants, Radix headless, `cn()` merge) without the tooling. Spec **B.8 #4** says "shadcn-style," not "shadcn the package."

**Alternative C — build all primitives but migrate zero screens, deferring migration to follow-up PRs.** Rejected. Without a real consumer in the same PR, primitive APIs drift from real usage and the PR delivers an unproven library. The "four migrations in the same PR" rule keeps the design honest and surfaces API gaps before merge.

**Alternative D — convert everything in one mega-PR.** Rejected. 8,700 lines of bespoke CSS across 19 files cannot be reviewed in one diff; the file-size and review-burden costs are high. Phased delivery (this PR + follow-ups documented in the PR description) is the responsible choice.

## Implementation steps

### Spec annotations
- Annotate `specs/B.8-ui-performance-quality.md` line **UI Quality #4** from `[ ]` to `[~]` with a trailing note: "First wave of primitives shipped under `apps/web/src/components/ui/`; see `apps/web/src/design-system/README.md`. Remaining surfaces deferred to follow-up PRs."

### Token consolidation

**Step 1 — enumerate the current token surface (must run before consolidation):**
```bash
grep -rohE "var\(--[a-z0-9-]+\)" apps/web/src --include="*.css" --include="*.tsx" \
  | sed -E 's/^var\(//; s/\)$//' \
  | sort -u \
  > apps/web/src/design-system/tokens.inventory.txt
```
Commit this file as the canonical inventory. There are ~51 unique tokens at HEAD; the consolidation must preserve every one of them (a missing alias silently breaks unmigrated CSS).

**Step 2 — collapse the `prefers-color-scheme` blocks into explicit `data-theme` blocks.**

`apps/web/src/styles.css` today has two `@media (prefers-color-scheme: light)` blocks (lines 152 and 199) that define tokens *only* visible when the OS theme is light and no explicit `data-theme` is set. The consolidated `tokens.css` must:

- Define every token in **both** `:root` (light default) and `:root[data-theme="dark"]` (dark explicit) blocks.
- Move any token that lives **only** inside a `prefers-color-scheme` block into the explicit blocks so every token is reachable without OS-theme simulation.
- Retain a single `@media (prefers-color-scheme: dark)` block scoped to `:root:not([data-theme="light"]):not([data-theme="dark"])` that re-points to the dark token values — this preserves OS-driven auto-theming for users who haven't picked a theme.

**Step 3 — write `apps/web/src/design-system/tokens.css`** containing the unified `:root` (light) and `:root[data-theme="dark"]` declarations covering every token in `tokens.inventory.txt` (both `--c-*` semantic tokens and legacy `--color-*`/`--panel*`/`--line*`/`--muted`/`--surface*`/`--topbar-*`/`--overlay-bg`/`--shadow-color` aliases) plus the auto-theming media block above.

**Step 4 — edit `apps/web/src/styles.css`** to replace the inlined token blocks (current lines ~1–200) with `@import "./design-system/tokens.css";`. Keep all non-token rules (resets, keyframes, structural classes) in `styles.css`.

**Step 5 — write `apps/web/src/design-system/README.md`** (≤120 lines): inventory of every token, semantic intent, "how to add a new token" rule, and an explicit note about the happy-dom coverage gap for `prefers-color-scheme` (mitigated because Step 2 moves all tokens out of those blocks).

**Step 6 — write `apps/web/src/design-system/index.ts`** re-exporting every primitive so consumers can `import { Button, Dialog, Tabs } from "./design-system"`.

### Primitive: Button (extend)
- Edit `apps/web/src/components/ui/button.tsx`:
  - Add variants: `destructive` (uses `--color-danger`), `link` (no chrome, underline on hover).
  - Add `loading?: boolean` — renders an inline spinner (reuse the `@keyframes spin` in `styles.css`) and sets `disabled` while loading. Preserves children for layout stability.
  - Add sizes: keep `default` (`min-h-9`), `icon` (`h-9 w-9`); add `sm` (`min-h-7 px-2 text-xs`) and `lg` (`min-h-10 px-4`).
  - Existing `default`/`secondary`/`ghost` variants stay unchanged.

### Primitive: Badge (extend)
- Edit `apps/web/src/components/ui/badge.tsx`:
  - Add variants: `info` (`--color-info`), `warn` (`--color-warning`), `merged` (`--color-merged`), `neutral-strong` (heavier neutral fill).
  - Existing `neutral`/`ready`/`blocked` variants stay unchanged.
  - Add optional `dot?: boolean` prop — renders a 6px circle prefix in the same color tone.

### Primitive: Card / Panel
- Create `apps/web/src/components/ui/card.tsx` exporting `Card` (rounded surface using `--c-card` bg, `--c-line-2` border, `--sh-card` shadow).
- Create `apps/web/src/components/ui/panel.tsx` exporting `Panel`, `PanelHeader`, `PanelBody`, `PanelFooter`. Header uses `--c-elev`, compact uppercase-spaced label slot (matches B.8 #12: "small uppercase panel titles").

### Primitive: Form field family
- Create `apps/web/src/components/ui/input.tsx` (`Input`, `Textarea`) — native elements styled via CVA. Tokens: `--c-surface` bg, `--c-line-2` border, focus ring `--color-action`.
- Create `apps/web/src/components/ui/select.tsx` (`Select` — native `<select>` styled via CVA; we use native because cockpit menus stay accessible and lightweight. A `radix-react-select` primitive can be added later if needed).
- Create `apps/web/src/components/ui/label.tsx` (`Label`, `HelpText`).
- Create `apps/web/src/components/ui/form-field.tsx` (`FormField` — composes `Label` + control + `HelpText` + error slot).

### Primitive: Tabs (Radix-backed)
- Add dep: `@radix-ui/react-tabs` to `apps/web/package.json`.
- Create `apps/web/src/components/ui/tabs.tsx` exporting `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`. Visual style matches B.2 Inspector Tabs #1 ("compact pill-style picker that occupies only its own content width").

### Primitive: Dialog (Radix-backed)
- Add dep: `@radix-ui/react-dialog` to `apps/web/package.json`.
- Create `apps/web/src/components/ui/dialog.tsx` exporting `Dialog`, `DialogTrigger`, `DialogPortal`, `DialogOverlay`, `DialogContent`, `DialogHeader`, `DialogFooter`, `DialogTitle`, `DialogDescription`, `DialogClose`. Visual style matches B.2 #14 ("centred both horizontally and vertically in the viewport; backdrop dismissal and `Esc` close them"). Overlay uses `--overlay-bg`.

### Primitive: Tooltip (Radix-backed)
- Add dep: `@radix-ui/react-tooltip` to `apps/web/package.json`.
- Create `apps/web/src/components/ui/tooltip.tsx` exporting `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent`. Mount **one** `TooltipProvider` at the cockpit root (`apps/web/src/main.tsx`) with cockpit-tuned defaults: `delayDuration={250}` (faster than Radix's 700ms default — matches B.8 #3 "calm, dense, premium, operational"), `skipDelayDuration={100}`, `disableHoverableContent={false}`. Document the chosen defaults in `apps/web/src/design-system/README.md`.

### Primitive: Chip
- Create `apps/web/src/components/ui/chip.tsx`. Chip is a Badge with optional leading icon slot (e.g. a Lucide icon) and optional `onClose` X button — used for attached-Jira chips (B.2 Inspector Tabs #4), reviewer avatars, status pills with detail.

### Primitive: IconButton
- Create `apps/web/src/components/ui/icon-button.tsx` — wraps `Button` with `size="icon"`, enforces `aria-label` is required via TS. **Excludes `asChild` polymorphism** from the prop type so the `aria-label` is guaranteed to land on the rendered `<button>` element (consumers that need a polymorphic icon-link should use `Button` directly with `asChild` and pass `aria-label` themselves). Type: `Omit<ButtonProps, "children" | "asChild"> & { "aria-label": string; children: ReactNode }`. Adds a dev-mode console warning if `aria-label` is somehow empty at runtime. Satisfies B.2 Shell Layout #13 ("Icon-only controls expose a native tooltip (title) and accessible label").

### Primitive: EmptyState
- Create `apps/web/src/components/ui/empty-state.tsx` — composed pattern: icon + heading + description + optional CTA. Used by Attention States (B.2 "Attention States" #1, #2) and Deployed apps panel (B.2 Inspector Tabs #6a).

### Primitive: Skeleton
- Create `apps/web/src/components/ui/skeleton.tsx` — block-level shimmer. Used for slow provider data per B.8 Performance #3/#4.

### Primitive: Toast
- Create `apps/web/src/components/ui/toast.tsx`:
  - Self-contained: `<Toaster />` region component, `useToast()` hook returning `toast({ title, description, variant, action })`.
  - No `sonner` dep; small custom implementation backed by a `useSyncExternalStore` queue. Variants: `default`, `success`, `warning`, `danger`. Auto-dismiss after 5s default, swipe/click-to-dismiss.
  - Mount `<Toaster />` once at the cockpit root.

### Migration: modals → Dialog
- Edit `apps/web/src/modals.tsx`: replace bespoke modal scaffolding with `Dialog`/`DialogContent`/`DialogHeader`/etc. for every modal currently rendered there (CreateWorkspaceModal, AddRepoModal, command palette wrapper if applicable). Preserve all existing behavior (`Esc` close, backdrop dismissal, focus management — Radix gives these for free, so this is mostly removing hand-rolled effects).
- Edit `apps/web/src/modals.css`: remove rules covered by the Dialog primitive (overlay, centering, focus trap), keep modal-specific content layout rules.

### Migration: Inspector tabs → Tabs primitive

**File-size budget (critical):** `apps/web/src/inspector.tsx` is currently 771 LOC against the 800 LOC `check:size` cap. Adding Radix imports + the migrated tab block + the compat `data-active` wrapper will push past 800. Extract the tab strip into a sibling file **before** the migration:

- Create `apps/web/src/inspector-tabs.tsx` (≤200 LOC) exporting `InspectorTabs` that takes `{ tab, onTabChange, fileCount, children }` and renders the Radix-backed pill tab strip.
- Edit `apps/web/src/inspector.tsx` to import and use `InspectorTabs`. Net effect: `inspector.tsx` line count goes **down**, not up.
- Measure: confirm `wc -l apps/web/src/inspector.tsx` is < 700 after the migration.

**Preserve the `data-active` selector contract:** `apps/web/src/inspector-deploy.css:94` and `inspector-meta.css:176` style `.inspector-tabs` and rely on a parent-level `data-active="<tab>"` attribute. Radix `TabsList` does not emit this. The migration **must** apply `data-active={tab}` to the `TabsList` wrapper (or a div wrapping it) — this is not "if needed", it is required because the CSS selectors target the list container, not the trigger.

**CSS cleanup — explicit deletions.** When migrating, delete these specific rule blocks (verified at HEAD):
- `inspector-deploy.css:94` `.inspector-tabs { ... }` — replaced by Tabs primitive styles.
- `inspector-meta.css:176` `.inspector-tabs-collapse { ... }` — keep the collapse button rule, retarget selector to the new wrapper element.

Any other `.inspector-tabs` rules surfaced by `grep -rn "inspector-tabs" apps/web/src/*.css` must be reviewed and either deleted (if covered by the primitive) or rewritten against the new DOM contract.

### Migration: scheduled-agent form → FormField family
- Edit `apps/web/src/scheduled-agent-form.tsx`: replace hand-rolled labels, inputs, textareas, and selects with `FormField`/`Label`/`Input`/`Textarea`/`Select`. Validation messages route through the `error` slot of `FormField`.
- Edit `apps/web/src/scheduled-agent-editor.tsx` if it shares the same form scaffolding.

### Migration: workspace-card status pills → Badge/Chip
- Edit `apps/web/src/workspace-card.tsx`: replace bespoke status pills (PR tone, approval tone, agent pulse) with `Badge` variants (`ready`/`blocked`/`info`/`warn`/`merged`/`neutral-strong`) and `Chip` where a leading dot or icon is appropriate.

### Dev-only showcase route

**Folder layout (avoids 800 LOC cap):** the showcase is split across one index file + one section file per primitive family. None of these files ship to production (see DEV-strip mechanism below). Target sizes ≤ 150 LOC each:

```
apps/web/src/routes/design-system/
  index.tsx          — page shell, theme toggle, section TOC, two-column light/dark wrapper
  buttons.tsx        — Button + IconButton sections
  badges.tsx         — Badge + Chip sections
  surfaces.tsx       — Card + Panel + EmptyState + Skeleton
  forms.tsx          — Input + Textarea + Select + Label + FormField
  overlays.tsx       — Dialog + Tooltip
  navigation.tsx     — Tabs
  feedback.tsx       — Toast (with trigger buttons emitting each variant)
```

Each section renders that family's variants × sizes × states (e.g., Button: all variants × `sm/default/lg/icon` × `loading`/`disabled`). The index wraps two side-by-side columns whose root elements set `data-theme="light"` and `data-theme="dark"` so a single page exercises both themes.

**DEV-strip mechanism (corrects an earlier wording bug):** Vite's `import.meta.env.DEV` is replaced with a literal `false` at production build time, so a **static** `if (import.meta.env.DEV) { ... }` branch is fully dead-code-eliminated, including any `import("...")` calls inside it. The route registration in `apps/web/src/main.tsx` therefore looks like:

```ts
if (import.meta.env.DEV) {
  const { designSystemRoute } = await import("./routes/design-system");
  router.addRoute(designSystemRoute);
}
```

The dynamic `import()` alone does **not** strip the chunk from `dist/` — only the static `if (import.meta.env.DEV)` guard does, because Vite tree-shakes the entire branch when the literal evaluates to `false`. The dynamic `import` is used inside the branch only so dev builds can keep the route lazy.

**Verification step (must pass before push):**
```bash
pnpm --filter @citadel/web build
test "$(grep -rEh "DesignSystem|design-system" apps/web/dist/assets/*.js 2>/dev/null | wc -l)" -eq 0 \
  || { echo "FAIL: showcase chunk shipped to production"; exit 1; }
```
List this command in the `## Verification` section so `make check`'s build artefacts are inspected for the showcase route.

### Dependencies (lockfile-sensitivity gate)

The three new top-level deps (`@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-tabs`) will pull additional `@radix-ui/*` shared packages and `@floating-ui/*` transitive deps. "Radix entries only" was unrealistic — the actual audit must cover the full transitive expansion.

Steps:

1. Capture the pre-change lockfile state: `cp pnpm-lock.yaml /tmp/lock.before.yaml`.
2. Add `@radix-ui/react-dialog`, `@radix-ui/react-tooltip`, `@radix-ui/react-tabs` to `apps/web/package.json`. Use the same version range pattern as the already-installed `@radix-ui/react-slot` (`^1.x`).
3. Run `pnpm install` from repo root.
4. Diff the lockfile: `diff /tmp/lock.before.yaml pnpm-lock.yaml | grep -E "^[<>] *resolution|^[<>] *  /" > /tmp/lock.diff.txt`.
5. For every package added that is **not** `@radix-ui/*`, document expected ownership (e.g., `@floating-ui/*` for Radix Tooltip positioning, `aria-hidden` for Dialog focus management). Any unexpected new top-level dep → stop, investigate.
6. Confirm none of the new packages — top-level **or transitive** — declare `preinstall`/`install`/`postinstall` lifecycle scripts: `pnpm list --depth Infinity --json | jq '.[] | select(.dependencies) | .. | objects | select(.scripts) | .scripts' 2>/dev/null` (or equivalent inspection). Radix and Floating UI historically ship script-free, but verify.
7. Run `pnpm audit --prod` — record any moderate+ advisories in the PR description.
8. Record the total transitive add count in the PR description.

No `package-lock.json` or `yarn.lock` may be introduced (pnpm-only repo).

### No schema changes

No schema changes. Citadel's SQLite schema in `packages/db/src/index.ts` is untouched. `PRAGMA foreign_keys = ON;` not affected. No `schema_migrations` row needed.

### Tests (TDD order)
See QA/Test Strategy below and the `## Tests` section for concrete file paths.

### Verification (run before push)
See `## Verification` section.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | One test file per primitive verifying variant rendering, state transitions, accessibility attributes (`role`, `aria-*`), keyboard handling, and the `className` escape hatch. Tokens consolidation gets a regression test that the canonical `--c-canvas` token resolves at runtime (smoke test imports `tokens.css` via `happy-dom`). Migration sites get focused tests that the migrated component still emits the expected DOM contract (e.g. `Inspector` still exposes `data-active` on its tab strip). |
| E2E (Playwright) | **Required** | One new spec `e2e/design-system.spec.ts` mounts `/design-system` (dev build), iterates each primitive section, and asserts visible + interactive. Existing specs (`operator-cockpit.spec.ts`, `scratchpad-blocks.spec.ts`, `theme-audit.spec.ts`) must still pass — modal flows, scheduled-agent form, inspector tabs, and theme switching are exercised by them. `theme-audit.spec.ts` is the key safety net for the token consolidation: any unintended color drift will fail it. |

### New tests to add

**Unit (Vitest, colocated):**

- `apps/web/src/components/ui/button.test.tsx` — variants × sizes × `loading` × `disabled`; spinner renders only when `loading`; `disabled` true while loading; `asChild` polymorphism intact.
- `apps/web/src/components/ui/badge.test.tsx` — all variants render with token-driven background; `dot` prop renders a leading circle element.
- `apps/web/src/components/ui/card.test.tsx` — renders children; accepts `className`; root element has `data-component="card"`.
- `apps/web/src/components/ui/panel.test.tsx` — composition with header/body/footer; header element is `<header>`; uppercase title style flag.
- `apps/web/src/components/ui/input.test.tsx` — focus ring class applied; `disabled` styling; controlled value mirroring; `aria-invalid` styling.
- `apps/web/src/components/ui/select.test.tsx` — native `<select>` semantics; option list rendering; `disabled` state.
- `apps/web/src/components/ui/form-field.test.tsx` — `Label` is associated to the inner control via `htmlFor`/`id` (generates an id if not provided); error slot is announced via `aria-describedby`; required marker rendering.
- `apps/web/src/components/ui/tabs.test.tsx` — keyboard arrow navigation (Radix gives this); `TabsContent` only mounts active panel by default; `data-state="active|inactive"` on triggers.
- `apps/web/src/components/ui/dialog.test.tsx` — opens on trigger click; closes on `Esc`; closes on backdrop click; focus moves into the dialog on open and restores on close; portal-rendered.
- `apps/web/src/components/ui/tooltip.test.tsx` — opens on focus + on hover after delay; closes on blur/leave; `role="tooltip"` and `aria-describedby` wired.
- `apps/web/src/components/ui/chip.test.tsx` — icon slot rendering; `onClose` button rendering + click handler + `aria-label` enforcement.
- `apps/web/src/components/ui/icon-button.test.tsx` — TS-level test (no-op at runtime) plus a runtime assertion that the rendered `<button>` carries the `aria-label`; rendering without `aria-label` produces a dev-mode console warning.
- `apps/web/src/components/ui/empty-state.test.tsx` — icon + heading + description + optional CTA; CTA invokes handler.
- `apps/web/src/components/ui/skeleton.test.tsx` — renders with `aria-busy="true"` and `role="status"`; respects `width`/`height` props.
- `apps/web/src/components/ui/toast.test.tsx` — `toast(...)` enqueues; `<Toaster />` renders the message; auto-dismiss after timeout; manual dismiss via close button; max-queue behavior (e.g., 5 simultaneous). **Fake-timer setup (avoids known happy-dom + React act flake):** `vi.useFakeTimers({ shouldAdvanceTime: false })` in `beforeEach`, drive time forward with `await vi.advanceTimersByTimeAsync(5000)`, wrap each enqueue/dequeue inside `act(...)` from `@testing-library/react`, restore real timers in `afterEach(() => vi.useRealTimers())`.
- `apps/web/src/design-system/tokens.test.ts` — **data-driven from `tokens.inventory.txt`**, not from prose in the README:
  1. Read the inventory file at test time (`fs.readFileSync`).
  2. Inject `tokens.css` content into a `<style>` element appended to `document.head` (under happy-dom).
  3. For each `data-theme` value in `["light", "dark"]`, set `document.documentElement.dataset.theme = theme` and assert that every token in the inventory resolves to a non-empty string via `getComputedStyle(document.documentElement).getPropertyValue(name)`.
  4. **Coverage gap documented:** happy-dom does not simulate `prefers-color-scheme`, so tokens defined only inside `@media (prefers-color-scheme: ...)` blocks would not be reachable in this test. Token consolidation Step 2 above eliminates this gap by moving all tokens into explicit `data-theme` blocks; the test will fail if any token regresses back into a `prefers-color-scheme` block.
  5. Asserts a strict equality: the set of resolved tokens equals the set in `tokens.inventory.txt` (catches added-but-undocumented tokens and removed tokens).

**E2E (Playwright):**

- `e2e/design-system.spec.ts` — only runs when `import.meta.env.DEV`-equivalent is true (the isolated dev server `pnpm e2e:isolated` runs in dev mode by default). Asserts:
  1. `/design-system` route loads with no console errors.
  2. Every primitive section is visible (assert by `data-section="button"`, `data-section="dialog"`, etc.).
  3. Dialog trigger opens, `Esc` closes.
  4. Tabs keyboard navigation moves selection.
  5. Toast trigger emits a toast that auto-dismisses.
  6. Theme toggle on the showcase page flips `data-theme` and at least one token-driven background visibly changes (assert via `page.evaluate(getComputedStyle)` snapshot before/after).

### Existing tests to update

- `apps/web/src/inspector.test.ts` — adjust selectors if the migration changes the DOM structure of the inspector tab strip. Keep test intent (tab switching, default tab is `stats`) unchanged. Assert `data-active={tab}` lands on the `TabsList` wrapper element (the load-bearing selector for `inspector-deploy.css`).
- `apps/web/src/workspace-card.test.ts` — verified to exist at HEAD. Adjust selectors for migrated status pills (now `Badge` elements with `data-variant`). Re-target away from class-name assertions toward `data-variant`, `data-state`, `role`.
- `e2e/operator-cockpit.spec.ts` — Modal interactions: update selectors for Dialog (Radix uses `role="dialog"` and `data-state` attributes). Behavior assertions unchanged.
- `e2e/theme-audit.spec.ts` — should *not* require changes; it asserts cross-theme correctness, which is exactly what the token consolidation must preserve. If it fails after the refactor, treat that as a regression to fix, not a test to weaken.

### Required new test (verified absent at HEAD)

- `apps/web/src/scheduled-agent-form.test.tsx` — **does not exist today** (verified). Required as part of this PR because the migration changes the rendering of every form field. Assertions:
  - Each form input has an associated `Label` (queryable via `getByLabelText`).
  - Required-field validation: submitting empty form surfaces the error in `FormField`'s error slot with `aria-describedby` wiring.
  - Validation timing is preserved (matches pre-migration behavior — on-submit, not on-change unless previously on-change).
  - Submit button enabled/disabled state tracks form validity.
  - All field labels remain accurate after migration (no regression where a label got dropped from a now-FormField-wrapped control).

### Assertions to add/change/tighten

- **New:** every primitive test asserts the focus-visible ring is present (`focus-visible:ring-2`) — the design system enforces a single, consistent focus treatment.
- **New:** Dialog test asserts focus is trapped (Tab cycles within the dialog) — exercised by triggering Tab and asserting `document.activeElement` is still within the dialog content.
- **Tightened:** `inspector.test.ts` and `workspace-card.test.ts` previously asserted on bespoke class names. After migration, assert on stable semantic attributes (`data-variant`, `data-state`, `role`) instead of CSS class names — class names should not be part of the public contract.
- **New:** `tokens.test.ts` asserts that every token name in `apps/web/src/design-system/tokens.inventory.txt` resolves to a non-empty value at runtime in both `data-theme="light"` and `data-theme="dark"`. Assertion is strict set equality: tokens added without inventory updates also fail (catches accidental token removal AND undocumented additions).
- **New:** ARIA assertions on `Toast` (`role="status"` for non-critical, `role="alert"` for danger variant).

### Failure modes / edge cases / regression risks

- **Token consolidation drops a token:** a single missing `--color-warning` or `--c-line-2` cascades into broken visual treatment across the cockpit. Mitigation: `tokens.test.ts` enumerates and asserts every token name. Plus `theme-audit.spec.ts` catches color drift.
- **Radix Dialog focus trap breaks an existing modal flow:** e.g. an outside-click handler in `command-palette.tsx` (`mousedown` listener on `document`) might race with Radix's portal handling. Mitigation: explicit E2E coverage of every migrated modal (create-workspace, add-repo) in `operator-cockpit.spec.ts`.
- **Radix Tabs changes the DOM contract that `inspector-checks.css` / `inspector-deploy.css` rules depend on:** existing CSS selectors targeting `.inspector-tabs button[data-active="true"]` may stop matching. Mitigation: preserve `data-active` on the migrated `TabsTrigger` via a custom wrapper if needed; explicit visual check in showcase + theme-audit spec.
- **Tooltip provider not mounted at root:** primitives render with no tooltip. Mitigation: assertion in `main.tsx` test that `TooltipProvider` is in the tree; bookkeeping in the design system README.
- **Bundle size regression:** three new Radix packages add ~30–50KB gzipped combined. Acceptable, but flagged. Mitigation: `make check` includes `build` step; record `dist/` size in PR description.
- **Showcase route accidentally ships to production:** `import.meta.env.DEV` guard is a build-time check in Vite — if a developer hard-codes the route, prod gets it. Mitigation: build the route module lazily via dynamic `import()` so tree-shaking strips it; an additional `vite.config.ts` guard would belong in a follow-up.
- **Migrated form loses validation behavior:** scheduled-agent form has custom validation timing. Mitigation: keep existing validation logic intact, only swap presentation. Test: `scheduled-agent-form.test.tsx` (if it exists; otherwise add one) asserts an invalid input shows the error in `FormField`'s error slot.
- **Theme switching slow:** consolidation could regress theme-toggle perf if it forces a style recalc on every primitive. Mitigation: tokens stay as CSS custom properties (already the case) so theme switching is a single attribute update.
- **Bespoke CSS still wins specificity wars:** migrated screens may have higher-specificity legacy rules in `cockpit-extras.css` that override primitive Tailwind classes. Mitigation: when migrating, scan the screen's bespoke CSS and remove rules now handled by the primitive. E2E theme-audit catches visible regressions.

### Adversarial analysis

- **How could this fail in production?** A token rename silently breaks an unmigrated screen; a Radix Dialog upgrade later changes ARIA wiring; the showcase route ships to prod and exposes internal patterns. Mitigation: token regression test, pinned Radix versions, `import.meta.env.DEV` guard + lazy import.
- **What user actions trigger unexpected behavior?** Opening a modal during a slow render: Radix's focus trap may fire before children mount, causing a brief flash. Tested in E2E with consecutive modal opens.
- **What existing behavior could break?** Inspector tab keyboard nav (Radix's arrow-key default may differ from current click-only behavior — that's an improvement, but assert it via test); modal `Esc` handling chains (Citadel may have a global `Esc` handler that closes modals — verify it still fires when Radix Dialog is open).
- **Which tests credibly catch those failures?** `e2e/operator-cockpit.spec.ts` (modal flows + inspector tabs + scheduled-agent form), `e2e/theme-audit.spec.ts` (color drift), `e2e/design-system.spec.ts` (primitive contract), `inspector.test.ts`, `workspace-card.test.ts`, and the new `tokens.test.ts`.
- **What gaps remain?** Visual regression is asserted by `theme-audit.spec.ts` only across a small set of cockpit screenshots. Comprehensive visual coverage (Percy/Chromatic) is out of scope for this PR; the deferred follow-up PRs that migrate the remaining surfaces will need their own visual audit.

## Tests

Test files to create (TDD: write each before its primitive implementation):

```
apps/web/src/components/ui/button.test.tsx
apps/web/src/components/ui/badge.test.tsx
apps/web/src/components/ui/card.test.tsx
apps/web/src/components/ui/panel.test.tsx
apps/web/src/components/ui/input.test.tsx
apps/web/src/components/ui/select.test.tsx
apps/web/src/components/ui/form-field.test.tsx
apps/web/src/components/ui/tabs.test.tsx
apps/web/src/components/ui/dialog.test.tsx
apps/web/src/components/ui/tooltip.test.tsx
apps/web/src/components/ui/chip.test.tsx
apps/web/src/components/ui/icon-button.test.tsx
apps/web/src/components/ui/empty-state.test.tsx
apps/web/src/components/ui/skeleton.test.tsx
apps/web/src/components/ui/toast.test.tsx
apps/web/src/design-system/tokens.test.ts
apps/web/src/scheduled-agent-form.test.tsx   ← required; does not exist at HEAD
e2e/design-system.spec.ts
```

Test files to update:

```
apps/web/src/inspector.test.ts          — re-target selectors to Tabs DOM contract; assert data-active on TabsList wrapper
apps/web/src/workspace-card.test.ts     — re-target selectors to Badge/Chip DOM contract
e2e/operator-cockpit.spec.ts            — update modal selectors to Radix Dialog
```

`e2e/theme-audit.spec.ts` is **expected to pass unchanged** — any failure indicates a token consolidation bug.

## Schema or contract generation

Not applicable. No `@citadel/contracts` changes; no API surface changes; no DB migrations.

## Verification

Run before pushing:

- `make check` — `check:arch`, `check:size`, `typecheck`, `lint` (biome), `test` (vitest), `coverage` (vitest --coverage), `check:deps` (verifies the new Radix deps are policy-compliant), `build`. **Coverage note:** the 90% line-coverage target documented in `docs/contributors/v2-engineering-standards.md` applies to `packages/core`, the daemon backend, and shared packages — not `apps/web`. New primitives lift overall coverage without crossing a guarded boundary in this PR. Confirm the exact guarded paths against `vitest` config before push and quote them in the PR description.
- **Showcase route DEV-strip verification** (run after `pnpm --filter @citadel/web build`):
  ```bash
  pnpm --filter @citadel/web build
  # Use a unique marker that only appears in showcase code (not a generic "design-system" string
  # that could legitimately appear in aria-labels, route paths, or Tailwind class fragments).
  # The showcase entry exports a marker constant `DESIGN_SYSTEM_SHOWCASE_MARKER` consumed by the
  # route registration; if Vite tree-shakes the branch correctly the marker disappears from dist/.
  test "$(grep -rEh "DESIGN_SYSTEM_SHOWCASE_MARKER" apps/web/dist/assets/*.js 2>/dev/null | wc -l)" -eq 0 \
    || { echo "FAIL: showcase chunk shipped to production"; exit 1; }
  # Belt and braces: confirm no chunk filename derived from the route folder name shipped either.
  test "$(find apps/web/dist/assets -name "*design-system*" 2>/dev/null | wc -l)" -eq 0 \
    || { echo "FAIL: showcase chunk filename present in dist"; exit 1; }
  ```
  Non-zero exit means the showcase route leaked into the production bundle — blocks push. The `DESIGN_SYSTEM_SHOWCASE_MARKER` constant must be exported from `apps/web/src/routes/design-system/index.tsx` so the grep has a unique signature.
- **Bundle-size snapshot** (no automated gate exists, so capture explicitly for the PR):
  ```bash
  git fetch origin main
  git worktree add /tmp/baseline-ds origin/main
  (cd /tmp/baseline-ds && pnpm install --prefer-offline && pnpm --filter @citadel/web build)
  du -sh /tmp/baseline-ds/apps/web/dist/assets > /tmp/dist-before.txt
  pnpm --filter @citadel/web build
  du -sh apps/web/dist/assets > /tmp/dist-after.txt
  diff /tmp/dist-before.txt /tmp/dist-after.txt
  git worktree remove /tmp/baseline-ds
  ```
  Record both sizes in the PR description. Expected delta from three Radix deps: ~30–50KB gzipped. Larger-than-expected deltas → investigate before merge.
- `make e2e` — Playwright happy-path tests including the new `design-system.spec.ts`. Run isolated (`pnpm e2e:isolated`) per **B.8 Test Isolation #3** so the operator's dev daemon is not affected.
- `make smoke` — **not required**. No daemon HTTP-surface changes.
- `make performance` — **not required**. No startup or render-hot-path changes.

## Reviewability strategy (per-commit boundaries)

This is intentionally a single PR because the goal is to prove the primitives against four real consumers — splitting blocks that. To keep the diff reviewable, organize commits so each is independently reviewable with green CI:

1. `feat(design-system): consolidate tokens into design-system/tokens.css` — token inventory + `tokens.css` + `styles.css` `@import` + `tokens.test.ts` + README. No primitive changes.
2. `feat(design-system): extend Button + Badge variants` — Button (`destructive`/`link`/`loading`, new sizes) + Badge (new variants + dot) + tests.
3. `feat(design-system): add Card, Panel, EmptyState, Skeleton primitives` — each with colocated test.
4. `feat(design-system): add form-field primitives` — Input, Textarea, Select, Label, FormField, HelpText + tests.
5. `feat(design-system): add Tabs primitive (Radix)` — adds `@radix-ui/react-tabs` + Tabs + test.
6. `feat(design-system): add Dialog primitive (Radix)` — adds `@radix-ui/react-dialog` + Dialog + test.
7. `feat(design-system): add Tooltip primitive (Radix)` — adds `@radix-ui/react-tooltip` + TooltipProvider mount in main.tsx + test.
8. `feat(design-system): add Chip + IconButton + Toast primitives` — Chip, IconButton, Toast (+ `<Toaster />` mount) + tests.
9. `feat(design-system): /design-system showcase route (dev-only)` — folder layout + main.tsx DEV-guarded registration + `e2e/design-system.spec.ts` + the dist-grep verification step.
10. `refactor(modals): migrate modals.tsx to Dialog primitive` — modals.tsx + modals.css cleanups + e2e selector updates.
11. `refactor(inspector): extract inspector-tabs and migrate to Tabs primitive` — new `inspector-tabs.tsx` + slimmed `inspector.tsx` + inspector-*.css cleanups + inspector.test.ts updates.
12. `refactor(workspace-card): migrate status pills to Badge/Chip` — workspace-card.tsx + test updates.
13. `refactor(scheduled-agent-form): migrate to FormField family` — scheduled-agent-form.tsx + new scheduled-agent-form.test.tsx.
14. `docs(spec): annotate B.8 #4 as partial — first-wave primitives shipped` — single-line spec annotation.

Each commit must keep `make check` green so reviewers can bisect. The PR description includes the bundle-size diff, the lockfile transitive add count, and a per-commit reading order.
