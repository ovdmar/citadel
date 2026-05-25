Activate the /implement-task skill first.

# Plan: Background agents + scheduled-agent run history

## Acceptance Criteria

- [ ] Scheduled runs no longer pollute the workspaces list when they don't need a workspace.
- [ ] A "background agent" is a tmux-backed agent session that is **not** registered as a Citadel workspace.
- [ ] Scheduled agents gain a `runMode` of `"workspace"` (current behavior) or `"background"`.
- [ ] Background mode runs in a configurable cwd that defaults to the repo's `rootPath` and does not create a workspace.
- [ ] Every scheduled-agent run (tick or manual) records a row in a new `scheduled_agent_runs` table with `status`, `started_at`, `ended_at`, `message`, `workspace_id` (nullable), `session_id` (nullable), and `log_file_path`.
- [ ] The Scheduled Agents UI shows a per-row "History" affordance with a log viewer per run.
- [ ] MCP gains `list_scheduled_agent_runs` and `read_scheduled_agent_run_log` tools.
- [ ] Each scheduled agent has an `overlapPolicy` of `"skip"` (default) or `"queue"` that controls what happens when a tick (or manual run) fires while a previous run is still in flight.

## Context and problem statement

We just shipped scheduled agents (`feat(scheduled-agents)` on this branch). Every scheduled run creates a workspace — either a fresh `<prefix>-<timestamp>` worktree or an existing reused one — and the workspace appears in the cockpit navigator. For agents that don't actually need a working tree (e.g. "every morning, ping a Slack channel", "every hour, scrape an RSS feed and write to the scratchpad", "run a one-shot grep across the repo"), this leaves a long trail of stale workspaces that the user has to archive by hand and that bloat the navigator.

We also lack any per-run history. The current model writes only `lastRunAt`, `lastRunStatus`, and `lastRunMessage` to the scheduled agent row — overwritten on every run. There's no way to see the previous 50 runs of a daily sweep, no way to diff today's output from yesterday's, no log archive when a run dies in the middle of the night.

Two changes are needed:

1. **runMode = "background"** — let a scheduled agent opt into spawning a tmux pane in `repo.rootPath` (or a configured cwd) without inserting a workspace row. The pane is still attachable for live observation, but it's tracked in a separate `background_sessions` table that no cockpit list reads.
2. **Per-run history** — a `scheduled_agent_runs` table with one row per fire, plus a captured tmux pane log per run on disk. UI gets a History drawer per scheduled agent. MCP gets two new tools so orchestrator agents can read the same data.

### Scope guardrails — what background mode is NOT for

Background mode targets **non-TUI / line-buffered** workloads: shell commands, scripts, CLIs that emit plain text. Concretely: `bash -lc 'date'`, `curl + jq`, Python scripts, `gh api` pulls. The pipe-pane log is raw PTY bytes, so ANSI cursor-positioning and alternate-screen toggles emitted by TUI runtimes (Claude Code, Codex, anything ncurses) produce an unreadable log file even though the run itself "works".

If a user wants to schedule a Claude Code session, they should use `runMode='workspace'` — that path attaches the session to a workspace whose terminal is already rendered correctly by xterm.js, and the user can attach the live pane via the existing workspace UI. The v1 of background-mode does NOT try to replay ANSI in the History drawer.

This is enforced by: (a) plan-level documentation in the create_scheduled_agent MCP tool description, (b) a settings hint under the "Run mode" selector in the UI, and (c) — for any runtime that has `capabilities.supportsTui = true` (a new field on `AgentRuntime`) — the create form disables the `background` option for that runtime with an explanatory tooltip.

## Spec alignment

No specs directory in this repo (`/review-pr` declared no extension last run). N/A.

## Implementation approach

- **Separate background_sessions table, not nullable workspace_id on agent_sessions.** The existing `agent_sessions.workspace_id` is `TEXT NOT NULL REFERENCES workspaces(id)` and is read by every cockpit and reconciler path. Relaxing it would force defensive `?? null` everywhere. A parallel table with the same shape minus `workspace_id` keeps the workspace-bound code path untouched and gives background sessions their own list endpoint when we eventually want one. The existing `TtydManager` and `ensureTmuxSession` already take a `cwd` + `sessionName` — they don't care which table the row lives in.
- **Fresh background session per scheduled run.** Same shape as the existing `workspaceStrategy: "new"` — create a new tmux session per fire so each run gets an isolated pane and its own log file. Long-lived shared background sessions (analogous to `workspaceStrategy: "existing"`) are out of scope for v1.
- **tmux pipe-pane for run logs, bounded by `head -c`.** After `tmux new-session`, run `tmux pipe-pane -O -t <sessionName> <shellQuotedCommand>` where the shell command is `head -c ${LOG_TRUNCATION_BYTES} >> <quotedLogPath>`. Use a single shared constant `LOG_TRUNCATION_BYTES = 16 * 1024 * 1024` (16 MiB / 16,777,216 bytes) referenced by both the helper and the run-row close check so the cap and the truncation marker can never disagree. When `head` exits (cap reached), `pipe-pane` notices the broken pipe and stops writing — but pipe-pane itself doesn't surface that as an event. We detect truncation at run-row close: when transitioning to a terminal status, if `fs.statSync(logFilePath).size >= LOG_TRUNCATION_BYTES`, append `log_truncated_at_16mib` to the run row's `message`. The command string is composed via `shellQuote` (currently file-private in `packages/terminal/src/index.ts:98` — export it as part of step 4, since the new helper will import it from the same module).
- **Configurable overlap behavior — `overlapPolicy: 'skip' | 'queue'`.** Each scheduled agent declares what to do when a new fire (cron tick or manual `runNow`) arrives while a previous run is still in flight. The user picks this once at agent creation; it's a property of the agent, not of the individual run.
  - `'skip'` (default; preserves existing behavior): emit a `scheduled-agent.skipped_overlap` activity event and drop the fire. Manual `runNow` returns 409 `{ error: "run_already_in_progress" }`. MCP `run_scheduled_agent_now` returns the same shape.
  - `'queue'`: insert a `scheduled_agent_runs` row with new status `'queued'` and `started_at = now` (the time of the fire, not the time it executes). The runner drains the oldest queued row for that agent as soon as the in-flight run hits a terminal status. Manual `runNow` under queue policy returns 202 `{ queued: true, runId }` instead of 409. Bounded by `MAX_QUEUED_RUNS_PER_AGENT = 10`: if the queue is full, fall back to `'skip'` semantics for this fire (drop + emit `scheduled-agent.queue_full` activity event) so a misconfigured agent can't pile up unboundedly.
