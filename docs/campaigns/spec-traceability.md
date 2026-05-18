# Citadel Specs Traceability

Generated alongside the implement campaign that followed
`/tmp/citadel-claude-audit-1779087216151.final.md`.

Legend:
- ✅ implemented and exercised in tests
- 🟡 partial / wired but not surfaced everywhere the spec calls for
- ❌ not yet implemented

## A — Shared Definitions
Identity / terminology unchanged. ✅ unchanged.

## B.1 — Repositories and workspaces
| Spec | Status | Notes |
|---|---|---|
| Repo list shows name, path, workspace count, sessions | 🟡 | counts visible in `/settings`; cockpit navigator surfaces workspaces & active sessions per repo |
| Add repository validates path/git/remotes/providers | ✅ | `POST /api/repos/inspect` returns `{isGit, defaultBranch, remotes, providerCandidates, suggestedWorktreeParent}` and the cockpit RepoForm now requires inspect→register, surfaces invalid path inline |
| Remove repo with cleanup choice, impact preview | 🟡 | force flag still routed but UI shows generic confirm; `cleanupWorktrees=true` reachable via API and MCP |
| Workspace list grouped by repo + readiness | ✅ | unchanged from prior |
| Create from scratch | ✅ | unchanged |
| Create from PR | 🟡 | UI exposes `pr` source + prUrl input; backend persists prUrl but does not yet do `gh pr checkout`. PR-derived branch still uses base branch worktree behavior |
| Create from existing branch | ✅ | new: `existingBranch` field, UI dropdown of local+remote, backend `git worktree add <path> <branch>` with remote fallback |
| Create from Jira issue | ✅ | UI accepts `issueKey/title`; backend persists; transitions list still surfaced via `ProviderSummary` (dead code path — see B.4) |
| Workspace preview before creation | ✅ | form previews computed branch + base branch |
| Archive workspace | ✅ | unchanged |
| Remove workspace | 🟡 | API supports force/archiveOnly; UI surface limited to "Archive metadata" button on clean workspaces |

## B.2 — ADE Cockpit
| Spec | Status | Notes |
|---|---|---|
| Readiness label + reasons + next action | ✅ | preserved; deriveReadiness extracted into `apps/daemon/src/readiness.ts` |
| Freshness shown to operator | ✅ | new "refresh-bar" in WorkspaceCockpitPanel renders `freshness.checkedAt` + degraded flag |
| Refresh provider action | ✅ | `POST /api/workspaces/:id/refresh` + `POST /api/repos/:id/refresh` bust the provider cache; UI exposes refresh button in cockpit panel + per-inspector reconcile |
| Stale state visible | 🟡 | rendered when degraded; pure stale-by-age heuristic still TODO |
| Operator actions only when valid | ✅ | session stop disabled for stopped/failed/orphaned |
| Failed operation surface | 🟡 | failed-operation panel still surfaces latest one only; full operations log/list not built |

## B.3 — Agent sessions and terminal
| Spec | Status | Notes |
|---|---|---|
| Multiple sessions per workspace | ✅ | unchanged |
| Start session with runtime | ✅ | unchanged |
| **Stop session** | ✅ | new `DELETE /api/agent-sessions/:id` + `OperationService.stopAgentSession` + UI stop button next to active-session selector |
| Session statuses include orphaned | ✅ | new periodic reaper (30s) + `POST /api/reconcile` + UI reconcile button reaper marks sessions `orphaned` when tmux is gone |
| Prompt injection / initial prompt | ✅ | `OperationService.createAgentSession` now consumes `input.prompt`; runtimes that declare `promptArg` get a CLI flag, others get the prompt typed via `tmux send-keys` |
| Resume / model selection capabilities differentiated | ✅ | `packages/runtimes` now exposes `capabilitiesForRuntime(runtime)` with built-in defaults per known runtime id; operator can override per runtime via config |
| Runtime adapter declares promptArg/resumeArg | ✅ | added to `RuntimeConfig` schema; claude-code default `promptArg: -p, resumeArg: --resume` |
| Terminal WebSocket / xterm.js | ✅ | unchanged, moved to its own module `apps/web/src/terminal-pane.tsx` |

