Activate the /implement-task skill first.

# Terminal PTY Daemon Performance Redesign

## 1. Requirements And Acceptance Criteria

This plan redesigns Citadel's embedded terminal path to reduce typing latency while preserving durable interactive sessions across Citadel daemon and browser restarts. It is a technical plan only; implementation should happen in a later `/implement-task` run.

Acceptance criteria, preserved verbatim:

- cmd+c working
- mouse scroll working
- shift+enter working in all agents
- Long-running PTYs must not stop if Citadel is restarted.
- Terminal typing latency must improve materially versus the current tmux attach bridge.

Additional engineering requirements:

- Keep the current tmux backend available behind a feature flag until plain terminal sessions, agent sessions, background sessions, and status monitoring have equivalent coverage.
- Add benchmark evidence before and after the migration. The benchmark must compare direct `node-pty`, the current tmux attach bridge, the proposed PTY daemon path, and browser typing-latency smoke behavior.
- Avoid product-surface redesign. `apps/web/src/terminal-pane.tsx` should remain a terminal renderer and WebSocket client, not the durability owner.
- Preserve shell-first session behavior unless a reviewed runtime-specific adapter replaces it. Agent sessions should still return to an interactive shell after the foreground runtime exits.
- Make the terminal backend explicit in persisted state so old tmux-backed rows and new PTY-daemon-backed rows can coexist.

## 2. Current Stack Findings

Current hot path:

`browser xterm.js -> Citadel daemon WebSocket -> node-pty running tmux attach-session -> tmux server -> backing pane process`

The main latency concern is that each viewer connection owns a disposable PTY whose foreground process is `tmux attach-session`. Input and output traverse the browser socket, the attach PTY, tmux client/server, and then the real pane. Several special actions also fork separate `tmux` commands on the side.

Investigated files:

- `packages/terminal/src/tmux-pty-bridge.ts`
- `packages/terminal/src/index.ts`
- `packages/terminal/src/tmux.ts`
- `packages/terminal/src/pane-lifecycle.ts`
- `packages/terminal/src/submit-prompt.ts`
- `packages/terminal/src/capture.ts`
- `packages/terminal/src/pipe-pane-log.ts`
- `apps/web/src/terminal-pane.tsx`
- `apps/web/src/terminal-shortcut-bridge.ts`
- `apps/daemon/src/app.ts`
- `apps/daemon/src/terminal-reaper.ts`
- `apps/daemon/src/terminal-routes-helpers.ts`
- `apps/daemon/src/boot-restore.ts`
- `apps/daemon/src/orphan-reaper.ts`
- `packages/operations/src/create-agent-session.ts`
- `packages/operations/src/agent-status.ts`
- `packages/operations/src/status-monitor.ts`
- `apps/daemon/src/status-monitor-wiring.ts`
- `packages/contracts/src/index.ts`
- `packages/db/src/index.ts`
- `packages/db/src/migrate.ts`
- `packages/operations/src/agent-messages.ts`

Current tmux dependency inventory:

| Dependency | Current implementation | PTY-daemon replacement |
| --- | --- | --- |
| Durability | The durable owner is tmux. Citadel daemon/browser restarts only replace the `tmux attach-session` client. | A separate long-running PTY daemon owns `node-pty` instances. Citadel daemon reconnects to a Unix socket and adopts existing sessions. |
| Viewer attach | `attachTmuxPty` spawns `tmux attach-session` through `node-pty`. | Citadel daemon bridges browser WebSocket frames to a PTY-daemon subscription. No nested attach PTY. |
| Status detection | `tmux list-sessions`, `list-panes`, `pane_current_command`, `pane_pid`, capture snapshots, and missing-session debounce. | PTY-daemon session list, output activity timestamps, process tree/lifecycle events, and rendered capture snapshots. |
| Capture/history | `tmux capture-pane`, `captureTranscript`, `captureTmuxSnapshot`, `pipe-pane` logs. | PTY-daemon raw byte replay ring plus rendered screen/scrollback model for capture and reconnect snapshots. |
| Paste/send-keys | `tmux send-keys`, `send-keys -l`, `load-buffer`, `paste-buffer`, bracketed paste wrapping. | Direct bytes to PTY. Bracketed paste remains `ESC[200~...ESC[201~`; Enter/control keys become raw bytes. |
| Resize | Browser sends JSON resize; bridge resizes attach PTY. Other code can call `tmux resize-pane`. | PTY-daemon `resize` message calls `pty.resize(cols, rows)` on the real PTY. |
| Scrollback | Plain browser wheel is intercepted and translated to `tmux copy-mode` scroll controls. Runtime mouse wheels can be forwarded to the app. | Plain terminal wheel should use xterm local scrollback for live viewers; reconnect uses daemon replay/snapshot. Runtime mouse wheels remain raw terminal mouse sequences. Optional server scrollback query can be added for history beyond browser memory. |
| Mouse | `ensureTmuxExtendedKeys` and per-session `setTmuxMouseForSession`; tmux can consume or forward mouse depending on mode. | No tmux mouse layer. xterm mouse protocol bytes go directly to the foreground app. Browser wheel policy stays runtime-aware. |
| Ctrl-C | Browser sends raw `\x03`; user-action endpoint records `ctrl_c`; tmux attach forwards to backing pane. | Browser still sends raw `\x03`; PTY daemon writes it directly to the PTY. User-action endpoint remains for status interpretation. |
| Shift-Enter | Browser intercepts Shift+Enter and sends JSON literal input `"\n"`; bridge calls `sendTmuxLiteralInput`. | Browser keeps the same control message; daemon bridge writes LF bytes directly, with runtime-specific CR/LF override only if tests prove necessary. |
| Session cleanup | `killTmuxSession`, orphan reaper, terminal reaper, legacy sentinel cleanup, pipe-pane log sweep. | `close` tells PTY daemon to terminate the session process tree. Orphan cleanup compares daemon `list` against DB rows. Tmux reaper stays only while tmux fallback exists. |
| Orphan reaping | `terminal-reaper.ts` detaches orphan tmux clients and sweeps logs. `orphan-reaper.ts` kills unreferenced tmux sessions. | No tmux clients. Reap unreferenced PTY-daemon sessions by socket owner and DB state; keep tmux reapers behind fallback gate until removal. |

