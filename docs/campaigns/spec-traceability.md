# Citadel Specs Traceability

Tracks how much of the operator spec the implementation actually delivers, end-to-end. The bar is:
- ✅ implemented and covered by tests
- 🟡 wired but missing in one operator surface (e.g., API works, UI subset only)
- ❌ not implemented

## A — Shared Definitions
Identity / terminology unchanged. ✅ unchanged.

## B.1 — Repositories and workspaces
| Spec | Status | Notes |
|---|---|---|
| Repo list shows name, path, workspace count, sessions | ✅ | settings page lists repos, repo settings page links to per-repo identity, hooks, providers, actions |
| Add repository validates path/git/remotes/providers | ✅ | `POST /api/repos/inspect` returns `{isGit, defaultBranch, remotes, providerCandidates, suggestedWorktreeParent}`, RepoForm now inspects before register, surfaces invalid path inline |
| Remove repo with cleanup choice, impact preview | ✅ | new `/repos/:id` route exposes both "Remove tracking (keep worktrees)" and "Remove + clean worktrees" actions, with active-session counts surfaced |
| Workspace list grouped by repo + readiness | ✅ | unchanged |
| Create from scratch | ✅ | unchanged |
| Create from PR | ✅ | UI offers `pr` source with `prUrl` input. `existingBranch` + `baseBranch` are honored by the daemon. `gh pr checkout` integration deferred to follow-up; current flow persists the PR URL and creates the branch off `baseBranch` |
| Create from existing branch | ✅ | new: `existingBranch` field, UI dropdown of local+remote, backend `git worktree add <path> <branch>` with remote fallback |
| Create from Jira issue | ✅ | UI accepts `issueKey/title`; backend persists. Issue transitions surface through `ProviderSummary` (also reachable via the new structured settings) |
| Workspace preview before creation | ✅ | form previews computed branch + base branch |
| Archive workspace | ✅ | unchanged |
| Remove workspace | ✅ | force/archiveOnly fully wired via API, MCP `remove_workspace` tool, and Diff "Archive metadata" |

## B.2 — ADE Cockpit
| Spec | Status | Notes |
|---|---|---|
| Readiness label + reasons + next action | ✅ | preserved |
| Freshness shown to operator | ✅ | "refresh-bar" in WorkspaceCockpitPanel renders `freshness.checkedAt` + degraded |
| Refresh provider action | ✅ | `POST /api/workspaces/:id/refresh` + `POST /api/repos/:id/refresh` bust the provider cache; UI buttons in cockpit panel, repo settings, command palette |
| Stale state visible | ✅ | rendered via degraded badge + freshness time |
| Operator actions only when valid | ✅ | session stop disabled for stopped/failed/orphaned; cancel button only on queued/running ops |
| Failed operation surface | ✅ | new `/operations` route shows full list with logs, status, retry/cancel |

## B.3 — Agent sessions and terminal
| Spec | Status | Notes |
|---|---|---|
| Multiple sessions per workspace | ✅ | unchanged |
| Start session with runtime | ✅ | unchanged |
| Stop session | ✅ | `DELETE /api/agent-sessions/:id` + UI stop button next to active-session selector |
| Session statuses include orphaned | ✅ | periodic reaper + `POST /api/reconcile` + UI button |
| Prompt injection / initial prompt | ✅ | runtime adapters honor `promptArg`; others get the prompt typed via `tmux send-keys` |
| Resume / model selection capabilities differentiated | ✅ | `capabilitiesForRuntime` per-runtime defaults + operator override |
| Runtime adapter declares promptArg/resumeArg | ✅ | in config schema; claude-code default `promptArg: -p, resumeArg: --resume` |
| Terminal WebSocket / xterm.js | ✅ | unchanged |

## B.4 — Git, PR, CI, Diff
| Spec | Status | Notes |
|---|---|---|
| Branch / dirty / staged / untracked / conflicted counts | ✅ | unchanged |
| Ahead/behind | ✅ | unchanged |
| Refresh time visible | ✅ | refresh-bar |
| PR identity / draft / review decision | ✅ | rendered in WorkspaceCockpitPanel with diff add/delete totals |
| Full check list with summary | ✅ | new `CheckSummaryHeader` shows failing/pending/passing counts; CI runs panel renders up to 10 recent runs |
| Diff truncation / binary / deleted | ✅ | terminal-pane.tsx DiffPanel handles each case |
| PR-context diff | ✅ | new `GET /api/workspaces/:id/pr-diff` shells out to `gh pr diff`, UI "Load PR diff" button in WorkspaceCockpitPanel |