- **Run row states.** `'queued' | 'running' | 'succeeded' | 'failed'`. `'queued'` is the new state introduced by the queue policy. UI History drawer renders queued rows with a distinct badge and a "waiting since N minutes" duration.
- **Run row lifecycle.** The runner inserts a `scheduled_agent_runs` row with `status='running'` before `runOnce`'s `execute()`, and on completion stamps `status` (`succeeded`/`failed`), `ended_at`, and `message`. The existing `lastRunStatus`/`lastRunAt` fields on the scheduled agent stay as a denormalized cache of the most recent run for the "Active schedules" list; the boot-sweep below keeps it in sync after crashes.
- **Boot-sweep covers BOTH the run row and the denormalized cache.** On daemon boot: `SELECT * FROM scheduled_agent_runs WHERE status='running'`. For each row, mark `status='failed'`, `ended_at=now`, `message='daemon_restarted_during_run'`. If this row is also the latest run for its agent, update the agent's `lastRunStatus`/`lastRunMessage` to match so the cockpit list and the History drawer agree.
- **Reconciler is its own numbered step (see step 5).**
- **UI**: per-row "History" button on the scheduled-agents page opens an inline drawer (no new route) that lists the last N runs with status, duration, and a "Logs" expander that streams the file. Pagination not needed in v1 — show the last 50.
- **MCP**: two new tools, both daemon-routed (file IO + DB). `list_scheduled_agent_runs(scheduledAgentId, limit?, offset?)` and `read_scheduled_agent_run_log(runId, offset?, maxBytes?)` — byte offset + `maxBytes`, matching the HTTP route exactly. The "lines"-based variant of `read_agent_output` is intentionally NOT mirrored because background logs are raw bytes (ANSI for any TUI fallthrough; line semantics are unreliable). `maxBytes` defaults to 16 KB, capped at 200 KB per call to mirror `read_agent_output`.

## Alternatives considered

1. **Make `agent_sessions.workspace_id` nullable.** Cheapest in raw lines but high blast radius: 20+ readers across operations + cockpit + reconciler + state assemblers assume the FK. Each one would need null-handling. Rejected — the symmetry with the existing FK isn't worth the cascade.
2. **Reuse the root workspace (`ws_root_<repo>`) for background runs and filter in the navigator.** Tempting — that workspace already exists, the reconciler/cockpit code is unmodified, only a "hide root-workspace sessions" filter is needed. Rejected: the root workspace's tmux pane is also where the user runs interactive shells on the repo root; mixing scheduled-agent panes into it would surprise the user every time they attached. Cleaner separation wins.
3. **Log to in-memory ring buffer instead of disk.** Cheaper than file IO but loses logs across daemon restart, which is exactly when the user most wants to see what happened. Rejected.
4. **One `scheduled_agent_runs` log column with the raw text inline.** Avoids the file path indirection but SQLite rows get bloated fast on chatty agents (claude-code transcripts run into MB). Rejected — file on disk is the right granularity.
5. **Reuse the existing read_agent_output tool by faking a session id.** Conflates "live session output" with "historical run log". Rejected — separate tools make the contract explicit.

## Implementation steps

Each numbered group becomes one "Implement: …" task during `/implement-task`. Steps inside a group are TDD-ordered.

### 1. Contracts & DB schema

- Add `ScheduledAgentRunModeSchema = z.enum(["workspace", "background"])` to `packages/contracts/src/index.ts`.
- Add `ScheduledAgentOverlapPolicySchema = z.enum(["skip", "queue"])`.
- Add `ScheduledAgentRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed"])`.
- Extend `ScheduledAgentSchema` with `runMode: ScheduledAgentRunModeSchema.default("workspace")`, `backgroundCwd: z.string().min(1).max(4000).nullable().default(null)`, and `overlapPolicy: ScheduledAgentOverlapPolicySchema.default("skip")`.
- Extend `CreateScheduledAgentInputSchema` + `UpdateScheduledAgentInputSchema` with the new optional fields and refine: `runMode === "workspace"` requires `workspaceStrategy` + `workspaceName` (existing); `runMode === "background"` ignores those fields (still accepted for backward-compat; not used at run time). `overlapPolicy` is independent of `runMode` and accepted on both.
- Add `ScheduledAgentRunSchema` (id, scheduledAgentId, status: ScheduledAgentRunStatusSchema, enqueuedAt, startedAt: string|null, endedAt: string|null, message: string|null, workspaceId: string|null, sessionId: string|null, backgroundSessionId: string|null, logFilePath: string|null). Lifecycle:
  - `queued`: `enqueuedAt` = fire time. `startedAt` = null. `logFilePath` = null. `workspaceId`/`sessionId`/`backgroundSessionId` all null.
  - `running`: `startedAt` = execution start time (equals `enqueuedAt` for skip-policy runs that executed immediately). `logFilePath` populated. Workspace/session ids populated based on `runMode`.
  - `succeeded`/`failed`: `endedAt` populated. Other fields preserved.
