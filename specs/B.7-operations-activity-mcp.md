# [B.7] Operations, Activity, And MCP

**Status:** Draft

> Side effects are visible, durable operations. Automation uses the same product contracts as the UI.

## Operations

[~] 1. Long-running or side-effectful work has an operation ID.
[~] 2. Operations have status, progress, logs, error text, and related repo/workspace/session IDs.
[ ] 3. Add repository validation can create an operation when provider/hook checks are slow.
[ ] 4. Remove repository cleanup is an operation.
[ ] 5. Workspace creation is an operation.
[ ] 6. Workspace removal is an operation.
[ ] 7. Setup/teardown hook execution is an operation.
[ ] 8. Provider refresh is an operation when it can be slow or fail.
[ ] 9. Workspace action execution is an operation.
[ ] 10. Jira transition is an operation.
[ ] 11. Agent session start/resume is an operation.
[ ] 12. Running and failed workspace-specific operations are visible in the workspace cockpit.
[ ] 13. Operations support retry/cancel when safe.
[~] 14. Operation rows are deep-linkable from elsewhere in the cockpit via `?id=…` on `/operations` (the deep link highlights and scrolls the target row).
[~] 15. When a workspace's PR has failing CI and no agent session has been active for the configured idle window, Citadel may auto-launch a `fix-ci` agent. The automation is visible/configurable in Settings -> Automations, resolves a healthy configured primary runtime before launching, and may use a configured fallback runtime when the primary is not healthy. Auto-launches are deduplicated per-PR-head-SHA and debounced by a minimum-interval window; activity events emitted by such launches use `source: "automatic-rule"`.
[~] 16. `AutoRecoveryMonitorOptions` accepts an optional `shouldRun?: () => boolean` predicate. When provided, the monitor consults it at the top of every tick and short-circuits the tick (no provider calls, no agent spawn decisions) when it returns false. The daemon wires this to its viewer-gate predicate so auto-recovery doesn't consume GitHub quota when no cockpit tab is connected.
[~] 17. Manager-triggered side effects are operations or activity-backed events with actor/source, idempotency key, target scope, related plan version, and related checkout when applicable.
[~] 18. Automated actions respect global and per-workspace pause state. Human manual launches and important local notifications remain allowed while paused.
[ ] 19. Manager side effects are claimed through a durable action ledger with stable scope/action/fact keys, lease owner/generation fencing, expiry, attempt count, max attempts, related operation/session/artifact ids, PR head, plan version, timestamps, and error state.
[ ] 20. Manager startup reconciliation handles expired leases and side effects that were created before their ledger row was completed. Existing sessions, operations, artifacts, notifications, and ticket transitions are relinked before any retry.

## Activity

[~] 1. Citadel records activity events.
[ ] 2. Activity explains what happened, when, why, and through which provider/hook/action.
[ ] 3. Repository activity is visible from repository settings/detail.
[ ] 4. Workspace activity is visible in the selected workspace.
[ ] 5. Global activity exists for cross-repo monitoring.
[ ] 6. Activity provides enough context to debug failed setup, deploy, provider, or terminal flows.
[ ] 7. Activity links to related operation output.

## MCP

[~] 1. Citadel exposes MCP over normalized Citadel concepts.
[ ] 2. Agents can inspect repositories through MCP.
[ ] 3. Agents can add/register repositories through MCP when policy allows it.
[ ] 4. Agents can inspect workspaces through MCP.
[ ] 5. Agents can create workspaces through MCP.
[ ] 6. Agents can start or inspect agent sessions through MCP. MCP does not list, launch, or expose terminal sessions.
[~] 7. Agents can read the latest terminal output of a specific agent session through MCP (`read_agent_output`, bounded by `lines` and `maxChars`). Passing a terminal workspace-session ID returns `session_not_agent`.
[~] 8. Agents can submit a follow-up message/prompt to a specific agent session through MCP (`send_agent_message`, paste + Enter into the backing tmux pane). Terminal workspace sessions return `session_not_agent`; agent sessions without a tmux backing return `session_has_no_terminal`; agent sessions whose pane foreground is a shell binary (agent not currently running) return `session_not_accepting_input` regardless of the cached DB status because the check is performed at send-time via `pane_current_command`.
[ ] 9. Agents can inspect operation status through MCP.
[ ] 10. Agents can inspect readiness and next-action state through MCP.
[ ] 11. MCP actions follow the same operation, provider, hook, and safety model as the UI.
[ ] 12. MCP presents product contracts as its primary surface.

### MCP tool inventory