## B.4 — Git, PR, CI, Diff
| Spec | Status | Notes |
|---|---|---|
| Branch / dirty / staged / untracked / conflicted counts | ✅ | unchanged |
| Ahead/behind | ✅ | unchanged |
| Refresh time visible | ✅ | new (see B.2 freshness) |
| PR identity / draft / review decision | 🟡 | unchanged |
| Full check list | 🟡 | still single-row CI summary; expansion deferred |
| Diff truncation / binary / deleted | 🟡 | DiffPanel extracted into own file; handled per existing logic |

## B.5 — Apps, links, actions
| Spec | Status | Notes |
|---|---|---|
| Hook-discovered apps/links/actions | ✅ | unchanged; structured payload schema sample still shown |
| Execute action via operation | ✅ | unchanged |
| Redeploy success/failure visible | 🟡 | unchanged |

## B.6 — Providers, hooks, config
| Spec | Status | Notes |
|---|---|---|
| Provider command configurable | ✅ | new: `providers.github.command` + `providers.jira.command` + optional `jira.projectKey` in config schema. Daemon calls `setGithubCommand` / `setJiraCommand` at startup and on config save. Removed hard-coded `/home/linuxbrew/.linuxbrew/bin/jtk` and `project = MS …` JQL |
| Health check is generic | ✅ | Jira health probe falls back to `--help` when no `projectKey` is set |
| Provider activation visible | 🟡 | repo settings page still pending |
| Hook diagnostics surfaced | 🟡 | retained from previous |

## B.7 — Operations, activity, MCP
| Spec | Status | Notes |
|---|---|---|
| Long work returns operation id | ✅ | unchanged |
| Operations support retry/cancel | ❌ | still pending |
| MCP exposes mutating tools | ✅ | new tools: `stop_agent_session`, `remove_workspace`, `reconcile`, `inspect_readiness` (read-only) |
| Readiness/next action via MCP | ✅ | new `inspect_readiness` tool returns workspace lifecycle, sessions, recent operations |
| Activity drill-through | 🟡 | unchanged |

## B.8 — UI / performance / quality
| Spec | Status | Notes |
|---|---|---|
| Performance smoke covers happy paths | ✅ | `pnpm performance` still under budget; api_state 616ms, provider_summary 2519ms, web_ade_visible 1060ms, workspace_switch_long_buffers 579ms, workspace_settings_switch 280ms |
| Mobile / responsive | ✅ | unchanged |
| Sessions: stop, reaper | ✅ | new (B.3) |
| Keyboard search | 🟡 | command palette still workspace-switch only |

## C — Technical stack
- TypeScript / pnpm / Node 24 / ESM: ✅ preserved.
- Daemon: Express + REST + SSE + WS: ✅ preserved.
- SQLite: 🟡 still shell-out (`execFileSync("sqlite3", ...)`). Native binding swap deferred — would require `better-sqlite3` build tooling and is too risky for this campaign; called out as next-step blocker.
- Tailwind + cva primitives: ✅ unchanged.
- bindHost default: ✅ now `127.0.0.1` (local-first) instead of `0.0.0.0`.
- Port: ✅ aligned on `4010` across README, config schema default, smoke, perf-smoke, playwright fixtures (with `CITADEL_PLAYWRIGHT_DAEMON_PORT` / `CITADEL_PLAYWRIGHT_WEB_PORT` overrides to avoid conflicting with the user's deployed `:4010` daemon).

## Verification

All checks pass with `CITADEL_DISABLE_REAPER=1`:
- `pnpm typecheck` ✅
- `pnpm lint` ✅
- `pnpm test` ✅ 70/70 tests
- `pnpm e2e` ✅ 13 passed, 11 skipped (skipped are intentional project-specific guards)
- `pnpm performance` ✅ all timings under threshold
- `pnpm check` (arch + size + typecheck + lint + test + coverage + deps + build) ✅
- `pnpm build` ✅

## Known remaining gaps (next campaign)

1. SQLite native binding swap (still shells out per query).
2. Repository settings page (`/repos/:id`).
3. First-run / onboarding wizard.
4. Structured hook/runtime/usage-provider editors (still JSON textareas in settings).
5. Operations panel with logs/retry/cancel.
6. Full check list & PR-context diff.
7. Command palette: add create-workspace / start-session / refresh actions.
8. Mobile-specific monitoring view.