- Add `BackgroundAgentSessionSchema` with **only** fields that have a documented reader in v1:
  - `id` — primary key, referenced by `scheduled_agent_runs.backgroundSessionId`.
  - `scheduledAgentId` — nullable for future ad-hoc background sessions; for v1 always set.
  - `cwd` — read by the reconciler when re-attaching after restart; surfaced in the History drawer per run.
  - `logFilePath` — read by the reconciler to stop `pipe-pane` on pane exit; read by `read_scheduled_agent_run_log` indirectly via the run row.
  - `tmuxSessionName` + `tmuxSessionId` — read by the reconciler for liveness checks.
  - `status` — `"running"|"stopped"|"failed"`, read by the reconciler and used to terminate the matching run row.
  - `createdAt` + `updatedAt` — read by `listBackgroundSessions` for ordering.
  - Intentionally omitted from v1: `displayName`, `transport`, `runtimeId`. Adding them later is a single ensureColumn — defer until something reads them.

#### Migration strategy

All operations are **additive** — no destructive changes, no renames. SQLite migration via the existing `ensureColumn` pattern + new `CREATE TABLE IF NOT EXISTS`. Reversibility is trivial (drop the new columns/tables); no data loss path.

- Add columns via `ensureColumn`:
  - `scheduled_agents.run_mode TEXT NOT NULL DEFAULT 'workspace'`
  - `scheduled_agents.background_cwd TEXT`
  - `scheduled_agents.overlap_policy TEXT NOT NULL DEFAULT 'skip'`
- New table `scheduled_agent_runs` with indexes on `(scheduled_agent_id, started_at DESC)` for the per-agent history query and on `id` for log lookups. **No FK** to `scheduled_agents` (SQLite cascade behavior is non-obvious and we want explicit cleanup in code — see step 2).
- New table `background_sessions` (fields as above). **No FK** to `scheduled_agents`; explicit cascade in code.
- Bump `schema_migrations` to version 6.

### 2. Store helpers + cascade-on-delete

- New helpers:
  - `insertScheduledAgentRun(run)`, `findScheduledAgentRun(id)`, `listScheduledAgentRuns(scheduledAgentId, { limit, offset })`, `recordScheduledAgentRunOutcome(id, { status, endedAt, message })`.
  - `findInFlightScheduledAgentRun(scheduledAgentId): ScheduledAgentRun | null` — used by the overlap guard (returns the most recent `status='running'` row for the agent, if any).
  - `listInFlightScheduledAgentRuns(): ScheduledAgentRun[]` — used by the boot-sweep.
  - `countQueuedScheduledAgentRuns(scheduledAgentId): number` — used by the queue-cap check.
  - `findOldestQueuedScheduledAgentRun(scheduledAgentId): ScheduledAgentRun | null` — used by the drain.
  - `promoteScheduledAgentRunToRunning(id, { logFilePath }): ScheduledAgentRun` — flips a queued row to running, stamps a new `startedAt` (execution start; the original fire time stays in a separate column — see schema note below) and writes the now-computable `logFilePath`.
  - `insertBackgroundSession`, `findBackgroundSession`, `findBackgroundSessionsByScheduledAgent(scheduledAgentId)`, `updateBackgroundSessionStatus(id, status)`, `deleteBackgroundSession(id)`.

  Schema note: `scheduled_agent_runs` gets two timestamp columns — `enqueued_at` (when the fire arrived) and `started_at` (when execution actually started; equals `enqueued_at` for skip-policy runs that execute immediately). The History drawer renders `enqueued_at` as "fired at" and shows `started_at - enqueued_at` as "queued for" when non-zero.
- **Modify** `deleteScheduledAgent(id)` to perform an explicit transactional cascade with an in-flight guard:
  0. Call `findInFlightScheduledAgentRun(id)`. If non-null, **abort with a typed error** `in_flight_run` — the HTTP DELETE route maps this to 409 `{ error: "in_flight_run" }` so the operator can wait (or wait for the reconciler to terminate the orphan). The MCP `delete_scheduled_agent` tool returns the same shape. Without this, the cascade races with the running `execute()` — log-file unlinks happen while the runner is still appending, and the runner's outcome write lands on a row that's about to be deleted.
  1. Look up `listScheduledAgentRuns(id)` (no pagination — get all for cleanup).
  2. For each run with a non-null `logFilePath`, best-effort `fs.unlinkSync` the file (swallow ENOENT; log warn on other errors).
  3. Look up `findBackgroundSessionsByScheduledAgent(id)`. For each, kill the tmux session (`tmux kill-session -t <name>`, swallow "session not found"), then `deleteBackgroundSession(row.id)`.
  4. `DELETE FROM scheduled_agent_runs WHERE scheduled_agent_id = ?`.
  5. `DELETE FROM scheduled_agents WHERE id = ?` (existing behavior).
  - Wrapped in a single SQLite transaction; the tmux kills happen inside the transaction window but are idempotent (best-effort).
- Row mappers in `packages/db/src/rows.ts`.

### 3. Runner: run-row lifecycle + concurrent-run guard + boot-sweep

- Two helpers shape the row lifecycle:
  - `enqueueRunRow(scheduledAgent, now): runId` inserts a row with `status='queued'`, `enqueued_at=now`, `started_at=null`, `log_file_path=null`. Used both for queued fires under `overlapPolicy='queue'` and as the first step of an immediate run (which is then promoted in the same call sequence).
  - `promoteRunRow(runId, now)`: flips `status='queued' → 'running'`, stamps `started_at=now`, computes `logFilePath = ${dataDir}/scheduled-runs/${scheduledAgentId}/${runId}.log` (mkdir -p the parent), writes it on the row.