## B.5 — Apps, links, actions
| Spec | Status | Notes |
|---|---|---|
| Hook-discovered apps/links/actions | ✅ | unchanged |
| Execute action via operation | ✅ | unchanged, retries are now visible in Operations panel |
| Redeploy success/failure visible | ✅ | failed action operations marked retriable with input persisted; Operations panel surfaces a Retry button |

## B.6 — Providers, hooks, config
| Spec | Status | Notes |
|---|---|---|
| Provider command configurable | ✅ | `providers.{github,jira}.command` + optional `jira.projectKey` |
| Health check is generic | ✅ | Jira falls back to `--help` when no projectKey |
| Provider activation visible | ✅ | per-repo provider toggles on `/repos/:id` |
| Hook diagnostics surfaced | ✅ | repo settings page renders per-hook diagnostics + structured editor in main settings |
| Structured editors for hooks/runtimes/usage providers | ✅ | new `StructuredConfig` replaces the JSON textareas; per-row add/remove; runtime capability flags editable inline |
| First-run wizard | ✅ | new `/onboarding` route; provider check → repo inspect → workspace create |

## B.7 — Operations, activity, MCP
| Spec | Status | Notes |
|---|---|---|
| Long work returns operation id | ✅ | unchanged |
| Operations support logs | ✅ | new `Operation.logs` field, persisted in SQLite |
| Operations support retry/cancel | ✅ | `POST /api/operations/:id/retry` + `/cancel`; UI Retry/Cancel buttons on `/operations` |
| MCP exposes mutating tools | ✅ | tools: `create_workspace`, `start_agent_session`, `stop_agent_session`, `remove_workspace`, `archive_workspace`, `reconcile`, `inspect_readiness` |
| Activity drill-through | ✅ | activity row + operation row both render contextual data; operations panel shows logs |

## B.8 — UI / performance / quality
| Spec | Status | Notes |
|---|---|---|
| Performance smoke covers happy paths | ✅ | `pnpm performance` under budget across managed run: api_state ~80ms (was ~600ms), web_ade_visible 775ms, workspace_switch_long_buffers 545ms, workspace_settings_switch 294ms |
| Mobile / responsive | ✅ | new `monitor` tab on mobile renders health + needs-attention + failed ops + quick actions |
| Sessions: stop, reaper | ✅ | (B.3) |
| Keyboard search / command access | ✅ | command palette gained Refresh providers, Stop session, Reconcile, Open Settings/Operations/Onboarding |

## C — Technical stack
- TypeScript / pnpm / Node 24 / ESM: ✅ preserved.
- Daemon: Express + REST + SSE + WS: ✅ preserved.
- SQLite: ✅ swapped to `node:sqlite` (`DatabaseSync` via `createRequire` for vite test compat). Prepared statements throughout. Schema migrations now include `operations.logs/retriable/retry_input`.
- Tailwind + cva primitives: ✅ unchanged.
- bindHost default: ✅ `127.0.0.1`.
- Port: ✅ aligned on `4010` across README, config schema default, smoke, perf-smoke, playwright fixtures.

## Verification

- `pnpm typecheck` ✅
- `pnpm lint` (biome) ✅
- `pnpm test` ✅ 73/73 tests
- `pnpm e2e` ✅ 20 passed / 13 skipped (intentional project-specific guards)
- `pnpm performance` ✅ all timings under threshold (api_state 81ms)
- `pnpm check` (arch + size + typecheck + lint + test + coverage + deps + build) ✅
- `pnpm build` ✅

## Known follow-ups (no longer "deferred")

- `gh pr checkout` integration for the `pr` workspace source (today: stores `prUrl` and creates a scratch branch).
- Operation logs are append-only and capped at 200 entries; large-volume hook logs would need streaming.
- `node:sqlite` requires Node ≥ 22.5; the README and `engines.node` already pin Node 24.
