Activate the /implement-task skill first.

# Plan: Onboarding, setup, distribution

## Acceptance Criteria

Original prompt:

- [ ] Define distribution (fixed releases), install flow, "is everything configured?" verification, hook examples
- [ ] HTTP vs HTTPS support (some users will run http-only)
- [ ] `make upgrade` command — even though `make install` does the same, the dedicated verb is clearer
- [ ] Use AI in empty states wherever it makes sense: e.g. when a registered repo has no hooks, launch an interactive agent (on a new branch, primed with the citadel example) to author the hook — instead of pointing the user at manual edits

Clarifications from grilling session:

- [ ] Default `make install` and `make upgrade` install the latest released version, not latest `main`.
- [ ] Latest release means the highest stable semver git tag matching `vX.Y.Z` from `origin`, sorted numerically and ignoring malformed/prerelease tags.
- [ ] `make install REF=main` and `make upgrade REF=main` install latest `origin/main`.
- [ ] `make install REF=vX.Y.Z` and `make upgrade REF=vX.Y.Z` install that exact annotated release tag.
- [ ] Only `REF=main` and `REF=vX.Y.Z` are accepted; arbitrary branches, SHAs, and lightweight tags are rejected.
- [ ] Dirty checkout state blocks all install/upgrade ref movement and also blocks reinstalling a fixed release, because a dirty source install is no longer that release.
- [ ] Default latest-release and `REF=main` require network access; exact tag installs attempt to fetch tags and may use an already-present local annotated tag only when that fetch fails.
- [ ] `make install` and `make upgrade` should be behaviorally identical except for the user-facing verb; `make upgrade` exists for clarity.
- [ ] `make install` is self-contained after `git clone`: resolve ref, install dependencies with `pnpm install --frozen-lockfile`, build, write units, restart daemon, then verify with `make doctor`.
- [ ] No separate required init/config command for this release; first boot creates default config.
- [ ] Runtime CLI checks warn per missing agent runtime and fail only if zero usable agent runtimes are executable.
- [ ] Plain shell is a terminal profile, not an agent runtime.
- [ ] Config shape is split now: `config.agentRuntimes` and singular `config.terminal`.
- [ ] Sessions are workspace sessions, not agent sessions at the storage/domain level.
- [ ] Workspace sessions are a discriminated union: `kind: "agent"` has `runtimeId: string`; `kind: "terminal"` has `runtimeId: null`.
- [ ] The physical database table is renamed from `agent_sessions` to `workspace_sessions`.
- [ ] The app can still open terminal tabs through REST, but MCP does not expose terminal launch or terminal sessions.
- [ ] MCP remains agent-only: `list_agent_sessions`, `start_agent_session`, `send_agent_message`, `stop_agent_session` operate only on `kind: "agent"` sessions.
- [ ] Browser REST uses unified workspace-session reads/stops/renames and separate create paths for agent vs terminal sessions.

## Context and problem statement

This branch already contains a partial implementation of the original onboarding/distribution work: install docs, a release workflow, `make upgrade`, doctor contracts/routes/UI, optional HTTPS support, and AI-assisted hook scaffolding. The grilling session clarified that several of those pieces need different semantics:

- Install/upgrade defaults must target latest release tags, not the current branch.
- `REF=main` is the only branch escape hatch.
- `make install` must be a complete operator install path and run dependency install itself.
- The product model must stop treating `shell` as an agent runtime.
- The persisted session model must be renamed to workspace sessions and distinguish agent sessions from terminal sessions.

The implementation must reconcile the existing branch work with the clarified product model rather than layering compatibility aliases on top of the old terminology. The repo has no external consumers requiring old MCP or REST names, but existing local operator data still needs a safe forward migration.

## Spec alignment

Touched specs:

| Spec | Alignment / update needed |
|---|---|
| `specs/A-shared-definitions.md` | Add or update core terms for `Workspace session`, `Agent runtime`, and `Terminal profile`. Existing `Agent session` term should become the agent-kind specialization of a workspace session. |
| `specs/B.1-repositories-workspaces.md` | Workspace and repository counts/attention must count only agent sessions, not terminal tabs. Update references that describe `runtime except shell` to use `session.kind === "agent"`. |
| `specs/B.2-ade-cockpit.md` | Center-stage tabs already distinguish Terminal vs agent runtime; update API/contract language to workspace sessions and separate terminal creation. |
| `specs/B.3-agent-sessions-terminal.md` | Main divergence. Replace old `shell runtime` wording with `terminal profile`; update persisted table name, session union shape, and launcher semantics. |
| `specs/B.6-providers-hooks-config.md` | Update settings IA from `runtimes` to `agentRuntimes` + `terminal`; doctor check kinds must include `agent-runtime` and `terminal`. |
| `specs/B.7-operations-activity-mcp.md` | MCP remains agent-only. Update tool inventory/semantics so terminal sessions are not listed or launched by MCP. |
| `specs/B.8-ui-performance-quality.md` | E2E first-run/configured state and terminal smoke are directly affected; plan must include browser coverage. |
| `specs/C-technical-stack.md` | Distribution semantics currently say default upgrade fast-forwards current branch. Update to latest stable release tag by default, `REF=main` escape hatch, self-contained install, and workspace-session persistence. |