- **`tick()` fire decision (recurring + one-shot)** — for every eligible agent:
  1. Call `findInFlightScheduledAgentRun(agent.id)`.
  2. If null → enqueue + promote + execute (the normal path).
  3. If non-null and `agent.overlapPolicy === 'skip'` → emit `scheduled-agent.skipped_overlap` activity event, drop the fire (current behavior).
  4. If non-null and `agent.overlapPolicy === 'queue'`:
     - If `countQueuedScheduledAgentRuns(agent.id) >= 10` → emit `scheduled-agent.queue_full`, drop the fire (skip-fallback for runaway protection).
     - Otherwise `enqueueRunRow(agent, now)` and stop — the drain (see below) will execute it.
  - The one-shot `lastRunStatus !== "never"` guard stays — defense in depth.

- **`execute()`** is unchanged on its workspace/background branch logic, but now operates on a promoted row (status already `'running'`, `logFilePath` already written). It branches on `agent.runMode`:
  - `"workspace"`: `resolveWorkspace` + `operations.createAgentSession`. Set `runRow.workspaceId`/`runRow.sessionId` on success.
  - `"background"`: `fs.statSync(cwd)` precheck. On failure write `status='failed'`, `message='background_cwd_missing'`, skip. Otherwise call `createBackgroundAgentSession({ cwd, runtimeId, prompt, scheduledAgentId, logFilePath })`. Set `runRow.backgroundSessionId` on success.

- **Run completion** — after `recordScheduledAgentRunOutcome(runId, ...)`:
  1. Update the denormalized cache on the scheduled agent (`lastRunStatus`, `lastRunAt`, `lastRunMessage`).
  2. Call `drainQueue(agent.id)` (see below).

- **`drainQueue(scheduledAgentId)`** — runs after every outcome and on boot-sweep:
  1. `findOldestQueuedScheduledAgentRun(scheduledAgentId)`. If null, done.
  2. `promoteRunRow(queuedRow.id, now)`.
  3. Schedule `execute()` for the promoted row on the next event-loop tick (don't await — return immediately; the runner's existing concurrency model is one-fire-at-a-time per agent because every fire goes through the in-flight check).
  - Drain is async and idempotent: if two callers both invoke drain for the same agent, the in-flight check inside `execute()`'s wrapper short-circuits the second.

- **Manual `runNow` path** — re-uses the same decision logic:
  - In-flight null: enqueue + promote + execute synchronously; return `{ ok: true, value: { runId, status: 'running' | 'succeeded' | 'failed', ... } }`.
  - In-flight non-null, policy=skip: HTTP returns 409 `{ error: "run_already_in_progress" }`; service returns `{ ok: false, error: "run_already_in_progress" }`; MCP returns the same.
  - In-flight non-null, policy=queue, room in queue: enqueue and return 202 `{ queued: true, runId, queuePosition: N }`. MCP returns the queued runId so the caller can poll the History endpoint.
  - In-flight non-null, policy=queue, queue full: 429 `{ error: "queue_full", limit: 10 }` (changed from 409 to express "back off and try later" semantics).

- **Boot-sweep `recoverInFlightRuns()`**:
  1. `store.listInFlightScheduledAgentRuns()`.
  2. For each row: `recordScheduledAgentRunOutcome(row.id, { status: 'failed', endedAt: nowIso(), message: 'daemon_restarted_during_run' })`.
  3. If this run is the most recent for its agent, also update `scheduled_agents.lastRunStatus`/`lastRunMessage` so the list view doesn't lie.
  4. Best-effort `tmux kill-session` for any matching background session, then delete the `background_sessions` row.
  5. **For each affected agent, call `drainQueue(agentId)`** so any queued runs that were waiting on a now-failed in-flight predecessor start executing. Without this, queued rows would sit forever after a crash.

### 4. Background session creator (operations + terminal)

