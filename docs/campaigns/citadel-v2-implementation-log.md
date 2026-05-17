# Citadel v2 Implementation Log

## 2026-05-17

- Started the headless implementation campaign on `main`.
- Confirmed `docs/campaigns/citadel-v2-goal.md` and Jira `MS-496` are the campaign contract.
- Fetched Jira child-task source material for `MS-472` through `MS-497`; a subagent summarized `MS-478` through `MS-488` provider/UI/MCP/security/test requirements.
- Replaced the old flat npm-era structure with the target pnpm workspace shape:
  - `apps/daemon`
  - `apps/web`
  - `apps/cli`
  - `packages/core`, `contracts`, `config`, `db`, `operations`, `terminal`, `runtimes`, `providers`, `hooks`, `mcp`, `ui`, `testing`
  - `scripts/checks`, `scripts/dev`, `docs/architecture`, `docs/operations`, `docs/contributors`, `e2e`
- Removed obsolete v1 server/web files, npm lockfile, and the old OpenClaw UI/server routes from the active v2 tree.
- Added strict TypeScript project references, pnpm workspace metadata, Biome config, Makefile command surface, architecture boundary check, file-size check, dependency lockfile policy, and startup smoke script.
- Added initial typed contracts, local config loader, SQLite schema/migration/repository layer, operation service, provider health checks, runtime health checks, tmux session creation, terminal WebSocket bridge, MCP status/resource helpers, daemon REST/SSE endpoints, and a dense operator cockpit UI.
- Ran `pnpm test`: 4 tests passed across `packages/core` and `packages/db`.
- Ran `pnpm coverage`: command completed, but total coverage is currently 14.59% statements and does not satisfy the final 90% campaign gate.
- Ran `pnpm check`: passed architecture boundaries, file-size check, typecheck, Biome, tests, coverage command, dependency policy, and build.
- Ran `make check`: passed the Makefile command surface for the same gates.
- Started the local daemon at `http://127.0.0.1:4337` and web UI at `http://127.0.0.1:5173`.
- Ran `pnpm smoke`: `/api/health`, `/api/state`, and `/api/mcp/status` passed.
- Exercised the core smoke path against the running daemon:
  - registered `/home/jonsnow/Workspace/citadel` as repo `repo_mp9rtdix_qxm4c95u`,
  - created real git worktree workspace `ws_mp9rthge_4n4s2g9z` at `/home/jonsnow/Workspace/citadel-worktrees/smoke-1779022089`,
  - started shell runtime session `sess_mp9rupj4_v95pfdv2` in tmux session `citadel_ws_mp9rthge_4n4s2g9z_0bbu8fpq`,
  - verified terminal WebSocket input by sending `pwd` and confirming output from the same worktree tmux session.
- Installed Playwright Chromium with `pnpm exec playwright install chromium`.
- Added and ran Playwright desktop/mobile smoke tests: 4 passed.
- Captured screenshots:
  - `docs/campaigns/screenshot-desktop-cockpit.png`
  - `docs/campaigns/screenshot-desktop-settings.png`
  - `docs/campaigns/screenshot-mobile-cockpit.png`
  - `docs/campaigns/screenshot-mobile-settings.png`
- Implemented workspace removal safety:
  - `DELETE /api/workspaces/:workspaceId` checks dirty git status,
  - dirty workspaces fail destructive cleanup with HTTP 409 unless explicit force or metadata-only archive is used,
  - metadata-only archive remains available,
  - tmux sessions are killed only for destructive cleanup.
- Implemented bounded read-only diff endpoint `GET /api/workspaces/:workspaceId/diff` with staged/unstaged/untracked status parsing, binary/truncation flags, and untracked file previews.
- Added cockpit diff panel and metadata archive action.
- Added cockpit create panel for repo registration and scratch/issue workspace creation, so the configured-state workflow is available from the UI and not only through REST calls.
- Verified diff/removal manually against `ws_mp9rthge_4n4s2g9z`:
  - created untracked `citadel-diff-smoke.txt`,
  - diff endpoint returned `clean=false` and a bounded preview,
  - destructive remove without force returned HTTP 409 with `dirty=true`.
- Reran `make check` and `pnpm e2e`: both passed after the diff/removal slice.
- Added xterm.js cockpit terminal pane connected to the daemon `/terminal/:sessionId` WebSocket for the selected agent session.
- Reran `pnpm e2e`: 4 Playwright desktop/mobile tests passed and screenshots were refreshed.
- Reran `make check`: passed. Build now warns that the web chunk is larger than 500 KB after adding xterm; code splitting/manual chunks should be added before final performance signoff.

Known current gaps before final DoD:

- `make check` needs to be rerun after subsequent implementation slices; the current equivalent `pnpm check` passed.
- Terminal WebSocket currently uses tmux capture polling and `send-keys`; interactive fidelity must be expanded and verified against the campaign gate.
- Web terminal exists, but terminal protocol still needs stronger fidelity tests for raw/control/meta input, paste, resize, alternate screen, reconnect, output isolation, and long scrollback.
- Diff viewer is bounded and read-only for staged/unstaged/untracked text previews, but renamed/deleted/binary edge cases need broader tests and UI states before the full `MS-482` bar is complete.
- Workspace removal safety and setup/teardown hook execution still need implementation.
- Provider implementations are health-check scaffolds; normalized PR/CI/Jira data and action gating still need expansion.
- First-run settings flow and full shadcn/Tailwind component system still need implementation.