Spec updates must be the first implementation unit. This is not a pure refactor; specs currently encode several old behaviors.

## Hard-gate matrix

| Gate | Applies? | Plan coverage |
|---|---:|---|
| Spec gate | Applies | Step 1 updates every touched spec before code changes. |
| Regression test gate | Applies | QA/Test Strategy lists Vitest and Playwright coverage for config, DB migration, contracts, REST/MCP, terminal, doctor, install/upgrade, and UI workflows. |
| Architecture-boundary gate | Applies | Core changes are limited to pure helpers over contract types. Web uses `@citadel/contracts` and daemon APIs only. CLI remains a thin shell/API surface. If implementation needs a new cross-package import, update `scripts/checks/architecture-boundaries.ts` in the same unit and explain why. |
| Schema-safety gate | Applies | Migration strategy declares version 13, classifies every operation, preserves `PRAGMA foreign_keys = ON`, and states existing operator DB impact. |
| File-size gate | Applies | Route changes must stay split across dedicated modules (`agent-session-routes`, `workspace-session-routes`, `doctor-routes`, `scaffold-hook-routes`) instead of expanding `app.ts`. Any file approaching 800 lines must be split before final verification. |
| Provider-degradation gate | Applies | Provider behavior is not expanded beyond doctor/state diagnostics. Existing provider-health degradation remains; doctor continues to classify unconfigured providers as warn and configured-but-unreachable as fail. |
| Workspace-cleanup-safety gate | Applies | The plan creates/reuses scaffold workspaces but does not add automatic deletion. Dirty worktrees are never deleted by scaffold/session/install flows. |
| Terminal-completeness gate | Applies | Terminal changes must preserve raw input, control/meta sequences, paste, resize, long output, alternate screen where supported, reconnect, and cross-session isolation. Tests section requires updating terminal unit/E2E coverage for these dimensions before implementation is complete. |
| Lockfile-sensitivity gate | Skips for dependency additions | No new dependencies are planned. Version metadata may affect package/lockfile entries, but no package lifecycle scripts need review unless implementation introduces a new dependency. |

## Implementation approach

Implement in three layers, keeping each boundary explicit:

1. **Contract/spec first.** Update specs and `@citadel/contracts` so the discriminated workspace-session shape, agent runtime config, terminal config, and doctor check kinds are the source of truth before implementation changes.
2. **Storage/config/domain migration.** Split config loading/saving and migrate SQLite from `agent_sessions` to `workspace_sessions`. Existing local config/DB data is migrated forward once; canonical writes use only the new names.
3. **Surface reconciliation.** Update operations, daemon REST/MCP, terminal routing, state payloads, web UI, docs, install scripts, and tests to use the new model and release semantics.

Terminology rule: public/product-facing code should say `workspace session`, `agent runtime`, or `terminal profile`. The `packages/runtimes` package can keep its name because it contains runtime adapter logic for agents, but config/API fields should not expose a generic `runtimes` array that includes terminal.

## Alternatives considered

- **Keep `shell` in `config.runtimes` and only hide it in UI/doctor.** Rejected. This preserves the ambiguity the user explicitly wants removed.
- **Keep the `agent_sessions` table and add `kind`.** Rejected. The user explicitly rejected leaving physical naming debt.
- **Expose `start_terminal_session` in MCP.** Rejected. MCP is agent orchestration only for now; the browser can create terminals through REST.
- **Default install/upgrade to the current branch.** Rejected. Fixed releases are the default operator path; latest `main` must be explicit via `REF=main`.
- **Use GitHub Releases API for latest release resolution.** Rejected. Git tags are enough for source-checkout distribution and avoid requiring `gh` or API auth during install.

## Implementation steps

### 1. Specs and docs

- Update `specs/A-shared-definitions.md`:
  - Add `Workspace session` as the durable tab/session attached to a workspace.
  - Define `Agent session` as `Workspace session` with `kind: "agent"`.
  - Define `Terminal profile` as the single shell-backed terminal launcher, not an agent runtime.
  - Define `Agent runtime` as Claude/Codex/Cursor/Pi/custom prompt-driven agent adapters.
- Update `specs/B.3-agent-sessions-terminal.md`:
  - Replace `shell runtime` language with `terminal profile`.
  - Document `WorkspaceSession = agent | terminal` union.
  - Document `workspace_sessions` SQLite table.
  - Clarify terminal sessions are durable tmux sessions but do not count as agents.