- New module `packages/operations/src/create-background-agent-session.ts`:
  - Mirrors `createAgentSession` but takes `{ cwd, runtimeId, runtime, prompt?, scheduledAgentId, logFilePath }`.
  - Session name: `citadel_bg_${createId("bgagent").slice(-8)}` (no workspace prefix).
  - Wraps in try/catch: if any step after `ensureTmuxSession` throws, `tmux kill-session -t <sessionName>` to avoid an orphaned pane.
  - Calls a new `ensureTmuxSessionRaw({ sessionName, cwd, command, args })` (see below) — **NOT** `ensureTmuxSession`. The existing helper wraps the agent in a fallback-shell script so a human can attach after the agent exits. Background sessions have no human attached; the wrapper's `printf "[citadel] Agent exited..."` line, the `exec "${SHELL:-/bin/bash}" -l` fallback shell, and any subsequent PS1 prompt would all stream into the per-run log file and contaminate it. Skipping the wrapper means the pane terminates the moment the agent exits, which is exactly what we want — the reconciler then sees `tmuxSessionExists(name) === false` on its next tick and closes the run row.
  - After `ensureTmuxSessionRaw` returns, calls new `pipeBackgroundSessionToLog(sessionName, logFilePath)` (see below).
  - Inserts a `background_sessions` row.
  - Records activity (`agent.started.background` type so it's distinguishable from workspace agents).
- New helpers in `@citadel/terminal` (export `shellQuote` from `packages/terminal/src/index.ts` — currently file-private):
  ```ts
  export function ensureTmuxSessionRaw(args: { sessionName: string; cwd: string; command: string; args: string[] }) {
    // Like ensureTmuxSession but bypasses the agent-wrapper script — runs `command args`
    // directly under tmux. When the command exits, the pane terminates. Used by
    // background sessions where there's no human to fall back to.
    if (tmuxSessionExists(args.sessionName)) return; // idempotent reattach
    execFileAsync("tmux", ["new-session", "-d", "-s", args.sessionName, "-c", args.cwd, args.command, ...args.args]);
  }
  export const LOG_TRUNCATION_BYTES = 16 * 1024 * 1024; // 16 MiB
  export function pipeBackgroundSessionToLog(sessionName: string, logFilePath: string) {
    // Bounded streaming so a runaway agent can't fill disk. shellQuote the path.
    const quotedPath = shellQuote(logFilePath);
    const command = `head -c ${LOG_TRUNCATION_BYTES} >> ${quotedPath}`;
    execFileSync("tmux", ["pipe-pane", "-O", "-t", sessionName, command]);
  }
  export function stopBackgroundSessionPipe(sessionName: string) {
    execFileSync("tmux", ["pipe-pane", "-t", sessionName]); // no command = stop streaming
  }
  ```
  All three call `tmux` via `execFile` argv (no shell). The pipe-pane command embeds `logFilePath` through `shellQuote` so a `dataDir` containing spaces or quotes is safe.

### 5. Reconciler: background-session lifecycle

Promoted to its own step — the wave-hand in v1 was wrong.

- Extend `reconcileStore` (`packages/operations/src/helpers.ts`) so the loop that examines `agent_sessions` ALSO examines `background_sessions`, but with different cleanup rules — no workspace lookup, no FK assumption.
- For each background session row whose `status='running'`:
  1. If `tmuxSessionExists(row.tmuxSessionName)` is false → the pane is gone. Update the row to `status='stopped'`. Look up the in-flight `scheduled_agent_runs` row whose `backgroundSessionId = row.id`. If found and still `running`, call `recordScheduledAgentRunOutcome(runRow.id, { status: 'succeeded' | 'failed', endedAt: now, message: <derived from agent exit, defaulting to 'session_ended'> })`. Best-effort `fs.statSync(logFilePath)` to derive the truthful outcome (if log file has any bytes, treat as `succeeded` for v1; daemon-level richer semantics deferred).
  2. If the tmux pane exists but `isAgentLive(row.tmuxSessionName)` is false → the agent exited but the pane is alive (fallback shell). Same handling as (1): mark the run row terminal, but additionally call `stopBackgroundSessionPipe` to stop the `pipe-pane` stream so the fallback shell's bash prompt doesn't get appended to the log.
- Add a small reconciliation test that exercises both transitions and asserts the matching `scheduled_agent_runs` row flips terminal with a non-null `endedAt`.

### 6. HTTP routes

- `GET /api/scheduled-agents/:id/runs?limit&offset` — returns `{ runs: ScheduledAgentRun[] }`.
- `GET /api/scheduled-agents/:id/runs/:runId/log?maxBytes&offset` — byte-offset + `maxBytes` contract (renamed from `maxChars` because the contract is bytes, not characters). Reads `runRow.logFilePath`, opens with `fs.openSync` + reads `[offset, offset+maxBytes)` into a `Buffer`, then returns `Buffer.toString('utf8')` as `content`. `bytesRead` is the byte count consumed (not the resulting string length). Consumers compute `nextOffset = offset + bytesRead`. Lossy at slice boundaries — a UTF-8 codepoint or ANSI escape split across a chunk boundary will be mangled in the rendered `content` for that chunk, but re-fetching from `offset=0` always returns the prefix correctly. Acceptable v1 trade-off; documented in the MCP tool description. Cap `maxBytes` at 200 KB. 404 if file missing or run isn't owned by the agent (defense against id confusion).
- `POST /api/scheduled-agents/:id/run` — response depends on `agent.overlapPolicy` and queue state:
  - In-flight null → 202 `{ ok: true, status, runId, ... }` (synchronous execution result on the runOnce path).
  - In-flight non-null, policy=skip → 409 `{ error: "run_already_in_progress" }`.
  - In-flight non-null, policy=queue, room → 202 `{ queued: true, runId, queuePosition }`.
  - In-flight non-null, policy=queue, queue full → 429 `{ error: "queue_full", limit: 10 }`.
- (Optional in v1) `GET /api/background-sessions` for a future debugging panel — defer if scope grows.

### 7. MCP tools

- Add `list_scheduled_agent_runs` and `read_scheduled_agent_run_log` to `McpToolName` union and `mcpToolDefinitions()` with `destructive=false`.
  - `read_scheduled_agent_run_log` input: `{ runId: string; offset?: integer >= 0; maxBytes?: integer 256..200_000 default 16_000 }`. Returns `{ content: string; bytesRead: integer; nextOffset: integer; truncated: boolean }`. `content` is the UTF-8 decode of the byte slice; `bytesRead` is the byte count (used for `nextOffset` arithmetic — do NOT use `content.length`). Tool doc string documents the slice-boundary lossiness.
- Daemon handlers in `apps/daemon/src/daemon-mcp-tool.ts`. Both go through a new `ScheduledAgentRunService` (mirroring `ScheduledAgentService`) so HTTP + MCP stay in sync. Latest review flagged the same duplication once already.
- `callMcpTool` returns `{ error: "scheduled_agent_run_tool_requires_daemon" }` for both — same pattern as scratchpad and read_agent_output.
- Extend `create_scheduled_agent` / `update_scheduled_agent` tool definitions with `runMode`, `backgroundCwd`, and `overlapPolicy`. Doc strings call out:
  - "background runs are intended for non-TUI commands; for TUI agents use runMode='workspace'."
  - "switching runMode via update does NOT delete previously-created workspaces."
  - "overlapPolicy='skip' (default) drops a fire when a previous run is still in flight; overlapPolicy='queue' enqueues it (max 10 queued runs per agent)."
- `run_scheduled_agent_now` mirrors the HTTP response branches:
  - In-flight null → `{ status, runId, ... }`.
  - In-flight non-null, policy=skip → `{ error: "run_already_in_progress" }`.
  - In-flight non-null, policy=queue, room → `{ queued: true, runId, queuePosition }`.
  - In-flight non-null, policy=queue, queue full → `{ error: "queue_full", limit: 10 }`.

### 8. SSE / event surface

- Keep the existing `scheduled-agent.run` event with its current `{ fired: string[] }` shape — used by the cockpit list refetch.
- Add a NEW event `scheduled-agent.run-row` with payload `{ scheduledAgentId, runId, status }` emitted on every status transition: `null → queued`, `queued → running`, `running → succeeded`/`failed`. The History drawer subscribes by `scheduledAgentId` and refetches so a queued row appears immediately and updates as it drains.

### 9. UI: create form + history drawer

- `apps/web/src/settings-scheduled-agents.tsx`:
  - Add a "Run mode" selector to the create form (`Workspace` / `Background`).
  - When `Background`: show a `cwd` input that placeholders the repo's rootPath; hide the `workspaceStrategy` + `workspaceName` + `baseBranch` fields.
  - Show a one-line hint under the selector: "Background is intended for non-TUI scripts. For Claude/Codex sessions, use Workspace."
  - If `runtime.capabilities.supportsTui === true` (new optional field on `AgentRuntime`), disable the `Background` option with a tooltip. Default `supportsTui=false` for the existing `shell` runtime; mark `claude-code`/`codex` as `supportsTui=true` in their runtime config.
  - Add a "When already running" selector below the schedule with two options: "Skip this fire" (default, `overlapPolicy='skip'`) and "Queue and run after" (`overlapPolicy='queue'`), with hint text "Queue is bounded at 10 waiting runs per agent."
  - Row display: replace "new workspace per run / reuse" copy with the run-mode summary when `runMode === "background"`. Append the overlap-policy summary ("queues up to 10" / "skips overlaps").
- New component `ScheduledAgentRunHistoryDrawer` (sibling file) opened by a new "History" button on each row. Drawer fetches `/api/scheduled-agents/:id/runs` via React Query, shows a table with status (queued / running / succeeded / failed), enqueued_at, started_at (null for queued), duration, workspace/background indicator, and a "View log" expander that fetches `/api/scheduled-agents/:id/runs/:runId/log`. Queued rows render with a distinct badge and "waiting for N min" derived from `now - enqueued_at`; their log expander is disabled (nothing to read yet). Running/terminal rows render the log monospace with auto-scroll-to-bottom on initial load. The log viewer renders raw bytes — for v1 we do NOT strip or replay ANSI. The plan documents that this is the trade-off (see scope guardrails above).
- Subscribe to the new `scheduled-agent.run-row` SSE event in the open drawer.

### 10. State assembly + StateResponse

- Extend `app-state.ts` `StateResponse` (and the corresponding daemon-side assembly) only if needed to surface a "recent runs count" badge on each row. Defer if scope grows — the drawer fetches on open.
- Background sessions are intentionally NOT added to `StateResponse.sessions` (that list drives the cockpit). They have a dedicated endpoint if/when we surface them.

### 11. Cleanup pass

- Update existing tests that assert `lastRunStatus` after scheduled-agent runs to also assert the run row was written. The narrow tests in `packages/operations/src/scheduled-agents.test.ts` and `apps/daemon/src/scheduled-agent-routes.test.ts` are the targets.
- Update the in-conversation MCP doc strings to mention `runMode` and the new tools.
- Wire `runner.recoverInFlightRuns()` into the daemon startup sequence (after `store.migrate()` and before the scheduler interval starts).

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| BE unit | **Required** | Runner + store + service logic for background path, run row lifecycle, concurrent-run guard, boot-sweep, reconciler transitions, schema validation. |
| FE unit | **Required** | New helpers in `settings-scheduled-agents.tsx` (form-state branching when runMode flips, derived cwd resolution, supportsTui gating); drawer rendering with mocked fetch. |
| Integration | **Required** | HTTP routes for /runs list + /log slice end-to-end against a real SqliteStore + temp dataDir; MCP handler shape mapping; cascade-on-delete; 409 on concurrent run-now. |
| E2E | **Not required** | Playwright suite doesn't currently cover scheduled agents and adding it for one drawer is disproportionate. Cover via integration + a manual smoke noted in the implementation report. Flagged as **remaining tech debt**: the cockpit's FE has no component-test pattern and is acquiring untested UI surface across multiple PRs — plan a dedicated PR to introduce vitest+RTL once this stream lands. |

### New tests to add

- `packages/contracts/src/index.test.ts`:
  - "accepts runMode='background' with backgroundCwd and no workspace fields"
  - "defaults runMode to 'workspace' when omitted"
  - "rejects backgroundCwd shorter than 1 char"
  - "defaults overlapPolicy to 'skip' when omitted"
  - "accepts overlapPolicy='queue' independently of runMode"
- `packages/db/src/index.test.ts`:
  - "round-trips scheduled_agent_runs rows including null startedAt/endedAt/message and the 'queued' status"
  - "listScheduledAgentRuns returns DESC by enqueued_at and respects limit (queued + terminal rows interleaved correctly)"
  - "findInFlightScheduledAgentRun returns the running row and ignores queued + terminals"
  - "countQueuedScheduledAgentRuns + findOldestQueuedScheduledAgentRun match by scheduledAgentId and order by enqueued_at ASC"
  - "promoteScheduledAgentRunToRunning flips queued → running and writes startedAt + logFilePath"
  - "insertBackgroundSession + findBackgroundSessionsByScheduledAgent filter correctly"
  - "deleteScheduledAgent cascades: removes runs (queued + terminal), background sessions, and log files on disk"
  - "migrate adds run_mode/background_cwd/overlap_policy to existing rows with defaults ('workspace'/null/'skip')"
- `packages/operations/src/scheduled-agents.test.ts`:
  - "background runMode does NOT create a workspace and inserts a background_sessions row"
  - "background runMode with missing cwd records 'background_cwd_missing' and does not spawn a pane"
  - "every runOnce writes a scheduled_agent_runs row with status running→succeeded/failed"
  - "log file path is derived under dataDir/scheduled-runs/<agent>/<run>.log and the parent dir is created"
  - "tick(): a background one-shot fires once, the run row records sessionId=null/backgroundSessionId=set"
  - "tick(): with overlapPolicy='skip' and an in-flight run, skips the fire and emits scheduled-agent.skipped_overlap"
  - "tick(): with overlapPolicy='queue' and an in-flight run, enqueues a 'queued' row and emits scheduled-agent.run-row(status='queued')"
  - "tick(): with overlapPolicy='queue' and queue at 10, drops the fire and emits scheduled-agent.queue_full"
  - "completing a run drains the oldest queued row for that agent: status flips queued → running, startedAt is stamped, and execute() runs"
  - "drain is bounded to one promotion per outcome: 3 queued rows + one in-flight will drain over 3 sequential completions, NOT all at once"
  - "runOnce(manual) under skip returns { ok: false, error: 'run_already_in_progress' }; under queue returns { ok: true, value: { queued: true, runId, queuePosition } }; under queue-full returns { ok: false, error: 'queue_full', limit: 10 }"
  - "recoverInFlightRuns flips orphaned 'running' rows to 'failed' AND updates the agent's lastRunStatus when this is the latest run"
  - "recoverInFlightRuns drains queued rows for each affected agent so a queue that was waiting on a failed in-flight predecessor resumes after restart"
  - "run-row close appends 'log_truncated_at_16mib' to message when the log file reached the 16 MiB cap (single shared LOG_TRUNCATION_BYTES constant)"
- `packages/operations/src/helpers.test.ts` (or a new `reconcile.test.ts` if cleaner):
  - "reconcile flips background-session 'running' rows whose tmux pane is gone to 'stopped' and terminates the matching in-flight run row"
  - "reconcile stops the pipe-pane stream when the agent exited but the pane is alive"
- `packages/terminal/src/index.test.ts` (extend):
  - "pipeBackgroundSessionToLog shellQuotes a path containing a space without breaking the tmux command"
  - "pipeBackgroundSessionToLog stops streaming after 16 MB and the file size is capped"
  - "ensureTmuxSessionRaw does NOT inject the agent wrapper — the pane terminates the moment the command exits (no fallback shell)"
- `apps/daemon/src/scheduled-agent-service.test.ts` (extend):
  - "list_scheduled_agent_runs MCP returns the rows for the given agent"
  - "read_scheduled_agent_run_log returns the log slice capped at maxBytes and 404s when the file is missing"
  - "read_scheduled_agent_run_log surfaces bytesRead distinct from content.length on a slice that splits a UTF-8 codepoint"
  - "run_scheduled_agent_now returns { ok: false, error: 'run_already_in_progress' } when a run is in flight"
- `apps/daemon/src/scheduled-agent-routes.test.ts` (extend):
  - "GET /api/scheduled-agents/:id/runs returns 200 with paged rows"
  - "GET /api/scheduled-agents/:id/runs/:runId/log returns 404 when the runId doesn't belong to the agent"
  - "POST /api/scheduled-agents/:id/run returns 409 { error: 'run_already_in_progress' } under overlapPolicy='skip'"
  - "POST /api/scheduled-agents/:id/run returns 202 { queued: true, runId, queuePosition } under overlapPolicy='queue' when in-flight"
  - "POST /api/scheduled-agents/:id/run returns 429 { error: 'queue_full', limit: 10 } when the queue is full"
  - "DELETE /api/scheduled-agents/:id returns 409 { error: 'in_flight_run' } when a run is currently executing"

### Existing tests to update

- `packages/operations/src/scheduled-agents.test.ts` — the "fires one-shot agents only after their runAt and auto-disables them" case must additionally assert that exactly one `scheduled_agent_runs` row exists for the fire and zero for the pre-runAt tick.
- `apps/daemon/src/scheduled-agent-routes.test.ts` — the existing manual-run test must assert the run row's `status` reflects the runOnce outcome.

### Assertions to add/change/tighten

- After every runner test that fires a tick: `expect(store.listScheduledAgentRuns(agent.id)).toHaveLength(N)` with `N` matching the expected fire count.
- Background-path tests must assert `store.listWorkspaces(repo.id)` is unchanged (no workspace pollution).
- MCP envelope tests must assert the response shape verbatim (`{ runs: [...] }` and `{ content, bytesRead, nextOffset, truncated }`) so future drift breaks the test, not a downstream consumer.
- Cascade test asserts `fs.existsSync(logFilePath)` is false after the agent delete.

### Failure modes / edge cases / regression risks

- Race: tick fires, run row inserted with status='running', daemon crashes mid-run. On restart the row stays "running" forever. **Mitigated** by `recoverInFlightRuns()` on boot + denormalized cache rewrite.
- Concurrent fires: long-running agent overruns its cron interval. Resolved per `overlapPolicy`:
  - `'skip'` (default): drop the fire; emit `scheduled-agent.skipped_overlap`. Preserves existing behavior.
  - `'queue'`: enqueue (up to 10); drain in FIFO order on each outcome.
  - **Queue runaway guard**: bounded at 10 queued rows per agent; eleventh fire falls back to skip semantics and emits `scheduled-agent.queue_full` so the user can see they're saturated.
- Drain on crash: a queued row waiting on an in-flight predecessor that died with the daemon would sit forever. **Mitigated** by `recoverInFlightRuns` calling `drainQueue` per affected agent.
- Disk fill: `pipe-pane` writes can balloon. **Mitigated** by `head -c LOG_TRUNCATION_BYTES` (16 MiB) cap per run; run message records the truncation using the same constant.
- Background session leak: `createBackgroundAgentSession` succeeds but the run row insert fails, leaving an orphaned tmux pane. **Mitigated** by try/catch around the whole helper that calls `tmux kill-session` on failure.
- Cascade-on-delete: deleting a scheduled agent today is a hard `DELETE`. With runs/background sessions/log files attached, that orphans the children. **Mitigated** by the explicit cascade in step 2.
- Cascade-vs-in-flight race: a user clicking Delete on an agent that's mid-execute would race the cascade against the runner's outcome write. **Mitigated** by the `findInFlightScheduledAgentRun` precheck in step 2 (DELETE returns 409 `in_flight_run`).
- Background pane log contamination: the existing `ensureTmuxSession` wraps the command in a fallback-shell script. For background sessions the wrapper's `printf "[citadel] Agent exited"` line and the fallback shell's PS1 would stream into the log. **Mitigated** by `ensureTmuxSessionRaw` (no wrapper); pane terminates the moment the agent exits.
- Log-slice UTF-8 fidelity: byte-offset slicing can split a UTF-8 codepoint or ANSI escape at the chunk boundary. **Acknowledged** v1 trade-off — `bytesRead` (not `content.length`) drives `nextOffset`; full re-fetch from `offset=0` is always correct. Documented in the MCP tool description.
- runMode flip via PATCH: switching `workspace` → `background` doesn't (and shouldn't) delete the previously-created workspaces. Documented in the MCP tool description.
- `backgroundCwd` typo: silent failure was unacceptable. **Mitigated** by `fs.statSync` at run time with a typed run-row message.
- SSE event drift: changing the existing `scheduled-agent.run` shape would silently break the cockpit list refetch. **Mitigated** by introducing a new `scheduled-agent.run-row` event instead.
- Shell-injection through `dataDir` quoting: the new `pipe-pane` command embeds `logFilePath`. **Mitigated** by `shellQuote` and an explicit test for paths with spaces.
- TUI agent in background mode: log file is unreadable. **Mitigated** by (a) UI gating via `supportsTui` runtime capability, (b) MCP doc-string warning, (c) UI hint under the selector. We acknowledge this is contract not enforcement; a determined user can still configure a TUI command via the `shell` runtime.

