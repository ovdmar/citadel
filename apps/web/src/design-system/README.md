# Citadel cockpit design system

A small, dependency-light primitive layer that the cockpit composes from.
Three concerns live here: **tokens** (`tokens.css`), **primitives**
(`apps/web/src/components/ui/`), and a **dev-only showcase route**
(`apps/web/src/routes/design-system/`).

## Tokens

`tokens.css` is the single canonical source for every CSS custom property
the cockpit uses. `styles.css` imports it once at the top of the file;
component CSS reads tokens via `var(--token-name)`.

The companion `tokens.inventory.txt` enumerates every token the cockpit
references. `tokens.test.ts` asserts the inventory and the CSS file stay in
lockstep: the `:root` block must declare every inventoried token, every
token the dark block redeclares must exist in the inventory, and the
OS-driven dark fallback block must mirror the explicit dark block exactly.

### Cascade

```
:root                                                = light defaults
:root[data-theme="dark"]                             = explicit dark
:root[data-theme="light"]                            = explicit light (no overrides needed)
@media (prefers-color-scheme: dark)
  :root:not([data-theme="light"]):not([data-theme="dark"])
                                                     = OS-driven dark when no theme picked
```

Why no `prefers-color-scheme: light` block: every token is reachable via
explicit `data-theme` selectors. happy-dom's CSS engine doesn't simulate
`prefers-color-scheme` reliably, so the token test would have a coverage
gap; folding the light fallback into `:root` closes that gap. The visual
cascade for OS-driven theme switching is verified by
`e2e/theme-audit.spec.ts` in real browsers.

### Adding a new token

1. Add the token + value to **all three** blocks of `tokens.css` (`:root`,
   `:root[data-theme="dark"]`, and the OS-dark `@media` block).
2. Append the name to `tokens.inventory.txt` in alphabetical position.
3. Run `pnpm vitest run apps/web/src/design-system/tokens.test.ts`. If it
   fails, the token is missing from one of the blocks or the inventory.

### Component-local tokens

Layout helpers defined inside a single component CSS file (e.g.
`--right-slot` in `cockpit-extras.css`, `--set-font-serif` in
`settings-ia.css`) are **not** design-system tokens. They live with their
component and never enter `tokens.inventory.txt`.

## Primitives

React primitives live under `apps/web/src/components/ui/`:

| Primitive | Variants | Backed by |
|---|---|---|
| `Button` | default, secondary, ghost, destructive, link; sizes `sm` / `default` / `lg` / `icon`; `loading` state | CVA + Tailwind |
| `Badge` | neutral, ready, blocked, info, warn, merged, neutral-strong; optional `dot` | CVA + Tailwind |
| `Card`, `Panel` | Panel + Header/Body/Footer; uppercase compact label slot | CVA + Tailwind |
| `Input`, `Textarea`, `Select`, `Label`, `HelpText`, `FormField` | filled, empty, error, disabled | Native form controls |
| `Tabs` | compact pill style | `@radix-ui/react-tabs` |
| `Dialog` | center-aligned, backdrop-dismiss, Esc-close, focus-trap | `@radix-ui/react-dialog` |
| `Tooltip` | configured root provider (see below) | `@radix-ui/react-tooltip` |
| `Chip` | leading icon slot + optional close X | composes `Badge` |
| `IconButton` | TS-enforced `aria-label`; excludes `asChild` | composes `Button` |
| `EmptyState` | icon + heading + description + optional CTA | composed |
| `Skeleton` | shimmer placeholder, aria-busy + role=status | composed |
| `Toast` | `<Toaster />` region + `useToast()` hook; variants default / success / warning / danger | custom (`useSyncExternalStore`) |

All primitives:

- Read colors from tokens — no hard-coded hex values in component files.
- Expose a `className` escape hatch merged via `cn(...)`.
- Render a `focus-visible:ring-2` focus indicator (single consistent focus
  treatment across the cockpit).

### TooltipProvider defaults

Mount **one** `TooltipProvider` at the cockpit root (`apps/web/src/main.tsx`)
with cockpit-tuned defaults:

```tsx
<TooltipProvider delayDuration={250} skipDelayDuration={100}>
  ...
</TooltipProvider>
```

`delayDuration={250}` is faster than Radix's 700 ms default — matches
**B.8 #3** ("calm, dense, premium, operational"). `skipDelayDuration={100}`
keeps the dense tooltip cluster on the inspector and chrome instantly
responsive once the first tooltip has shown.

## Dev-only showcase

The `/design-system` route renders every primitive's variants in both
themes. The route lives under `apps/web/src/routes/design-system/` and is
registered behind a static `if (import.meta.env.DEV) { ... }` guard, which
Vite tree-shakes out of production builds. A grep verification step in
`make check` confirms the chunk is absent from `dist/`.