- Update `specs/B.6-providers-hooks-config.md`:
  - Config shape: `agentRuntimes[]`, `terminal`, `providers`, `hooks`, `usageProviders`.
  - Doctor check kinds include `agent-runtime` and `terminal`.
  - Agent runtime checks warn per missing runtime and fail only if zero usable agent runtimes are executable.
  - Terminal profile command missing is a `fail` because terminal tabs and shell-first agent launching depend on it.
- Update `specs/B.7-operations-activity-mcp.md`:
  - MCP tool inventory remains agent-only: `list_agent_sessions`, `start_agent_session`, `send_agent_message`, `stop_agent_session`.
  - Terminal sessions are not listed or launched through MCP.
- Update `specs/C-technical-stack.md`:
  - Distribution defaults to highest stable semver tag from `origin`.
  - `REF=main` is the only branch override.
  - `make install` and `make upgrade` share behavior and run dependency install.
  - SQLite owns `workspace_sessions`, not `agent_sessions`.
- Update `docs/operations/install.md`, `README.md`, and `CHANGELOG.md` to match the clarified install/upgrade commands and latest-release semantics.
- Update `docs/operations/config-reference.md` and `docs/operations/runbook.md` examples so terminals are not launched via `runtimeId: "shell"` and MCP examples use agent runtimes only.

### 2. Config model split

- In `packages/config/src/index.ts`:
  - Rename `runtimes` schema field to `agentRuntimes`.
  - Remove the built-in `shell` entry from agent runtime defaults.
  - Add singular `terminal` schema:
    ```ts
    terminal: {
      displayName: "Terminal",
      command: "bash",
      args: ["-l"]
    }
    ```
  - Keep runtime capability fields only for `agentRuntimes`.
  - Update `DEFAULT_FIX_CI_AUTOMATION`, Citadel Actions, scheduled agents, usage providers, and validation to reference configured agent runtimes only.
- Add a one-time config-file migration in `loadConfig`:
  - If raw config has `agentRuntimes`, parse as canonical.
  - If raw config only has legacy `runtimes`, split entries where `id === "shell"` or command is a known shell command into `terminal`; all others become `agentRuntimes`.
  - If multiple shell-like entries exist, use the one with `id === "shell"` first, otherwise the first shell-like entry; leave the rest out of `agentRuntimes` and write a clear warning.
  - After successful parse, attempt an atomic canonical writeback:
    - Write `<config>.tmp`, `chmod 0600`, then `rename` over the original.
    - Before overwrite, create `<config>.legacy-runtimes.bak` once if it does not already exist.
    - If writeback fails because the file or directory is read-only, keep the migrated config in memory, log a warning with the path and reason, and do not crash boot.
    - The warning must name any legacy shell-like entries that were not carried forward so the operator knows what changed.
  - `saveConfig` writes only canonical fields; no legacy `runtimes` field.
- Update config tests to cover fresh defaults, legacy split migration, canonical save, and validation failures.

### 3. Contracts and pure helpers

- In `packages/contracts/src/index.ts`:
  - Add `TerminalProfileSchema`.
  - Rename state/config contract fields from `runtimes` to `agentRuntimes`; add `terminal`.
  - Add `WorkspaceSessionSchema` as a discriminated union:
    - `kind: "agent"`, `runtimeId: IdSchema`.
    - `kind: "terminal"`, `runtimeId: z.null()`.
  - Keep/export `AgentSessionSchema` as the extracted agent variant for MCP and agent-only workflows.
  - Add `CreateTerminalSessionInputSchema` for REST/app use; do not expose it through MCP.
  - Keep `CreateAgentSessionInputSchema` agent-only and validate `runtimeId` against daemon config at route time.
- In `packages/core`, update helpers such as attention/readiness/session grouping to use `session.kind === "agent"` instead of `runtimeId !== "shell"`.
- Add tests for the discriminated union and pure helpers.

### 4. SQLite migration to `workspace_sessions`

Migration strategy:

- Previous max migration in this branch is `12`; add version `13`, name `workspace-sessions-agent-terminal-split`, and update `CURRENT_SCHEMA_VERSION` to `13`.
- Preserve `PRAGMA foreign_keys = ON;` at connection open; do not disable foreign keys globally.
- Operation list:
  - **Schema dependency audit** before rebuild:
    - Query `sqlite_schema` for SQL containing `agent_sessions`.
    - Query `PRAGMA foreign_key_list(<table>)` for every user table to find dependencies on `agent_sessions`.
    - Inventory indexes/triggers/views that must be recreated or deleted.
    - Fail the migration with a clear error if an unexpected dependent object is found and not handled by the migration code.
    - Current expected inventory from this branch:
      - `agent_sessions` is the only schema object whose own DDL names the old table.
      - No current tables declare foreign keys to `agent_sessions`.
      - No current indexes, triggers, or views reference `agent_sessions`.
      - `scheduled_agents.last_session_id` and `scheduled_agent_runs.session_id` are plain nullable text pointers, not foreign keys; no rebuild is required for those tables, but their values remain valid because session IDs are preserved.
  - **CREATE TABLE** `workspace_sessions_new` with the same durable fields as `agent_sessions`, plus `kind TEXT NOT NULL`, and with `runtime_id TEXT NULL`.
  - Add a SQLite `CHECK` constraint enforcing:
    ```sql
    (kind = 'agent' AND runtime_id IS NOT NULL)
    OR
    (kind = 'terminal' AND runtime_id IS NULL)
    ```
  - **Data backfill** from `agent_sessions`:
    - `kind = 'terminal'` and `runtime_id = NULL` when old `runtime_id = 'shell'`.
    - `kind = 'agent'` and `runtime_id = old runtime_id` otherwise.
    - Preserve `display_name`, tmux IDs, status fields, tab IDs, runtime session IDs, resume bookkeeping, timestamps.
  - **Row-count parity check** after insert: new table count must equal old table count before old data is dropped.
  - **DROP TABLE** old `agent_sessions` after successful copy inside the same transaction.
  - **ALTER TABLE RENAME** `workspace_sessions_new` to `workspace_sessions`.
  - Recreate any indexes/constraints needed by current query patterns (`workspace_id`, `runtime_session_id`, status if introduced).
  - Run `PRAGMA foreign_key_check` before committing and fail/rollback if any violations are returned.
  - **INSERT OR IGNORE** migration row `(13, 'workspace-sessions-agent-terminal-split', datetime('now'))`.
- Classification:
  - `CREATE TABLE` and indexes are additive.
  - Data backfill is safe and transaction-bound.
  - Dropping `agent_sessions` is destructive but data-preserving because the table is rebuilt and renamed in the same forward migration. Rollback remains Citadel's documented backup/restore strategy.
  - Widening `runtime_id` from NOT NULL to nullable is intentional and required by the discriminated union.
- Operator data implications:
  - Existing terminal rows previously stored as `runtime_id='shell'` become `kind='terminal', runtime_id=NULL`.
  - Existing agent rows keep their runtime IDs.
  - Existing tmux session names and ttyd adoption continue because session IDs and tmux metadata are preserved.
- Update `packages/db/src/rows.ts` and `packages/db/src/index.ts`:
  - Rename reader/writer methods to `listWorkspaceSessions`, `insertWorkspaceSession`, `updateWorkspaceSessionStatus`, `renameWorkspaceSession`, `deleteWorkspaceSession`.
  - Keep agent-only convenience filters if useful, but no SQL should refer to `agent_sessions`.
  - Update tests to assert no `agent_sessions` table remains after migration, terminal rows have `runtimeId: null`, invalid direct inserts violate the CHECK constraint, row counts match, and `PRAGMA foreign_key_check` returns no rows.

### 5. Operations and terminal lifecycle

- Split operation entry points:
  - `createAgentSession` remains agent-only and requires an agent runtime descriptor.
  - Add `createTerminalSession`, using `config.terminal`.
  - Rename stop/read/update internals to workspace-session terminology where they apply to both kinds.
- Update `packages/terminal/src/index.ts`:
  - `ensureTmuxSession` accepts a terminal shell profile `{ command, args }` instead of hardcoding `bash -l`.
  - Agent sessions use the configured terminal profile as the base shell before sending the agent runtime command into the pane.
  - Terminal sessions start only that terminal profile and never launch an agent child process.
- Update status monitor and message sending:
  - Terminal sessions are `running` while tmux exists; shell foreground is normal for `kind: "terminal"`.
  - Agent sessions treat shell foreground as agent idle/stopped as today.
  - `sendAgentMessage` rejects `kind: "terminal"` with a clear `session_not_agent` error.
  - Auto-resume, auto-recovery, fix-conflicts, scratchpad refine, scheduled agents, and Citadel Actions select only configured agent runtimes.
- Ensure `agent.started` hooks/activity fire only for agent sessions. Terminal launch can record a regular activity event such as `terminal.started`, but it must not run `agent.started` hooks.

### 6. Daemon REST, state, MCP, restore, and doctor

- REST:
  - Add/keep `POST /api/agent-sessions` as agent-only.
  - Add `POST /api/workspaces/:workspaceId/terminal-sessions` for browser terminal creation.
  - Add unified workspace-session routes for stop/rename/read where kind-agnostic:
    - `GET /api/workspace-sessions?workspaceId=...`
    - `DELETE /api/workspace-sessions/:sessionId`
    - `PATCH /api/workspace-sessions/:sessionId`
  - Keep agent-only output/history/message routes under `/api/agent-sessions/:id/...`; they reject non-agent sessions.
  - `/api/state` returns `sessions: WorkspaceSession[]`, `agentRuntimes`, and `terminal`.
  - Rename `/api/runtimes` to `/api/agent-runtimes`; update all web callers.