Read-only:
- `inspect_status`, `list_repos`, `list_workspaces`, `list_agent_sessions`,
  `list_provider_health`, `list_agent_runtimes`, `list_workspace_links`,
  `inspect_readiness`, `read_agent_output`, `get_citadel_context`,
  `get_workspace_plan`, `get_checkout_ticket`, `get_checkout_pr`,
  `get_checkout_gate_status`, `list_workspace_checkouts`.

Daemon-mediated (run through the operation service so they obey the same hook, activity, and safety model as the UI):
- `create_workspace`, `start_agent_session`, `send_agent_message`,
  `stop_agent_session` (destructive), `archive_workspace`,
  `remove_workspace` (destructive), `reconcile` (destructive),
  `launch_pm_agent`, `launch_architect_agent`, `launch_implementation_agent`,
  `launch_prototype_agent`, `start_workspace_manager`, `pause_workspace_manager`,
  `resume_workspace_manager`, `register_workspace_plan`, `report_plan_deviation`,
  `mark_checkout_ready_for_review`, `register_checkout_review_artifact`,
  `create_workspace_checkout`, `update_ticket_status`.

V1 does not expose `list_custom_agents` or `launch_custom_agent`.

### Workspace Context And Role Launchers

[~] 1. Agent-facing MCP tools accept `cwd` where appropriate. The daemon realpaths the input and resolves it to a registered workspace root or checkout, most-specific-first.
[~] 2. Unknown paths and symlink escapes return errors. Checkout exact/descendant paths beat workspace Home; Home matches the workspace root or non-checkout descendants only.
[~] 3. `launch_pm_agent` can bootstrap a structured workspace shell from an idea or parent issue, or target an existing structured Home.
[~] 4. `launch_architect_agent` targets Home and requires discovery marked ready by a human plus `planApprovalMode`.
[~] 5. `launch_implementation_agent` targets a checkout and enforces active approved plan, parent issue, and exactly one child ticket binding in structured mode.
[~] 6. `launch_prototype_agent` targets a checkout and can run before an active plan.
[~] 7. MCP launchers called by agents enforce pause for automated actors. Human UI launch routes pass explicit manual actor metadata or use a separate path so pause cannot be bypassed accidentally.
[ ] 8. Side-effectful agent-facing MCP/API tools derive actor, session, target, plan, checkout, role/action, and manager-action ownership from server-held context or session-scoped authority records. Body-supplied actor or ownership fields are ignored or rejected on mismatch.
[ ] 9. Authority records are short-lived, hash-stored, constant-time validated, scoped to allowed tools, and revoked on session close, action completion, plan supersession, lease abandonment, checkout archive, manager pause policy changes that invalidate the action, and daemon-admin revocation.

### Workspace Plans And Manager State

[~] 1. `register_workspace_plan` accepts workspace id or validated cwd, validates local plan paths under workspace root, computes hash, allocates the next workspace-local version, and records status/review/decision.
[~] 2. Architect plan registration requires `/do-tech-plan` structure plus `Delivery Units`, `Dependencies / Timeline`, `Manager Handoff`, and `Plan Version Notes`.
[~] 3. Exactly one approved plan version is active. New approved versions supersede older active versions and notify active implementation sessions.
[~] 4. Plan deviations are reported through a structured tool. Manager pauses affected delivery units where possible and can launch architect replan using the workspace approval policy.
[~] 5. The manager state machine is deterministic and uses durable state, not transcript parsing, as source of truth.
[ ] 6. Manager wakes on workspace/provider/gate/session/plan events and a low-frequency configurable tick, coalesces wakeups by workspace, dedupes active actions by scope/action key, and writes manager events/activity for every decision.
[~] 7. One structured manager row exists per structured workspace. One active manager action per scope/action key, one checkout per active plan delivery-unit key, and one review gate attempt per checkout/head/plan are enforced.
[ ] 8. Approved plan registration validates and snapshots a `citadel.delivery_units.v1` machine-readable block. Missing blocks, parser errors, unsafe identifiers, dependency self-edges/cycles, ambiguous repos, missing child issues, branch collisions, or ambiguous refs block approval with repair guidance.
[ ] 9. The pure manager decision reducer consumes workspace, manager, active plan, parsed delivery units, checkouts, sessions, gate snapshots, deviations, provider freshness, durable PR/check facts, and action ledger state, then emits ordered decisions such as sync issue, create checkout, launch implementation, launch review, restack, notify, human input needed, or noop.
[ ] 10. Active plan supersession supersedes pending old-plan actions, marks old sessions/checkouts as plan-stale, maps delivery units only when stable key/child issue identity remain safe, and emits human input needed for incompatible repo, branch, child issue, or dependency changes.
[ ] 11. A managed implementation session that exits without a completion signal is reconciled to blocked/failed and emits human input needed with the missing completion signal reason, rather than leaving the action running indefinitely.
[ ] 12. Local notification facts for ready-for-human-review and human-input-needed have active/resolved/rearmed lifecycle, triggering fact fingerprint, resolved timestamp, dedupe key, SSE invalidation, and `/api/state` or notification endpoint visibility.