Important current behaviors to preserve:

- `apps/web/src/terminal-pane.tsx` sends raw terminal input as binary frames and sends JSON control frames for resize, Shift+Enter literal input, line-editing keys, and scroll.
- Cmd+C with no selection sends raw `\x03` and records a user action.
- Cmd+V reads the clipboard and sends text as terminal input.
- Plain terminal wheel events currently request server-side tmux scrollback; Claude Code wheel events are forwarded to the runtime.
- `createAgentSession` creates a shell-first tmux session, launches the runtime through `launchAgentInSession`, then submits the initial prompt through `submitPrompt`.
- `submitPrompt` relies on tmux capture to verify that pasted prompt text reached the pane.
- `status-monitor-wiring` currently depends on tmux activity, pane process, and capture adapters.

## 3. Spec Alignment

Current specs describe tmux as the durability layer. The implementation must update specs before changing behavior.

Required spec/doc updates:

- `specs/B.3-agent-sessions-terminal.md`
  - Replace "terminal sessions are durable tmux sessions" with backend-neutral terminal sessions.
  - Define `terminalBackend = "tmux" | "pty-daemon"` during migration.
  - Define PTY-daemon durability: PTYs survive Citadel daemon/browser restarts because ownership is outside the Citadel daemon process.
  - Preserve special key handling requirements for raw input, Cmd+C, Shift+Enter, paste, resize, alternate screen, and reconnect.
  - Update status/capture language away from `capture-pane` and `pane_current_command`.
- `specs/B.8-ui-performance-quality.md`
  - Add explicit terminal typing-latency budgets and benchmark gates.
  - Keep bounded scrollback and high-output responsiveness requirements.
- `specs/C-technical-stack.md`
  - Move tmux from required terminal durability dependency to migration/fallback dependency.
  - Add `@citadel/pty-daemon` or equivalent package as the terminal ownership process.
- `docs/architecture/citadel-v2-architecture.md`
  - Update shell-backed agent runtime launch path and terminal WebSocket architecture.
- `docs/contributors/v2-engineering-standards.md`
  - Keep the existing raw input, control/meta, paste, resize, long output, alternate screen, reconnect, and isolation verification standard, but make it backend-neutral.
- Operational docs that mention tmux sockets or `citadel-tmux.service` should be updated after the PTY daemon service shape is finalized.

Relevant canonical terms from `specs/A-shared-definitions.md`:

- `Workspace session` remains the user-visible session record.
- `Agent session` remains an agent-backed workspace session.
- `Agent runtime` remains Claude Code, Codex, or another runtime.
- The PTY daemon is an infrastructure owner for the terminal process; it is not an agent runtime.

## 4. Recommended Architecture

Recommend replacing tmux as the foreground workspace-session durability layer with a separate Citadel PTY daemon.

New hot path:

`browser xterm.js -> Citadel daemon WebSocket -> Unix socket client -> PTY daemon -> node-pty -> shell/runtime`

The PTY daemon should be a separate long-running process. It owns `node-pty` instances and remains alive when the Citadel daemon restarts. Citadel daemon startup should connect to the existing PTY daemon, list sessions, and adopt rows by persisted PTY session identity.

Why this is the recommended direction:

- It removes the extra `node-pty tmux attach-session` viewer hop from the input/output path.
- It removes tmux server processing from every keystroke and output frame.
- It avoids side-channel `tmux send-keys`, `capture-pane`, `list-panes`, and `copy-mode` command forks in the normal path.
- It removes the tmux client orphan problem that required `terminal-reaper.ts`.
- It preserves the key durability property, but moves it to a narrower process dedicated to terminal ownership.

Reference architecture:

- Superset public `packages/pty-daemon`: https://github.com/superset-sh/superset/tree/main/packages/pty-daemon
- Superset daemon README: https://github.com/superset-sh/superset/blob/main/packages/pty-daemon/README.md
- Superset protocol messages: https://github.com/superset-sh/superset/blob/main/packages/pty-daemon/src/protocol/messages.ts
- Superset framing: https://github.com/superset-sh/superset/blob/main/packages/pty-daemon/src/protocol/framing.ts
- Superset host-service daemon client: https://github.com/superset-sh/superset/blob/main/packages/host-service/src/terminal/DaemonClient/DaemonClient.ts

Citadel should borrow the performance/durability architecture, not the product surface:

- Standalone PTY-owning process.
- Unix socket local API.
- Versioned handshake.
- Length-prefixed frames with JSON headers and optional binary payloads.
- Raw binary PTY output without base64.
- Multi-subscriber fan-out.
- Bounded replay buffers.
- Backpressure caps that drop slow viewers without killing the underlying PTY.
- Citadel daemon reconnect/adoption after host process restart.

## 5. Process Lifecycle, Protocol, And Contracts

### Process Lifecycle

Introduce a standalone `@citadel/pty-daemon` package or equivalent workspace package. It must not import `apps/daemon`, `packages/operations`, or web code. It may share protocol types through a small protocol module.

Runtime ownership:

- PTY daemon owns the real `node-pty` process and keeps it alive independent of Citadel daemon restarts.
- Citadel daemon owns browser authentication, workspace/session authorization, DB state, and WebSocket bridging.
- Browser owns rendering only.

Startup:

- Citadel daemon boot calls `ensurePtyDaemonRunning`.
- `ensurePtyDaemonRunning` first attempts to connect to the configured socket and perform a versioned handshake.
- If the socket is absent or stale, Citadel daemon starts a detached PTY daemon process for the current Citadel data directory or asks the configured service manager to start it.
- Development mode may use a detached child process keyed by data directory/worktree hash.
- Production install should prefer a user service such as `citadel-pty-daemon.service` so package upgrades and daemon restarts do not accidentally kill active PTYs.

Shutdown:

- Citadel daemon shutdown closes its Unix socket client and browser WebSockets only.
- It must not close PTY daemon sessions unless the user explicitly stops/closes a workspace session.
- `close workspace session` sends a PTY-daemon `close` request that terminates the PTY session process tree.

Socket and auth boundary:

- Socket path should be under a private runtime directory, for example `${CITADEL_DATA_DIR}/run/pty-daemon.sock` or `${XDG_RUNTIME_DIR}/citadel/<data-dir-hash>/pty-daemon.sock`.
- Parent directory permissions must be `0700`.
- Socket permissions must be `0600`.
- The PTY daemon should trust only same-user local clients that can open the socket.
- Browser/API authorization remains in `apps/daemon`; no browser can connect directly to the PTY daemon.
- Do not pass browser auth tokens or session credentials into shell environments.

Crash and restart behavior:

- Citadel daemon restart: PTYs must continue. On boot, Citadel daemon reconnects, calls `list`, adopts existing sessions, and resumes status monitoring.
- Browser restart or WebSocket reconnect: Citadel daemon resubscribes to the PTY session and replays a bounded snapshot/buffer.
- PTY daemon crash: first migration may treat this as a terminal-owner crash that kills owned PTYs. Rows should move to an explicit missing-owner state and offer runtime resume where available.
- PTY daemon binary upgrade without session loss requires file descriptor handoff. This is not required to satisfy "Citadel daemon restart" durability, but should be planned before final tmux removal if zero-loss PTY-daemon upgrades are a product requirement.

File descriptor handoff:

- Stage 1 does not require fd handoff.
- A later stage may add `prepare-upgrade` that starts a successor daemon and passes PTY master fds through inherited stdio or Unix fd passing.
- Handoff must be guarded by integration tests because `node-pty` master fd extraction and adoption can depend on private implementation details.
- Until handoff exists, PTY daemon restart should be an explicit disruptive operation with clear user messaging.

### Unix Socket Protocol

Use a length-prefixed binary-safe frame:

- Frame header: JSON metadata with `type`, `requestId`, `sessionId`, `protocolVersion`, and payload metadata.
- Optional binary payload: raw PTY bytes for input/output/paste.
- Frame size limits: reject oversized headers and payloads.
- Version handshake: client sends `hello`; daemon replies `hello-ack` with protocol version, daemon version, feature flags, and max frame sizes.