- MCP:
  - `list_agent_sessions` returns only `kind: "agent"` sessions.
  - `start_agent_session` validates against `config.agentRuntimes`.
  - `send_agent_message`, `read_agent_output`, and `stop_agent_session` reject non-agent session IDs.
  - Do not add `start_terminal_session` or any terminal listing tool.
- Restore/boot/orphan handling:
  - Restore only resumes `kind: "agent"` sessions with runtime session IDs.
  - Terminal sessions can be reattached/recreated by the normal terminal route using preserved tmux metadata, but no runtime resume is attempted.
  - Orphan reaper and ttyd release paths operate on workspace sessions by ID.
- Doctor:
  - Add doctor check kinds `agent-runtime` and `terminal`.
  - Agent runtime checks run in CLI and daemon modes because both can resolve configured commands.
  - Missing agent runtime command -> `warn` per runtime.
  - Zero executable agent runtimes -> one aggregate `fail`.
  - Missing terminal command -> `fail`.
  - Keep provider, TLS, daemon, systemd, database, and repo-hook checks from the existing branch work.

### 7. Web UI

- State and API typing:
  - `StateResponse.sessions` becomes `WorkspaceSession[]`.
  - `data.agentRuntimes` replaces `data.runtimes`.
  - `data.terminal` is available for terminal launcher/settings.
- Center stage:
  - The plus menu shows one `Terminal` item from `config.terminal` and agent runtime items from `agentRuntimes`.
  - Selecting Terminal calls the new terminal REST endpoint.
  - Selecting an agent calls `POST /api/agent-sessions`.
  - Tab labels use `session.kind` and display name; terminal tabs default to `Terminal`.
  - Workspace agent pulse/count/readiness only considers `kind: "agent"`.
- Settings:
  - Rename the current `settings-runtimes.tsx` surface to operator-facing Agents.
  - Remove shell from the Agents list.
  - Add a compact Terminal profile settings section for the singular terminal command/display name.
  - Overview tile distinguishes Agents from Terminal.
  - Diagnostics groups `Agent runtimes` and `Terminal`.
- Empty states:
  - Keep/finish "Scaffold with AI" for repo hooks using `config.agentRuntimes`, preferring `claude-code` if configured, otherwise the first available agent runtime.
  - Never fall back to terminal for hook scaffolding.

### 8. Distribution, install, upgrade, release

- Refactor `scripts/install/install-guards.sh` into shared install/ref helpers:
  - `citadel_require_clean_tree`.
  - `citadel_fetch_origin_tags_required` for default latest release.
  - `citadel_fetch_origin_tags_best_effort` for exact tag installs.
  - `citadel_latest_release_tag` with numeric stable semver sorting.
  - `citadel_resolve_install_ref`:
    - no ref -> latest stable annotated release tag from `origin`; network fetch/list is required and local-only tags are ignored.
    - `main` -> fetch `origin/main` and checkout exactly that fetched object (detached or otherwise without merge/rebase/local-branch ambiguity); network fetch is required.
    - `vX.Y.Z` -> exact annotated tag; fetch tags best-effort. If fetch succeeds, require the tag to exist on `origin` and be annotated. If fetch fails, accept an already-present local annotated tag.
    - anything else -> refusal.
  - Latest-tag selection should derive candidates from remote tag refs, not from local `git tag`. One valid implementation is parsing `git ls-remote --tags origin` and accepting stable `vX.Y.Z` tags only when the remote output includes the peeled `refs/tags/vX.Y.Z^{}` companion that proves an annotated tag.
  - If default latest-release resolution finds no valid annotated stable semver tag on `origin`, fail clearly with guidance: create/push a release tag or use `REF=main` for development/bootstrap installs.
  - Annotated tag validation rejects lightweight tags, branches, and SHAs in both exact-tag resolution and latest-tag selection.
- Update `scripts/install-systemd.sh`:
  - Accept `REF=...` arg and `CITADEL_INSTALL_REF`.
  - Default to latest release tag.
  - Refuse dirty checkout before any checkout/pull/reinstall.
  - Run `pnpm install --frozen-lockfile` after ref selection and before build.
  - Preserve WorkingDirectory mismatch guard.
- Update `scripts/install/upgrade.sh`:
  - Delegate to the same resolver and then to install.
  - Behave identically to install except for log wording.