For interactive runtimes like Claude Code, both `start_agent_session` (with a `prompt`) and `send_agent_message` deliver text into the backing tmux pane via a paste buffer followed by Enter. This guarantees the agent actually receives and processes the prompt; it is not just typed into the input box. `start_agent_session` is a four-step sequence in the shell-first model: spawn the configured terminal profile (default `bash -l`), wait for the shell prompt (`waitForTerminalIdle`), send the agent runtime launch argv via `tmux send-keys` and wait for the agent's TUI to become foreground (positive `runtimeReadyPredicate` matching the runtime binary name with 15-char `comm` truncation), then paste the initial prompt. Without the positive predicate, a transient subprocess (`direnv` during shell startup, `git`/`rg` mid-session) could be mistaken for the agent and cause the prompt to be pasted before the agent's TUI is ready.

### Scratchpad

The per-workspace `scratchpad.md` file is a shared ideas-capture surface: the user notes thoughts and TODOs in the cockpit, orchestrator agents read/append via MCP.

**Storage format.** Each idea is a block fenced with symmetric HTML comments carrying a UUID:

```markdown
<!-- block:9a3f1b2c-7e44-4f01-8b1d-a2c3d4e5f6a7 -->
first idea

with blank lines inside
<!-- /block:9a3f1b2c-7e44-4f01-8b1d-a2c3d4e5f6a7 -->

<!-- block:2c44d877-1234-4abc-9def-0123456789ab -->
another idea
<!-- /block:2c44d877-1234-4abc-9def-0123456789ab -->
```

The file remains a regular markdown file so external tooling (git, editors, grep) keeps working. UUIDs are never shown in the UI. File order = block order; no separate ordering metadata. The parser accepts any 8-4-4-4-12 hex sequence; the generator emits UUID v4.

**Migration (automatic, on first read).** Existing flat scratchpads (blank-line-separated chunks) are migrated to fenced blocks the first time the daemon reads them after upgrade. The migration is idempotent (re-running on already-fenced content is a no-op) and records exactly one history entry with source `migrate-to-blocks`.

**Lenient parser.** Malformed input does not throw. Unmatched fences consume to the next open fence or EOF. Unfenced top-of-file content is promoted to a new block on the next migration pass. Duplicate UUIDs are reassigned to fresh v4 IDs. A `<!-- block:UUID -->` line inside a triple-backtick code fence is treated as content, not a new block.

**MCP tool surface:**

- `read_scratchpad()` → `{ content, updatedAt, path }`. Auto-migrates the file on first read after upgrade. `path` is the absolute filesystem path the daemon read from — see "Configurable location" below.
- `write_scratchpad(content)` → `{ content, updatedAt }`. Byte-faithful overwrite; the next read normalizes if needed.
- `append_scratchpad(text)` → **creates a new block** (fresh UUID, end of file). Each call produces exactly one block. **Behavior change** from prior versions, which inserted a blank-line separator; downstream agents that built multi-line content by repeated `append_scratchpad` calls now get one block per call instead of concatenated text.
- `list_blocks()` → `[{ id, text, createdAt, updatedAt }]`. Timestamps are best-effort, derived from version history; due to same-source 60s coalesce, they bracket the real edit time but may be aliased within a coalesce window. Blocks predating history fall back to the file's `mtime`.
- `add_block(text, position?)` — `position` is `'end'` (default) or `{ afterId: string }`.
- `update_block(id, text)` — empty text deletes the block.
- `delete_block(id)`.
- `fuzzy_search_scratchpad(query, limit?)` → `{ matches: [{ block, score, matches: [{ indices: [start, end][] }] }] }`. Searches block text only via `fuse.js` (threshold ~0.3); `limit` defaults to 20, clamped to 1..50. Shares the same scoring logic as the cockpit's floating searchbar (`fuzzySearchBlocks` in `@citadel/core`).
- `refine_scratchpad(repoId?, repoName?, prompt?)` → discriminated union `{ ok: true, workspaceId, sessionId, warning? } | { ok: false, error, detail, workspaceId? }`. Thin convenience over `launch_agent` that resolves the saved `refine-scratchpad` Citadel Action prompt (override via `prompt`) and preferred agent runtime, falls back to the next configured agent runtime when that preference is unavailable, validates repo, and launches a workspace named `refine-scratchpad-<ISO-minute>`. The MCP handler dispatches over HTTP to `POST /api/scratchpad/refine`; it does not import daemon modules (architecture-boundary compliance).