### Adversarial analysis

- **How could this fail in production?** A daemon crash mid-background-run leaves an orphan tmux pane and a run row stuck `running` — fixed by `recoverInFlightRuns` + reconciler. A user pointing `backgroundCwd` at `/proc` or a deleted dir — fixed by the `fs.statSync` precheck. A user creating an "every-minute" agent whose script takes 90s — fixed by the in-flight guard.
- **What user actions trigger unexpected behavior?** Switching runMode mid-life. Documented. Deleting an agent mid-run — the cascade kills the tmux session and removes log files; the in-flight run row is also dropped (the cascade does it before transitioning, so the orphan check has nothing to find). Add a test for "delete while running".
- **What existing behavior could break?** runMode defaults to 'workspace' and the existing path is untouched. Regression test: a recurring workspace-mode agent still creates a workspace per fire AND now also writes a run row.
- **Which tests credibly catch those failures?** `recoverInFlightRuns` test, reconciler transition tests, cwd-missing test, in-flight-guard test, cascade-on-delete-while-running test.
- **What gaps remain?** Live log streaming via SSE/websocket is deferred — the drawer re-fetches on the `scheduled-agent.run-row` event. UI for ad-hoc background sessions (not scheduled) is deferred. ANSI replay for TUI background runs is deferred (and discouraged by the scope guardrails). Log rotation beyond the per-run 16 MB cap is deferred (the cap bounds a single run; the cascade-on-delete handles long-term per-agent total).