- Update `Makefile`:
  - `make install REF=main`, `make install REF=vX.Y.Z`, and defaults pass through.
  - `make upgrade` remains the clarity verb.
  - `make setup` remains a dev convenience, not required for operator install.
- Update release workflow/docs:
  - `.github/workflows/release.yml` remains tag-triggered and gates release creation on `make check`.
  - Add a workflow preflight before `gh release create`:
    - `actions/checkout` must use `fetch-depth: 0`, and the workflow must explicitly fetch tag objects if needed before validation.
    - `GITHUB_REF_NAME` must match `^v[0-9]+\.[0-9]+\.[0-9]+$`.
    - `git cat-file -t "refs/tags/$GITHUB_REF_NAME"` must return `tag`, not `commit`, so lightweight tags cannot publish releases the installer refuses.
  - Docs explain source checkout, tags-as-artifacts, latest-release default, dirty-tree policy, and exact-tag behavior when offline with a local tag.

### 9. HTTP/HTTPS and hook scaffolding reconciliation

- Keep optional in-process TLS support already introduced on the branch:
  - `config.tls` absolute cert/key paths.
  - non-empty, readable, non-expired cert validation.
  - `http` default and `https` when configured.
  - boot/doctor warning only for non-loopback bind without TLS.
- Ensure every URL builder uses `protocol` from config/doctor/dev state.
- Keep hook example docs and canonical `assets/hook-templates/citadel-deploy.sh`.
- Ensure scaffold route cannot choose terminal; it must require an agent runtime.
- Route and UI should reuse in-flight `hook-scaffold-*` workspaces and never auto-delete dirty scaffold worktrees.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | This change touches contracts, config migration, SQLite migration, install scripts, doctor logic, operations, MCP dispatch, status/readiness helpers, daemon route handlers, and React components. Unit tests must cover each critical boundary. |
| E2E (Playwright) | Required | The browser creates terminal and agent sessions through different endpoints, renders workspace-session tabs, shows diagnostics, and exposes AI hook scaffolding. These are user-visible flows. |

### New tests to add

- `packages/contracts/src/index.test.ts`: validates `WorkspaceSessionSchema` discriminated union, `AgentSessionSchema` extraction, terminal `runtimeId: null`, and rejection of `kind: "terminal"` with runtime ID.
- `packages/contracts/src/doctor.test.ts` or existing contract tests: validates new doctor kinds `agent-runtime` and `terminal`.
- `packages/config/src/index.test.ts`: fresh config defaults to `agentRuntimes` without shell and singular `terminal`; legacy `runtimes` config migrates and is saved canonically; multiple shell-like legacy entries choose the shell entry deterministically.
- `packages/db/src/migration.test.ts`: existing `agent_sessions` rows migrate to `workspace_sessions`; old `runtime_id='shell'` becomes terminal with null runtime; non-shell rows remain agents; old table no longer exists; `CURRENT_SCHEMA_VERSION` is 13.
- `packages/db/src/migration.test.ts`: migration inventories dependent schema objects, preserves row-count parity, fails on unexpected dependent objects, and leaves `PRAGMA foreign_key_check` clean.
- `packages/db/src/migration.test.ts`: current schema inventory expectation is pinned: no FK/table/index/trigger/view dependencies on `agent_sessions` beyond the old table itself, and `scheduled_agents.last_session_id` / `scheduled_agent_runs.session_id` remain text pointers with preserved IDs.
- `packages/db/src/index.test.ts`: workspace session CRUD round-trips both agent and terminal variants; invalid discriminant/runtime combinations fail the SQLite CHECK constraint; rename/status/delete use `workspace_sessions`.
- `packages/core/src/index.test.ts` or targeted helper tests: workspace pulse/readiness/count helpers ignore terminal sessions and count only `kind: "agent"`.
- `packages/terminal/src/index.test.ts`: `ensureTmuxSession` builds tmux command from a supplied terminal profile rather than hardcoded `bash -l` (mock child_process).
- `packages/terminal/src/input-tokens.test.ts` or existing terminal input tests: preserve raw input, control/meta sequences, and paste tokenization after the session model rename.
- `apps/daemon/src/terminal-routes-proxy.test.ts`: terminal proxy still supports resize/reconnect and isolates ttyd entries by workspace-session ID for both agent and terminal kinds.
- `packages/operations/src/create-agent-session.test.ts`: agent creation uses terminal profile as base shell and inserts `kind: "agent"`; terminal creation inserts `kind: "terminal"` and does not run agent hooks.
- `packages/operations/src/agent-messages.test.ts`: sending a message to a terminal session returns `session_not_agent`.
- `packages/operations/src/doctor.test.ts`: agent runtime missing -> warn; zero executable agent runtimes -> fail; terminal command missing -> fail; provider/TLS behavior remains unchanged.
- `apps/daemon/src/agent-session-routes.test.ts`: `POST /api/agent-sessions` validates against `agentRuntimes` and rejects terminal IDs/unknown runtime IDs.
- `apps/daemon/src/workspace-session-routes.test.ts`: terminal creation route creates terminal session; unified stop/rename routes work for both kinds.
- `apps/daemon/src/daemon-mcp-tool.test.ts`: MCP `list_agent_sessions` filters terminal sessions; start/send/read/stop reject terminal IDs where applicable.
- `apps/daemon/src/scaffold-hook-routes.test.ts`: scaffold chooses only agent runtimes and fails when no agent runtime is configured.
- `scripts/install/upgrade.test.ts` and new or expanded install-guard tests: default resolves highest semver tag, `v0.10.0 > v0.9.9`, malformed/prerelease tags ignored, `REF=main` accepted, arbitrary refs rejected, dirty tree blocks, exact local annotated tag works when fetch fails.
- `scripts/install/upgrade.test.ts` and new or expanded install-guard tests: local-only tags cannot win default latest-release selection; exact local tag is rejected when origin fetch succeeds but the tag is absent from origin; default install fails clearly when origin has no stable annotated release tags.
- `scripts/install/upgrade.test.ts`: `REF=main` fetches `origin/main` and checks out exactly that fetched object without merging/rebasing local `main`.
- `.github/workflows/release.yml` covered by a script-level test or shellcheckable helper test: release preflight rejects lightweight tags and malformed tag names before `gh release create`.
- `apps/web/src/app-state.test.ts`: state helpers handle `WorkspaceSession[]`, agent-only counts, and terminal sessions.
- `apps/web/src/stage.test.tsx` or nearest existing stage/session test: plus menu creates terminal via terminal endpoint and agent via agent endpoint.
- `apps/web/src/settings-runtimes.test.tsx` or renamed Agents settings test: shell no longer appears as an agent runtime; terminal profile renders separately.
- `apps/web/src/settings-diagnostics.test.tsx`: diagnostics renders `Agent runtimes` and `Terminal` groups.