All block-level tools go through the same version-history coalesce path; sources are `mcp:add_block`, `mcp:update_block`, `mcp:delete_block` (or `ui:*_block` from the cockpit). Empty blocks are never persisted.

**HTTP endpoints** (daemon side, consumed by the cockpit and the MCP convenience tools):

- `GET /api/scratchpad/blocks/search?q=&limit=` → ranked fuzzy matches over block text.
- `POST /api/scratchpad/refine` body `{ prompt?, repoId? }` → discriminated union response (see `refine_scratchpad` above). Degradation: returns `400 runtime_unavailable` if `claude-code` isn't registered, `400 repo_required` if no repo can be resolved, `502 launch_failed` (with `workspaceId` if the orphan worktree is dirty and was left in place) on `OperationService.launchAgent` exceptions. Response includes a `warning` field when the relevant provider's health is `unavailable` or when the prompt does not contain the substring `in-progress` (case-insensitive — soft safeguard for blocks owned by other agents per the in-progress annotation convention).
- `GET /api/citadel-actions` → list configured actions (built-in + custom).
- `POST /api/citadel-actions` → create a custom action.
- `PUT /api/citadel-actions/:id` body must include `updatedAt`; returns `409 stale_updated_at` if the stored `updatedAt` is newer.
- `DELETE /api/citadel-actions/:id` → 409 for built-ins.
- `POST /api/citadel-actions/:id/reset` → restore a built-in to its frozen default.

**Citadel Actions storage.** `<dataDir>/citadel-actions.json` lives next to `scratchpad.md`. Seeded with built-in `refine-scratchpad` on first read. Each action stores a preferred `runtimeId`; launches use it first and degrade to another configured agent runtime when it is unavailable. All writes go through a daemon-side mutex (one promise queue per dataDir); the `updatedAt` field provides stale-write protection on top of mutex serialization.

**Configurable location.** The notes file path is configurable via the `scratchpad.path` field on `CitadelConfig`. Defaults to `<dataDir>/scratchpad.md` (preserving the legacy location for every existing install). Configurable to any absolute path; the schema tilde-expands leading `~/` against `os.homedir()` before validating absoluteness. Settable from the cockpit's structured config form ("Notes location") and persisted via `PUT /api/config`. Edits take effect on the next request — no daemon restart.

Both `read_scratchpad` and `inspect_status` expose the resolved absolute path so MCP-using agents can discover where notes live without a separate config call:

- `read_scratchpad()` → `{ content, updatedAt, path }`.
- `inspect_status()` → `{ ..., scratchpad: { path } }`.

The `path` field is always populated on the daemon-dispatched MCP path (`scratchpadPath` is a required field on the daemon's `McpToolContext`). The snapshot-fallback response for `read_scratchpad` continues to be `{ error: "scratchpad_tool_requires_daemon" }` — unchanged.

**Worktree-mode strip.** In worktree mode (`CITADEL_WORKTREE=1`), `scratchpad.path` is stripped from the raw config on **load** the same way `dataDir`/`databasePath` are stripped today, preventing a worktree daemon from inheriting a prod-installed notes path through a shared config file. A `PUT /api/config` from a worktree daemon may still persist `scratchpad.path` to its worktree-scoped config file in memory and on disk; the next `loadConfig` drops it. This asymmetry matches existing dataDir/databasePath behavior and is intentional — strip-on-load is the load-bearing defense; the worktree's config is scoped under `<dataDir>/worktrees/<name>/citadel.config.json` and cannot pollute the prod install's file regardless.

**History stays in `<dataDir>`.** The version-history JSONL (`scratchpad-history.jsonl`) remains under `<dataDir>` even when the notes file is configured to live elsewhere. History is internal daemon state, not user-facing markdown: keeping it pinned to `<dataDir>` matches the database, runtime logs, and other internal state, and avoids leaking daemon internals into user-controlled sync folders.

**First-read migration on a user-supplied file.** If `scratchpad.path` points at a pre-existing non-fenced markdown file, the first read triggers `migrateIfNeeded` and rewrites it to fenced-block form (history entry: `migrate-to-blocks`). The daemon emits a single `console.warn` line naming the path so the rewrite is not silent. A UI banner is **future polish** — not in the initial implementation.

---

keywords: operations, activity, audit, progress, logs, mcp, automation, agents, scratchpad, fuzzy search, refine, citadel actions