Minimum messages:

- `open`: create a PTY session with cwd, env, command, args, cols, rows, kind, workspace/session ids, and metadata.
- `adopt`: attach Citadel daemon to an already-open PTY session by `ptySessionId`.
- `list`: return live PTY sessions with metadata, pid, cwd, command, rows, cols, activity timestamp, and exit state.
- `subscribe`: stream output and optional replay/snapshot for a session.
- `unsubscribe`: stop streaming output to that client.
- `input`: write raw bytes to the PTY.
- `paste`: optional convenience message for bracketed paste bytes; plain `input` is acceptable if the caller constructs the bytes.
- `resize`: resize the real PTY.
- `capture`: return rendered visible screen and bounded scrollback text.
- `process-info`: return process tree and current foreground/runtime inference.
- `signal`: send signals when direct signal delivery is needed; Ctrl+C should still normally be raw `\x03`.
- `close`: terminate the PTY session and process tree.
- `ping`/`pong`: liveness and latency measurement.

Backpressure:

- PTY daemon must continue draining PTY output even if one subscriber is slow.
- Each subscriber gets a bounded outbound buffer. If it exceeds the cap, drop that subscriber connection with an explicit reason.
- Citadel daemon WebSocket bridge should keep its existing close-on-backpressure behavior, but closing a viewer must not close the PTY.
- Input must not be serialized behind a slow output subscriber.

### Replay, Buffer, And Capture Model

Per PTY session, the PTY daemon should maintain:

- A bounded raw byte replay ring for reconnect, default target 1 MiB and configurable.
- A rendered terminal screen and scrollback model for capture/status, default target aligned with the current tmux history expectation and bounded by memory.
- Last output timestamp and byte counters for status and performance diagnostics.
- Exit metadata, including exit code/signal where available.

Use a headless terminal parser for the rendered screen model rather than ad hoc ANSI string parsing. This replaces `tmux capture-pane` and handles alternate screen, cursor movement, wide characters, and TUIs more reliably.

Reconnect flow:

1. Browser opens `/terminal/:sessionId`.
2. Citadel daemon resolves the workspace session row and backend.
3. For `pty-daemon`, Citadel daemon ensures it has a live Unix socket client.
4. Citadel daemon sends `adopt` or verifies the session exists through `list`.
5. Citadel daemon sends `subscribe` with replay/snapshot requested.
6. Browser receives a repaint sequence or replay bytes before live output.

## 6. Schema And API Contracts

Make terminal ownership backend-neutral and additive during migration.

Database migration:

- Current schema version is 19. Add a new migration version, likely 20.
- Add `workspace_sessions.terminal_backend TEXT NOT NULL DEFAULT 'tmux'`.
- Add `workspace_sessions.pty_session_id TEXT`.
- Add `workspace_sessions.pty_owner_socket TEXT`.
- Add `workspace_sessions.pty_owner_pid INTEGER`.
- Add `workspace_sessions.pty_last_seen_at TEXT`.
- Add an index on `pty_session_id` where useful.
- Keep `tmux_session_name`, `tmux_session_id`, and `tmux_socket_name` for compatibility.
- Closing a session must clear or mark backend-specific fields consistently.

Contract updates:

- Extend `WorkspaceSessionBaseSchema` with backend-neutral terminal fields.
- Keep tmux fields optional/deprecated during migration.
- Add typed backend discriminants where callers need different logic:
  - `terminalBackend: "tmux" | "pty-daemon"`
  - `ptySessionId?: string`
  - `ptyOwnerSocket?: string`
  - `ptyOwnerPid?: number`
  - `ptyLastSeenAt?: string`
- Update API responses that currently imply tmux so clients and MCP tools describe "terminal session" rather than "tmux pane".

Operations updates:

- `createTerminalSession` should choose backend from feature flag/config and persist backend identity.
- `createAgentSession` should choose backend from feature flag/config, persist backend identity, and use backend-specific launch/submit/status adapters.
- `agent-messages` should use backend-neutral capture and submit interfaces.
- `status-monitor-wiring` should select tmux or PTY-daemon adapters by `terminal_backend`.

Feature flags/config:

- Introduce `CITADEL_TERMINAL_BACKEND=tmux|pty-daemon`, default `tmux` until migration gates pass.
- Optionally add finer flags:
  - `CITADEL_PTY_DAEMON_TERMINALS=1`
  - `CITADEL_PTY_DAEMON_AGENTS=1`
  - `CITADEL_PTY_DAEMON_BACKGROUND=1`
- Keep the fallback path explicit and observable in logs.

## 7. Implementation Approach And Staged Migration

### Stage 0: Spec And Baseline Benchmarks