### Existing tests to update

- Any tests using `runtimeId: "shell"` for agent/session fixtures must become either:
  - `kind: "terminal", runtimeId: null`, or
  - an actual agent runtime such as `claude-code`/`codex` when testing agent behavior.
- Update fixtures in:
  - `apps/daemon/src/app-test-helpers.ts`
  - `apps/daemon/src/scratchpad-routes.test-utils.ts`
  - `packages/mcp/src/index.test.ts`
  - `packages/operations/src/launch-agent.test.ts`
  - `packages/operations/src/status-monitor.test.ts`
  - `apps/daemon/src/auto-recovery*.test.ts`
  - `apps/daemon/src/fix-conflicts-routes.test.ts`
  - `apps/web/src/workspace-card.test.ts`
  - `apps/web/src/terminal-pane.test.ts`
- Update doctor route/UI tests for new check kinds and config names.
- Update docs tests or snapshot expectations if any assert MCP tool inventory or config JSON.

### Assertions to add/change/tighten

- Assert no canonical config output contains a top-level `runtimes` key.
- Assert no canonical state response contains `runtimes`; it contains `agentRuntimes` and `terminal`.
- Assert terminal sessions do not appear in MCP `list_agent_sessions`.
- Assert terminal session IDs passed to MCP agent-only methods return explicit errors.
- Assert workspace cards and dashboard do not mark a workspace as working when only terminal sessions are running.
- Assert hook scaffolding fails clearly when no agent runtime is configured, rather than launching a terminal.
- Assert install/upgrade default checkout is the latest stable release tag, detached if needed.
- Assert dirty trees block install/upgrade even when already on a tag.
- Assert release preflight rejects lightweight semver tags.
- Assert release workflow checkout/fetch makes annotated tag objects available before preflight.
- Add mechanical reference checks in the implementation verification notes:
  - `rg -n 'agent_sessions|runtimeId: "shell"|\\bruntimes\\b' apps packages specs docs scripts .github` must return only annotated legacy-migration/tests/docs allowlist entries.
  - Any remaining allowlisted legacy reference must include a nearby comment explaining why it is intentionally legacy.

### Failure modes / edge cases / regression risks

