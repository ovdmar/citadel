# Agent Prompt History

Citadel exposes the ordered list of user-authored prompts for every agent
session so other agents — or the cockpit UI — can see what each session
was started with and what steering it received afterward.

## Single source of truth: the runtime's own transcript

We do **not** persist prompts in Citadel's database. Instead, each supported
runtime writes its own transcript to disk; we read it on demand through a
per-runtime adapter. Three things follow from this:

- **One signal covers every input path.** Whether the user typed in the
  cockpit terminal, called the MCP `send_agent_message` tool, or passed a
  prompt via CLI flag at launch, the runtime records it. There's no
  intercept code that could drift from reality.
- **Parsing is deterministic and token-free.** Adapters are pure JS — a
  file read + `JSON.parse` per line + a small filter. No LLM call anywhere.
- **The cockpit UI doesn't need a special path.** Keystrokes go through
  ttyd → tmux → runtime; the runtime captures them; the adapter surfaces
  them.

## Adapters (`packages/runtimes/src/transcripts/`)

Each runtime declares a `RuntimeTranscriptAdapter`:

```ts
type RuntimeTranscriptAdapter = {
  runtimeId: string;
  getUserPrompts: (input: { workspacePath: string; sessionStartedAt: string; home?: string }) => RuntimeUserPrompt[];
};
```

`getUserPromptsForSession({ runtimeId, workspacePath, sessionStartedAt })`
dispatches to the right adapter. Runtimes without one (e.g. `shell`) return
an empty array — prompt history is inherently unavailable for them.

### claude-code

Transcripts live at `~/.claude/projects/<dasherized-cwd>/<uuid>.jsonl`.
The dasherizer replaces every non-alphanumeric character with `-`.

The parser walks the file, keeps lines where `type === "user"` and
`message.role === "user"`, and treats `content` as text either when it is
a string or an array of `{type: "text"}` blocks. Arrays whose blocks are
`tool_result` envelopes are skipped — they're synthetic tool-output turns.

Session matching uses a stat-first pre-filter (`mtime < sessionStartedAt - 60s` ⇒ reject)
followed by a closest-first-prompt-timestamp scoring pass.

### codex

Transcripts live at `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`.
Each file opens with a `session_meta` payload carrying `id`, `cwd`, and
`timestamp`. User input arrives as `response_item` lines with
`payload.role === "user"` and `content[].type === "input_text"`. We skip
the synthetic `<environment_context>…</environment_context>` opener.

Session matching requires `meta.cwd === workspacePath` *and* falls inside
the session-start window. Codex doesn't emit per-message ids, so we
synthesize `<sessionId>:<userIndex>` for dedup-friendly external ids.

### cursor-agent

Stub adapter — returns an empty array. The Cursor CLI's on-disk format
wasn't available on the reference machine when this landed. Slot is wired
so `read_agent_history` and `list_agent_sessions` resolve cleanly for
cursor-agent sessions; a follow-up will fill in the parser. See #17.

## MCP / REST surface

- `list_agent_sessions` decorates each session with `initialPrompt` (200-char
  preview) and `messageCount`. Both come from the adapter, evaluated on
  demand. The mtime pre-filter inside each adapter keeps per-session cost
  bounded even on big project dirs.
- `read_agent_history({ sessionId, limit?, maxChars? })` returns the full
  ordered prompt list. Older prompts are dropped first when limits would be
  exceeded.
- REST mirror: `GET /api/agent-sessions/:sessionId/history`.

## What this PR explicitly does NOT do

- No persistence of prompts in `agent_sessions_prompts` or any sibling table.
  The earlier draft of this feature had a DB-write intercept on
  `send_agent_message`; that path was removed in favor of trusting the
  runtime transcript as authoritative.
- No background polling — adapters run only when an MCP / REST call asks
  for history.