1. Update specs/docs listed in Section 3.
2. Add benchmark tooling before changing runtime behavior.
3. Capture baseline numbers for:
   - direct `node-pty`
   - current tmux attach bridge
   - browser typing-latency smoke on current backend
   - high-output/backpressure typing responsiveness on current backend
4. Store benchmark output in a local artifact path ignored by git, or print structured JSON for CI/performance comparisons.

### Stage 1: PTY Daemon Prototype Behind Flag

1. Add standalone PTY daemon package and protocol tests.
2. Add daemon supervisor/client in Citadel daemon.
3. Add session open/list/adopt/subscribe/input/resize/capture/close.
4. Add DB/contract fields.
5. Add feature flag, but keep default backend as tmux.
6. Route only plain terminal sessions through PTY daemon when enabled.
7. Keep all agent sessions on tmux.

Exit criteria:

- Plain shell terminal supports input/output, resize, paste, Ctrl+C, scrollback, reconnect, and daemon restart adoption.
- Benchmarks show proposed path materially improves typing latency versus tmux attach.

### Stage 2: Plain Terminal Sessions

1. Make PTY daemon backend production-usable for `kind = "terminal"` sessions.
2. Update `apps/web/src/terminal-pane.tsx` backend-neutral copy and error text.
3. For PTY-daemon plain terminals, stop translating normal wheel scroll into tmux copy-mode controls. Let xterm handle local scrollback, with daemon replay/snapshot for reconnect.
4. Keep runtime mouse forwarding behavior for applications that enable mouse tracking.
5. Add E2E coverage for daemon restart while a plain shell is running.

Exit criteria:

- Plain terminal sessions can run with PTY daemon by config in normal development.
- Tmux fallback remains available and unchanged.

### Stage 3: Agent Sessions

1. Implement backend-neutral terminal adapter interfaces:
   - `ensureSession`
   - `launchAgent`
   - `submitPrompt`
   - `captureTranscript`
   - `resize`
   - `sendInput`
   - `closeSession`
   - `getStatusObservation`
2. Replace tmux-specific `launchAgentInSession` behavior for PTY-daemon sessions.
3. Preserve shell-first semantics:
   - start shell in the PTY
   - launch runtime as foreground command
   - return to shell after runtime exit
   - print exit hint/resume command where applicable
4. Add a lightweight runtime lifecycle side channel for PTY-daemon agent sessions:
   - shell command wrapper records runtime start and exit
   - side channel updates Citadel status without relying only on process-name polling
   - visible terminal behavior remains natural
5. Replace `submitPrompt` tmux paste/capture verification with direct bracketed paste plus PTY-daemon capture verification.
6. Update status monitor:
   - output activity from PTY-daemon session events
   - capture from rendered screen/scrollback model
   - runtime foreground inference from lifecycle side channel and process tree
   - missing-owner debounce analogous to current tmux missing debounce
7. Update Claude Code and Codex adapters/tests for Shift+Enter, Ctrl+C, mouse scroll, and capture parsing.

Exit criteria:

- Claude Code and Codex agent sessions work through PTY daemon where local runtime/auth allows.
- Automated fake-runtime coverage verifies the same key behaviors when real runtimes are unavailable.
- Tmux remains fallback for agents until the full E2E suite and benchmarks pass.

### Stage 4: Background Sessions And Reapers

1. Decide whether background/scheduled agent sessions migrate to PTY daemon or stay temporarily tmux-backed.
2. If migrating, add backend-neutral fields and adapters for background session records.
3. Replace `boot-restore` tmux logic with backend-aware restore:
   - PTY daemon `list` and DB row reconciliation
   - tmux list fallback for legacy sessions
4. Replace `orphan-reaper` logic for PTY-daemon sessions:
   - close unreferenced PTY-daemon sessions owned by the current data directory
   - never kill sessions for another Citadel data directory/socket
5. Keep `terminal-reaper.ts` and pipe-pane log sweeping only while tmux fallback exists.

Exit criteria:

- No new tmux sessions are required for foreground terminal or agent sessions.
- Background behavior is either migrated or explicitly documented as the last tmux holdout.

### Stage 5: Tmux Removal Or Compatibility Window

1. Make PTY daemon default after benchmark and E2E gates pass.
2. Keep tmux backend as a rollback flag for at least one release window.
3. Add explicit migration messaging for existing tmux-backed live sessions.
4. Remove tmux fields only after no supported code path needs them.
5. Consider PTY-daemon fd handoff before declaring daemon binary upgrades non-disruptive.

Exit criteria:

- Tmux is not needed for new Citadel terminal or agent sessions.
- Remaining tmux code is deleted only when background sessions and operational docs no longer depend on it.

### Legacy Tmux Session Migration

Live tmux panes should not be automatically "ported" into PTY-daemon sessions.

Reason:

- The running shell, foreground process, job table, controlling terminal, and TUI state are attached to the PTY that tmux owns.
- There is no supported way to move that live process tree from tmux's PTY into a different PTY-daemon-owned PTY without disrupting the process.
- We can capture scrollback, cwd, pane command, runtime metadata, and resume commands, but not faithfully transplant in-memory shell variables, unflushed shell history, shell jobs, foreground processes, or application-internal state.

Migration policy:

1. Existing tmux-backed `workspace_sessions` remain `terminal_backend = "tmux"` until the user closes them or explicitly migrates them.
2. Switching the default backend to `pty-daemon` affects new sessions only.
3. Citadel keeps the tmux WebSocket path, tmux reapers, and tmux status adapters for referenced legacy sessions during the compatibility window.
4. Boot restore continues to list tmux sessions by workspace socket and match them to DB rows.
5. Referenced live tmux sessions must not be killed by orphan cleanup.

Add a pre-migration snapshot step before making PTY daemon default:

- For each live tmux-backed workspace session, capture:
  - `workspace_session.id`
  - kind, title, target, runtime, and runtime session id
  - tmux session name/socket
  - cwd from tmux pane metadata where available
  - current foreground command and pid
  - visible pane text and bounded scrollback through `capture-pane`
  - last known status and activity timestamp
  - runtime resume command where available
- Store this as a restore record or derive it from existing session rows plus a bounded captured transcript.

Restore UX:

- Show legacy tmux sessions as "legacy tmux" sessions while their tmux pane is still alive.
- If the user opens one, attach through the old tmux backend.
- If tmux is no longer alive, show the previous session entry with captured transcript, cwd, target metadata, and an explicit "resume in new PTY" action.
- "Resume in new PTY" creates a fresh PTY-daemon session in the same workspace cwd and runs the runtime-specific resume command when available.
- For plain shell sessions without a runtime resume command, create a fresh shell in the same cwd and show the captured transcript as previous context; the user resumes manually.

Tests for legacy migration:

- Existing live tmux session remains attachable after `CITADEL_TERMINAL_BACKEND=pty-daemon` is enabled.
- New sessions use PTY daemon while old tmux sessions keep using tmux.
- Orphan reaper does not kill referenced legacy tmux sessions.
- Missing tmux session displays a restore entry with captured transcript and cwd.
- Agent restore creates a fresh PTY-daemon session and uses the runtime resume command where available.
- Plain terminal restore creates a fresh PTY-daemon shell in the previous cwd and does not pretend the old shell state was preserved.

## 8. Alternatives Considered

### Keep Tmux And Optimize

Possible optimizations:

- Reduce status monitor polling and `capture-pane` frequency.
- Avoid some side-channel `tmux send-keys` calls.
- Tune tmux history and mouse options.
- Experiment with tmux control mode.

Reason not recommended:

- The attach bridge still keeps `node-pty -> tmux attach-session -> tmux server -> backing pane` in the keystroke path.
- Tmux remains a global per-workspace server with client lifecycle and memory risks.
- Several behaviors still require forked `tmux` commands.
- Prior control-mode-style approaches are risky for native TUI, mouse, alternate screen, and exact byte semantics.

If the PTY daemon prototype fails to beat tmux benchmarks, revisit this alternative with exact latency traces and flamegraphs. Otherwise it is a fallback, not the target architecture.

### Own `node-pty` In Citadel Daemon

Reason not recommended:

- It improves latency but fails the durability criterion. Long-running PTYs would die when Citadel daemon restarts.

### Use Tmux Only As A Hidden Process Owner Without Attach

Reason not recommended:

- It keeps tmux as the terminal semantics layer and requires either control mode or complex pipe/control orchestration.
- It does not remove enough latency and compatibility risk to justify the complexity.

### Require FD Handoff In The First PTY Daemon Release

Reason not recommended for Stage 1:

- It expands the first migration beyond the stated Citadel daemon restart requirement.
- It likely depends on `node-pty` internals or platform-specific fd passing.
- It should be implemented only after the basic PTY-daemon path is benchmarked and stable.

## 9. QA, Tests, And Verification

### Benchmark Plan

Add `scripts/dev/terminal-latency-benchmark.ts` or equivalent and include it in `make performance`.

Benchmarks:

1. Direct `node-pty`
   - Spawn a shell or raw echo helper through `node-pty`.
   - Write single bytes and lines.
   - Measure input write to matching output event.
   - This is the lower-bound local baseline.
2. Current tmux attach bridge
   - Create a tmux-backed session.
   - Connect through the existing WebSocket path.
   - Measure key echo latency and output throughput.
3. Proposed PTY daemon path
   - Create a PTY-daemon-backed session.
   - Connect through the Citadel daemon WebSocket bridge.
   - Measure the same metrics as the tmux path.