- **Data loss during table rebuild.** Migration must run in a transaction and preserve tmux/session metadata.
- **Terminal tabs accidentally counted as agents.** This can produce false running indicators, auto-recovery suppression, and wrong readiness.
- **MCP leaking terminal sessions.** Agents could read or stop an operator's terminal tab if filtering is missed.
- **Agent launch using terminal config incorrectly.** If terminal profile args are not passed correctly, agent prompts may paste before the shell is ready.
- **No agent runtimes installed.** Doctor must fail clearly, and agent launch/scaffold buttons must show actionable unavailable states.
- **Install default silently using stale local tags.** Default latest-release path must require remote tag fetch.
- **Dirty source checkout installed as release.** Dirty checks must happen before checkout and before reinstall.
- **HTTPS config regressions.** ttyd proxy and diagnostic WebSocket must work under HTTP and HTTPS.
- **Existing local config migration surprises.** Legacy `runtimes` split must be deterministic and write canonical config once.
- **Invalid workspace-session rows from direct SQL.** SQLite CHECK constraints must enforce the discriminated union even outside Zod/API code.
- **Release workflow publishes an unusable lightweight tag.** Workflow preflight must reject tags the installer would reject.
- **Local-only release tag shadows origin.** Default latest-release selection must use remote tag refs only; exact-tag installs only accept local tags when remote fetch fails.

### Adversarial analysis

- **How could this fail in production?** A local database migration could drop session rows; install could pin the wrong tag; MCP could expose terminal tabs; terminal base shell config could break all agent launches.
- **What user actions trigger unexpected behavior?** Running `make upgrade` from a dirty checkout, opening only terminal tabs, clicking hook scaffold with no agent runtime installed, migrating a config with custom shell-like runtimes, or passing an old terminal session ID to an MCP agent tool.
- **What existing behavior could break?** Session tab rendering, restore/auto-resume, scheduled agents, scratchpad refine, fix-conflicts, terminal attach, provider/doctor settings, and all tests using `runtimeId: "shell"`.
- **Which tests credibly catch those failures?** DB migration tests catch data loss; MCP tests catch terminal filtering; stage E2E catches terminal/agent creation; install script tests catch ref resolution; doctor tests catch runtime/terminal severity; core/web tests catch false agent counts.
- **What gaps remain?** Manual QA is still needed on a real tmux/ttyd host for full terminal fidelity after the terminal profile is threaded into `ensureTmuxSession`. CI cannot fully prove every interactive terminal key path.

## Tests

TDD order:

1. Contract/config tests:
   - `packages/contracts/src/index.test.ts`
   - `packages/contracts/src/doctor.test.ts` if separate
   - `packages/config/src/index.test.ts`
2. DB migration/store tests:
   - `packages/db/src/migration.test.ts`
   - `packages/db/src/index.test.ts`
3. Core/operations/terminal tests:
   - `packages/core/src/index.test.ts`
   - `packages/terminal/src/index.test.ts`
   - `packages/operations/src/create-agent-session.test.ts`
   - `packages/operations/src/agent-messages.test.ts`
   - `packages/operations/src/doctor.test.ts`
4. Daemon/MCP route tests:
   - `apps/daemon/src/agent-session-routes.test.ts`
   - `apps/daemon/src/workspace-session-routes.test.ts`
   - `apps/daemon/src/daemon-mcp-tool.test.ts`
   - `apps/daemon/src/scaffold-hook-routes.test.ts`
   - `apps/daemon/src/doctor-routes.test.ts`
5. Web unit tests:
   - `apps/web/src/app-state.test.ts`
   - `apps/web/src/stage.test.tsx` or nearest existing stage/session test
   - `apps/web/src/workspace-card.test.ts`
   - `apps/web/src/settings-runtimes.test.tsx` or renamed equivalent
   - `apps/web/src/settings-diagnostics.test.tsx`
6. Install/distribution tests:
   - `scripts/install/upgrade.test.ts`
   - New install guard/ref resolver tests if helpers are extracted.
   - Release preflight helper test if the workflow shell logic is extracted for testability.
7. E2E:
- Add or update an E2E spec covering: open terminal tab, open agent tab with a fake healthy runtime, terminal-only workspace does not show running-agent attention, diagnostics page groups agent runtimes and terminal, hook scaffold button calls the agent-only route and reuses an in-flight scaffold workspace.
- Add terminal smoke assertions to the E2E spec: paste text, send Ctrl/meta key sequences where Playwright can synthesize them, resize the viewport/pane, print long output, run an alternate-screen command when available, reload/reconnect, and verify two sessions do not share output.

## Schema or contract generation

No separate schema generation command exists. Update Zod contracts in `@citadel/contracts`, TypeScript references, and imports directly. No new dependencies should be added.

## Verification

Required before PR:

- `make check` — comprehensive architecture, size, typecheck, lint, tests, coverage, dependency, and build gate.
- `make e2e` — required because session creation, settings, diagnostics, and hook scaffolding touch browser workflows.
- `make smoke` — required because daemon REST/MCP/session/install-facing APIs change.
- `make performance` — required because `/api/state`, session tab rendering, terminal attach, and startup paths are touched.
- Mechanical reference audit:
  - `rg -n 'agent_sessions|runtimeId: "shell"|\\bruntimes\\b' apps packages specs docs scripts .github`
  - Review every hit and leave only documented legacy-migration/test references.