## Tests

Following the test files above, the TDD order is:
1. Contract schema tests → schema edits.
2. DB store tests (including cascade-on-delete) → store helpers + migration.
3. Runner unit tests (including in-flight guard + boot-sweep) → runner changes.
4. Terminal helper tests (pipeBackgroundSessionToLog) → terminal package.
5. Reconciler test → helpers.ts changes.
6. Service test additions → service helpers + concurrent-run mapping.
7. Route integration tests → HTTP handlers (including 409 on concurrent run-now).
8. MCP envelope tests → MCP handlers.
9. UI: add component tests if a precedent exists in the repo (verify during implementation); otherwise rely on integration + manual smoke. Flagged as tech debt (see layer evaluation).

## Schema or contract generation

No generated artifacts. Contracts live in `packages/contracts/src/index.ts` and the inferred types flow through `tsc -b`. Standard typecheck covers it.

## Verification

The repo's check pipeline:

- `pnpm typecheck` — `tsc -b tsconfig.json` across the workspace.
- `pnpm lint` — `biome check .` for formatting + lint.
- `pnpm exec vitest run <scoped paths>` for fast feedback during implementation; `pnpm test` for the full suite.
- `pnpm check` if a full pre-commit pass is wanted (runs the lot).

Manual smoke once the daemon is rebuilt (`make deploy-worktree`):
1. Create a recurring background agent that runs `bash -lc 'date'` every 5 minutes in the repo root.
2. Wait one tick → confirm no new workspace in the navigator, one row in the History drawer, a non-empty log file.
3. Open the History drawer, confirm the log viewer renders the captured `date` output.
4. Create a workspace-mode scheduled agent and confirm it still creates the workspace and shows up in the same History drawer (with workspaceId populated).
5. Create a background agent whose script `sleep 120 && date`, schedule it every minute, and confirm only one run fires (the second tick records a `scheduled-agent.skipped_overlap` activity event and no second `running` row appears).
6. Delete a scheduled agent with runs in its history; verify `~/.citadel/data/scheduled-runs/<agentId>/` is gone.
7. Restart the daemon while a background agent is mid-run; verify the History drawer shows the row terminated as `failed` with `daemon_restarted_during_run`.
8. Create a background agent with `overlapPolicy='queue'` whose script is `sleep 180`, every minute. After ~5 min, the History drawer should show 1 running + up to 4 queued. As each run completes, the next queued one promotes to running; verify the order is FIFO via the `enqueued_at` column.
9. With the same `overlapPolicy='queue'` agent, hit POST `/run` 12 times in quick succession. The first should land synchronously, the next 9 enqueue, and the 11th+12th return 429 `queue_full`.
