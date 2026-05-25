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
[ ] 6. Agents can start or inspect agent sessions through MCP.
[~] 7. Agents can read the latest terminal output of a specific session through MCP (`read_agent_output`, bounded by `lines` and `maxChars`).
[~] 8. Agents can submit a follow-up message/prompt to a specific session through MCP (`send_agent_message`, paste + Enter into the backing tmux pane). Sessions without a tmux backing return `session_has_no_terminal`; sessions not in an active status return `session_not_accepting_input`.
[ ] 9. Agents can inspect operation status through MCP.
[ ] 10. Agents can inspect readiness and next-action state through MCP.
[ ] 11. MCP actions follow the same operation, provider, hook, and safety model as the UI.
[ ] 12. MCP presents product contracts as its primary surface.

### MCP tool inventory

Read-only:
- `inspect_status`, `list_repos`, `list_workspaces`, `list_agent_sessions`,
  `list_provider_health`, `list_runtimes`, `list_workspace_links`,
  `inspect_readiness`, `read_agent_output`.

Daemon-mediated (run through the operation service so they obey the same hook, activity, and safety model as the UI):
- `create_workspace`, `start_agent_session`, `send_agent_message`,
  `stop_agent_session` (destructive), `archive_workspace`,
  `remove_workspace` (destructive), `reconcile` (destructive).

For interactive runtimes like Claude Code, both `start_agent_session` (with a `prompt`) and `send_agent_message` deliver text into the backing tmux pane via a paste buffer followed by Enter. This guarantees the agent actually receives and processes the prompt — it is not just typed into the input box.

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

- `read_scratchpad()` → `{ content, updatedAt }`. Auto-migrates the file on first read after upgrade.
- `write_scratchpad(content)` → `{ content, updatedAt }`. Byte-faithful overwrite; the next read normalizes if needed.
- `append_scratchpad(text)` → **creates a new block** (fresh UUID, end of file). Each call produces exactly one block. **Behavior change** from prior versions, which inserted a blank-line separator; downstream agents that built multi-line content by repeated `append_scratchpad` calls now get one block per call instead of concatenated text.
- `list_blocks()` → `[{ id, text, createdAt, updatedAt }]`. Timestamps are best-effort, derived from version history; due to same-source 60s coalesce, they bracket the real edit time but may be aliased within a coalesce window. Blocks predating history fall back to the file's `mtime`.
- `add_block(text, position?)` — `position` is `'end'` (default) or `{ afterId: string }`.
- `update_block(id, text)` — empty text deletes the block.
- `delete_block(id)`.

All block-level tools go through the same version-history coalesce path; sources are `mcp:add_block`, `mcp:update_block`, `mcp:delete_block` (or `ui:*_block` from the cockpit). Empty blocks are never persisted.

---

keywords: operations, activity, audit, progress, logs, mcp, automation, agents, scratchpad