4. Browser typing-latency smoke
   - Use Playwright to focus the terminal and type known characters into `cat` or a raw echo helper.
   - Measure keydown-to-render or input-to-output using browser `performance.mark` plus terminal write/render observation.
   - Repeat while a high-output command is streaming.

Metrics:

- p50, p95, and max key echo latency.
- p50 and p95 browser typing latency.
- Output throughput in bytes/sec.
- Input latency while output is streaming.
- WebSocket/Unix socket backpressure close count.
- Reconnect time and replay bytes.
- Citadel daemon event-loop delay during terminal output.

Initial performance gate:

- PTY daemon path p95 key echo latency should be at least 40% lower than the current tmux attach bridge in the same environment.
- PTY daemon path should be no worse than 2x direct `node-pty` p95 key echo latency.
- Browser typing-latency smoke should remain under 50 ms p95 when idle and under 100 ms p95 during high output on the local benchmark machine.
- If those budgets are not met, implementation must capture traces before expanding migration beyond Stage 1.

### Unit Tests

Add or update Vitest coverage:

- `packages/pty-daemon/src/protocol/*.test.ts`
  - split frame reads
  - binary payloads
  - max header/payload enforcement
  - version handshake mismatch
  - malformed JSON rejection
- `packages/pty-daemon/src/session-store.test.ts`
  - open/list/adopt lifecycle
  - bounded replay ring
  - rendered capture snapshot
  - multi-subscriber fan-out
  - slow subscriber backpressure close
  - close semantics and exit metadata
- `packages/pty-daemon/src/pty.test.ts`
  - raw input bytes, including `\x03`
  - non-UTF-8 bytes are not corrupted
  - resize validation and clamping
  - process tree cleanup
  - output continues when one subscriber disconnects
- `packages/terminal/src/pty-daemon-client.test.ts`
  - connect/list/open/adopt/subscribe/input/resize/capture/close
  - reconnect after Unix socket drop
  - replay/snapshot ordering
  - request timeout handling
- `packages/terminal/src/index.test.ts`
  - keep existing tmux tests for fallback
  - add backend-neutral adapter tests for input, paste, resize, capture, and close
- `packages/operations/src/create-agent-session.test.ts`
  - tmux remains default
  - PTY-daemon flag persists `terminal_backend = "pty-daemon"`
  - shell cwd, env, target metadata, and runtime args are preserved
- `packages/operations/src/agent-messages.test.ts`
  - prompt submission uses direct bracketed paste for PTY daemon
  - submit refuses missing PTY sessions with actionable error
  - capture verification works without `tmux capture-pane`
- `packages/operations/src/agent-status.test.ts`
  - PTY-daemon output activity affects status
  - missing PTY owner debounce
  - recent Ctrl+C user action suppresses false unexpected-exit messaging
  - Claude Code and Codex capture adapters still classify busy/idle where possible
- `apps/web/src/terminal-pane.test.ts`
  - cmd+c working
  - mouse scroll working
  - shift+enter working in all agents
  - PTY-daemon backend does not show tmux-specific error copy
  - plain terminal wheel uses local scrollback policy for PTY-daemon sessions
  - runtime mouse wheel forwarding still works
- `apps/web/src/terminal-pane-resize.test.ts`
  - resize remains coalesced and de-duped
- `packages/db` and `packages/contracts`
  - schema migration version 20
  - contract parsing for old tmux rows and new PTY-daemon rows

### E2E Tests

Add `e2e/terminal-pty-daemon.spec.ts` or equivalent:

- Plain PTY-daemon terminal:
  - create terminal session
  - type `printf` command
  - see output
  - resize terminal
  - scroll with mouse wheel
- Ctrl+C:
  - run `sleep 30`
  - send Cmd+C/Ctrl+C through terminal
  - verify foreground command exits and shell remains usable
- Shift+Enter:
  - use a fake multiline agent runtime to verify LF reaches runtime without submission normalization
  - run opt-in real Claude Code and Codex smoke when credentials/runtime are available
- Mouse scroll:
  - verify plain scrollback wheel behavior
  - verify fake mouse-aware alternate-screen runtime receives wheel/mouse sequences
  - run opt-in Claude Code and Codex smoke where possible
- Citadel daemon restart durability:
  - start long-running command in PTY-daemon session
  - restart Citadel daemon
  - reconnect browser/WebSocket
  - verify same PTY process is alive and still receives input/output
- High-output/backpressure responsiveness:
  - stream large output
  - type while output is streaming
  - verify p95 typing latency budget
  - simulate slow viewer and verify viewer disconnect does not kill PTY
- Cross-session isolation:
  - create two PTY-daemon sessions
  - verify output/input do not cross streams
- Tmux fallback:
  - run a smoke test with `CITADEL_TERMINAL_BACKEND=tmux` until fallback is removed

