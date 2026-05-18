# MS-471 Citadel v3 Handoff

## Changed areas

- Added normalized workspace cockpit contracts and API summary for readiness, git status, PR/check context, CI, issue context, discovered apps/links/actions, and hook diagnostics.
- Added repo hook capability events: `workspace.apps` and `workspace.action`, with structured app/link/action payload validation and action execution through operations.
- Reworked the web cockpit into a workspace-first operator surface: no permanent app rail, compact repo/readiness navigator, readiness strip, review panel, git status detail, app/action surface, and hook diagnostics.
- Kept Settings secondary through top-right/route access and preserved theme controls.
- Improved diff status with added/deleted line counts and git porcelain/ahead/behind counts.
- Isolated Playwright daemon data with `CITADEL_DATA_DIR=/tmp/citadel-playwright-data` so local user config cannot break e2e ports.

## Verification run

- `pnpm format`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm e2e`
- `pnpm check`
- `pnpm performance`

## Test status

- Unit/integration: 59 passed.
- Playwright: 10 passed, 5 intentionally skipped by project guards.
- Full check: passed, including architecture boundaries, file size, typecheck, lint, tests, coverage, dependency policy, and production build.
- Performance smoke: passed on warm dev server run: `api_state 597ms`, `provider_summary 12ms`, `web_ade_visible 1220ms`, `workspace_switch_long_buffers 434ms`, `workspace_settings_switch 264ms`.

## QA path

1. Open the cockpit and confirm the left side is the compact workspace navigator, not a Workspaces/Settings rail.
2. Create/register a repo and create 2-3 workspaces; verify repo grouping, readiness labels, and session counts are scannable.
3. Open a workspace with dirty files and verify the readiness strip, Review tab, Diff tab, git raw lines/counts, and terminal still work.
4. Configure a `workspace.apps` hook returning applications, links, and an executable action; verify the app/action surface and hook diagnostics explain the source payload.
5. Run a workspace action and confirm operation/activity output remains visible after completion or failure.
