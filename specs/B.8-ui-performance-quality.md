# [B.8] UI, Performance, And Release Quality

**Status:** Draft

> Citadel should feel like a premium operational cockpit and remain fast under realistic agent load.

## UI Quality

[~] 1. Citadel uses a workspace-first cockpit layout.
[~] 2. Settings is secondary to the cockpit.
[ ] 3. The UI is calm, dense, premium, and operational.
[ ] 4. shadcn-style components are used where they improve consistency and speed.
[ ] 5. The UI has theme support.
[ ] 6. Workspace rows are compact and scannable.
[ ] 7. Status language is concrete and operator-facing.
[ ] 8. Primary actions, secondary actions, links, statuses, and metadata have distinct visual treatment.
[ ] 9. Desktop key views have screenshot review before release.
[ ] 10. Mobile key views have screenshot review before release.
[ ] 11. Mobile supports monitoring and light actions.

## Navigation

[ ] 1. The workspace navigator is always easy to reach from the main cockpit.
[ ] 2. Settings are accessible through a secondary control.
[ ] 3. Repository settings are reachable from repository rows and workspace context.
[ ] 4. Global activity/operations are reachable while preserving cockpit context.
[ ] 5. Keyboard-friendly search or command access exists for common cockpit actions.

## Performance

[ ] 1. Citadel feels instant with 10-12 active workspaces across 2-3 repositories.
[ ] 2. Workspace switching remains responsive with long terminal buffers.
[ ] 3. Provider summaries load independently from the main workspace shell.
[ ] 4. Slow provider commands appear as stale/degraded states.
[ ] 5. Terminal scrollback is bounded or virtualized.
[ ] 6. Normal navigation transfers only the terminal data needed for the active view.
[ ] 7. Main happy paths have performance smoke coverage.

## Release Quality

[~] 1. Unit/integration tests cover domain, daemon, providers, hooks, operations, and terminal behavior.
[~] 2. Playwright covers the main happy path.
[ ] 3. E2E covers first-run/configured state.
[ ] 4. E2E covers add repository and remove repository flows.
[ ] 5. E2E covers create workspace and remove workspace flows.
[ ] 6. E2E covers workspace cockpit readiness.
[ ] 7. E2E covers terminal smoke.
[ ] 8. E2E covers provider degraded state.
[ ] 9. E2E covers hook app/action output.
[ ] 10. E2E covers desktop and mobile layout.
[ ] 11. Release checks include format, typecheck, lint, test, e2e, production build, and performance smoke.
[ ] 12. Coverage targets are meaningful and behavior-oriented.

---

keywords: ui, shadcn, cockpit, navigation, performance, mobile, screenshots, e2e, release quality