Real Claude Code and Codex coverage:

- Automated CI should use fake runtimes for deterministic coverage.
- Add opt-in local smoke tests for real Claude Code and Codex when binaries and credentials are present.
- The acceptance criterion "shift+enter working in all agents" should be gated by fake-runtime automation plus manual/opt-in runtime verification before rollout.

### Exact Verification Commands

Targeted during implementation:

- `pnpm test -- packages/pty-daemon`
- `pnpm test -- packages/terminal`
- `pnpm test -- packages/operations`
- `pnpm test -- packages/contracts`
- `pnpm test -- packages/db`
- `pnpm test -- apps/web`
- `tsx scripts/dev/terminal-latency-benchmark.ts --backend=direct-node-pty`
- `tsx scripts/dev/terminal-latency-benchmark.ts --backend=tmux-attach`
- `tsx scripts/dev/terminal-latency-benchmark.ts --backend=pty-daemon`
- `pnpm playwright test e2e/terminal-pty-daemon.spec.ts`

Repository-level gates:

- `make check`
- `make e2e`
- `make smoke`
- `make performance`

### Manual Verification Checklist

- Create a plain PTY-daemon terminal and type quickly in shell.
- Run a high-output command and type while output is still streaming.
- Verify Cmd+C interrupts a foreground command but does not close the terminal.
- Verify mouse scroll in normal scrollback.
- Verify mouse scroll in a mouse-aware TUI or Claude Code alternate-screen view.
- Verify Shift+Enter in Claude Code.
- Verify Shift+Enter in Codex.
- Restart Citadel daemon while `sleep` or a long-running command is active; reconnect and confirm the same command survives.
- Close a session and confirm the PTY process tree is gone.
- Start with tmux fallback and confirm legacy sessions still work.

## 10. Risks And Rollback

Risks:

- PTY-daemon crash kills sessions until fd handoff or equivalent adoption is implemented.
- Rendered capture parity with `tmux capture-pane` can be difficult for alternate-screen TUIs and wide-character layouts.
- Agent status detection may regress if process tree inference is weaker than tmux `pane_current_command`.
- Local scrollback behavior differs from tmux copy-mode; users may notice differences after reconnect or very long output.
- Memory use can grow if per-session rendered scrollback is too large.
- Real Claude Code/Codex behavior can differ from fake-runtime tests, especially for Shift+Enter and mouse handling.
- Unix socket permissions must be correct, or local privilege boundaries are weaker than expected.

Mitigations:

- Keep tmux as default until Stage 2 and Stage 3 gates pass.
- Keep `CITADEL_TERMINAL_BACKEND=tmux` rollback during at least one release window.
- Use additive schema fields and avoid dropping tmux columns during migration.
- Use fake-runtime tests for deterministic automation and opt-in real-runtime smoke before rollout.
- Add benchmark budgets before enabling PTY daemon broadly.
- Add explicit missing-owner states and user-facing recovery actions for PTY-daemon crash.
- Cap raw replay and rendered scrollback memory; add stress tests with many sessions.

Rollback strategy:

- Config rollback: set `CITADEL_TERMINAL_BACKEND=tmux`.
- Per-session compatibility: existing tmux-backed rows continue to use tmux adapters.
- If PTY-daemon session adoption fails, do not delete the DB row automatically. Mark the terminal owner missing and offer restart/resume.
- Keep tmux reapers and tmux tests until tmux backend is intentionally removed.
- Do not remove tmux package dependencies until no active code path or spec depends on them.

## 11. Implementation Task List

1. Update specs/docs for backend-neutral terminal ownership and PTY-daemon durability.
2. Add benchmark tooling and capture current baseline.
3. Add standalone PTY daemon package, protocol, framing, session store, and tests.
4. Add PTY daemon supervisor/client and Unix socket config in Citadel daemon.
5. Add additive DB migration and contract fields.
6. Add backend-neutral terminal adapter interfaces in `packages/terminal`.
7. Implement PTY-daemon adapter for plain terminal sessions behind feature flag.
8. Bridge `/terminal/:sessionId` to PTY daemon when session backend is `pty-daemon`.
9. Update web terminal behavior and copy to be backend-neutral.
10. Add plain terminal E2E and benchmark gates.
11. Implement PTY-daemon agent launch, prompt submit, capture, and status adapters.
12. Add Claude Code, Codex, and fake-runtime tests for Ctrl+C, Shift+Enter, mouse scroll, reconnect, and high output.
13. Update boot restore, orphan reaping, and status monitor wiring to be backend-aware.
14. Decide and implement background/scheduled agent migration or document temporary tmux holdout.
15. Make PTY daemon default only after all gates pass.
16. Keep tmux rollback for one release window, then remove tmux dependencies in a separate reviewed task.
