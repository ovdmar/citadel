# Agent Prompt History

Citadel persists the ordered list of user-authored prompts for every
agent session so that other agents — or the cockpit UI — can see what
each session was started with and what steering it received afterward.

## Data model

Table `agent_session_prompts` (migration `6`):

| column        | notes                                                                  |
| ------------- | ---------------------------------------------------------------------- |
| `id`          | `pmt_…` primary key                                                    |
| `session_id`  | FK to `agent_sessions(id)`, cascades on delete                         |
| `source`      | `"initial" \| "send_agent_message" \| "transcript"`                    |
| `role`        | always `"user"` today (kept for future assistant-side history)         |
| `text`        | raw message text                                                       |
| `sent_at`     | ISO timestamp                                                          |
| `external_id` | runtime-provided id (e.g. Claude Code message uuid), unique per session |

`UNIQUE(session_id, external_id)` makes transcript ingestion idempotent.

## Capture paths

1. **Initial prompt** — `OperationService.createAgentSession` writes a
   row with `source = "initial"` whenever the start request carries a
   prompt.
2. **`send_agent_message`** — every follow-up routed through the MCP
   tool / REST mirror inserts a `source = "send_agent_message"` row.
3. **Claude Code transcript** — on-demand. When history is requested
   for a `claude-code` session, `findClaudeTranscriptForSession` resolves
   `~/.claude/projects/<dasherized-cwd>/*.jsonl` and `parseClaudeTranscript`
   extracts every `type: "user"` line whose `message.content` is text
   (tool-result envelopes are skipped). New entries become rows with
   `source = "transcript"` keyed by the message uuid.

We chose on-demand parsing over a background poller: the .jsonl is
small (one line per turn) and we already have the read-side
synchronization point in `readAgentHistory`, so a poller would only
add operational surface.

### Deduplication

When a transcript entry matches a previously DB-captured row (same
text within a 60s window, no `external_id` yet), the DB row is
deleted and replaced by the transcript record. The transcript wins
because it has the canonical uuid and timestamp.

## MCP / REST surface

- `list_agent_sessions` now returns each session with a truncated
  `initialPrompt` (200 char preview) and `messageCount` so callers
  can scan sessions without fetching their full history.
- `read_agent_history` is a new MCP tool: `{ sessionId, limit?, maxChars? }`
  → `{ ok, sessionId, workspaceId, runtimeId, status, total, truncated, prompts[] }`.
  Older messages are dropped first when the response would exceed
  the limits.
- REST mirror: `GET /api/agent-sessions/:sessionId/history`.
