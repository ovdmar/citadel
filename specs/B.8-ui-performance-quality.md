# [B.8] UI, Performance, And Release Quality

**Status:** Draft

> Citadel should feel like a premium operational cockpit and remain fast under realistic agent load.

## UI Quality

[~] 1. Citadel uses a workspace-first cockpit layout.
[~] 2. Settings is secondary to the cockpit.
[ ] 3. The UI is calm, dense, premium, and operational.
[ ] 4. shadcn-style components are used where they improve consistency and speed.
[~] 5. The UI has theme support. The theme selector is a single cycling button with three states (Light / Dark / System); System resolves via `prefers-color-scheme`. Toggling the cockpit theme re-themes every open terminal in place — no full reload, no confirm prompt — by respawning each ttyd instance with the new palette (theme is baked at ttyd boot). Respawns are staggered to avoid spawn-storm regressions, rapid toggles coalesce via a sequence token, and OS-driven theme flips on the System setting follow the same code path. Theme propagation into `ttyd.ensure()` is a hard invariant: `theme` is a required argument and the daemon route always sources it from the disk-backed `ThemePrefStore`; there is no silent dark fallback inside the terminal manager.
[ ] 6. Workspace rows are compact and scannable.
[ ] 7. Status language is concrete and operator-facing.
[ ] 8. Primary actions, secondary actions, links, statuses, and metadata have distinct visual treatment.
[ ] 9. Desktop key views have screenshot review before release.
[ ] 10. Mobile key views have screenshot review before release.
[~] 11. Mobile supports monitoring and light actions. The mobile shell stays fixed at the viewport (`100dvh`); the mobile switcher chooses Navigator/Stage/Inspector; the Stage column owns its own scroll and the xterm host receives a definite height so it never collapses or page-scrolls.
[ ] 12. The default theme is a dark-blue v1-inspired palette: deep navy/slate background, lighter slate panels, cyan/sky accent for selection and primary actions.
[ ] 13. The three-column cockpit shell has independently resizable side columns with drag handles between columns.
[ ] 14. The three-column cockpit shell has independently collapsible side columns; the collapse control sits at the top-right of the left navigator and the top-left of the right inspector.
[ ] 15. A collapsed side column shows only its expand affordance, not the column body.
[ ] 16. The app shell never page-scrolls; each column owns its own scroll context.

## Navigation

[ ] 1. The workspace navigator is always easy to reach from the main cockpit.
[ ] 2. Settings are accessible through a secondary control in the slim top bar.
[ ] 3. Repository settings are reachable from repository rows and workspace context.
[ ] 4. Global activity/operations are reachable while preserving cockpit context.
[ ] 5. Keyboard-friendly search or command access exists for common cockpit actions.
[ ] 6. The slim top bar exposes a centered search input that opens the command palette modal on click or Cmd+K.
[ ] 7. The command palette fuzzy-matches workspaces by name, title, branch, repo, attached issue key/title, attached PR number/URL, and current attention status.
[ ] 8. The navigator left column has top-level entries for *Dashboard* (kanban by status) and *History* (archived workspaces with PR snapshot and unarchive control).
[ ] 9. The navigator separates Dashboard/History from the workspaces list with a subtle divider, and exposes group-by/add-repo/create-workspace icon controls next to the *Workspaces* header.
[ ] 10. The Dashboard route surfaces the kanban as its primary content, framed by a compact header that contains only a back-to-cockpit link. No oversized page title is rendered.
[ ] 11. The History route also exposes a back-to-cockpit link in its compact header, matching the Dashboard treatment.
[ ] 12. Settings and onboarding surfaces follow the cockpit's dark-blue dense aesthetic: slim sub-nav, small uppercase panel titles, compact health/setup rows, no wall-of-form layouts.

## Performance

[~] 1. Citadel feels instant with 10-12 active workspaces across 2-3 repositories and remains usable at large operator loads (target: 50 workspaces with 3-5 agent sessions each) without pre-spawning one terminal renderer process per session.
[~] 2. Workspace switching remains responsive with long terminal buffers. The cockpit's terminal path reuses browser xterm.js panes over daemon WebSockets and disposable node-pty tmux attach viewers instead of forcing iframe or renderer-process startup on every cache miss. Terminal renderer stability includes opaque xterm surfaces and coalesced/de-duped active-pane resize controls so repaint or layout churn does not make the terminal unreadable.
[ ] 3. Provider summaries load independently from the main workspace shell.
[ ] 4. Slow provider commands appear as stale/degraded states.
[ ] 5. Terminal scrollback is bounded or virtualized. The tmux server enforces a global `history-limit` (default 5000 lines per pane) so a forgotten session can't grow per-pane scrollback without bound.
[~] 6. Normal navigation transfers only the terminal data needed for mounted views: tmux's current visible state on attach plus live PTY output while the pane is mounted.
[ ] 7. Main happy paths have performance smoke coverage.

## Release Quality

[~] 1. Unit/integration tests cover domain, daemon, providers, hooks, operations, and terminal behavior.
[~] 2. Playwright covers the main happy path.
[ ] 3. E2E covers first-run/configured state.
[ ] 4. E2E covers add repository and remove repository flows.
[ ] 5. E2E covers create workspace and remove workspace flows.
[ ] 6. E2E covers workspace cockpit readiness.
[ ] 7. E2E covers terminal smoke, including both WebSocket transport behavior and cockpit renderer stability for the active xterm surface.
[ ] 8. E2E covers provider degraded state.
[ ] 9. E2E covers hook app/action output.
[ ] 10. E2E covers desktop and mobile layout.
[ ] 11. Release checks include format, typecheck, lint, test, e2e, production build, and performance smoke.
[ ] 12. Coverage targets are meaningful and behavior-oriented.

## Test Isolation (source of truth)

[~] 1. Tests must never write into the operator's working Citadel state.
[~] 2. Vitest tests must allocate temporary directories via `fs.mkdtempSync(path.join(os.tmpdir(), ...))` instead of relying on the default `CITADEL_DATA_DIR`.
[~] 3. Playwright tests must run against a daemon started with an isolated `CITADEL_DATA_DIR` and ports that cannot collide with the operator's dev daemon (4010) or web (5175).
[~] 4. Citadel provides `pnpm test:isolated` and `pnpm e2e:isolated` wrappers (see `scripts/dev/test-isolated.ts`). They allocate a fresh `CITADEL_DATA_DIR` under `os.tmpdir()`, randomise Playwright ports out of the dev range, and clean up after the run unless `CITADEL_TEST_KEEP=1`.
[ ] 5. **Future:** a containerised e2e runner that pins Node, pnpm, `gh`, `git`, and tmux versions for fully reproducible CI. For now, the isolated scripts above are the documented entry point.

---

keywords: ui, shadcn, cockpit, navigation, performance, mobile, screenshots, e2e, release quality
