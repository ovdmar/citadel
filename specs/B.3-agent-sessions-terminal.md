# [B.3] Agent Sessions And Terminal

**Status:** Draft

> Workspace sessions are durable workspace tabs. Agent sessions are collaborators; terminal sessions are plain shells.

## Agent Sessions

[~] 1. A workspace can have multiple agent sessions across Home and checkout execution targets.
[ ] 2. The session list shows target type, checkout when present, kind, runtime, role, action, managed flag, parent session, plan version, status, task/title, started time, last activity, and attention state.
[ ] 3. The operator can start a new session in a valid execution target.
[ ] 4. The operator can choose the runtime adapter when starting a session.
[ ] 5. The operator can provide an initial prompt/task when starting a session.
[ ] 6. The operator can resume or reconnect to an existing session.
[ ] 7. The operator can stop a live session with confirmation. Closing a tab kills tmux but retains durable session history and runtime resume metadata.
[~] 8. Session status uses a canonical enum: `starting`, `running`, `waiting_for_input`, `rate_limited`, `usage_limited`, `idle`, `stopped`, `failed`, `unknown`. Semantics for `kind: "agent"`: `starting` = TUI initializing; `running` = agent foreground process is the runtime binary (claude/codex/etc.) AND/OR in-turn background work still in flight; `waiting_for_input` / `rate_limited` / `usage_limited` = runtime-adapter-derived from pane content; `idle` = the pane's foreground command is a shell binary (agent not currently running, covering both "agent finished cleanly" and "operator Ctrl+C'd the agent"); `stopped` = operator explicitly stopped the session via the cockpit Stop button; `failed` is reserved for `launch_failed` reducer signals only; `unknown` = tmux unreachable. Semantics for `kind: "terminal"`: the session is `running` while its tmux session exists and `stopped` when the operator stops it; a shell foreground process is normal. Status is persisted in `workspace_sessions` along with `kind`, nullable `runtime_id`, `last_status_at`, `last_output_at`, `ended_at`, `exit_code`, `status_reason`, and `status_reason_at`. Because the shell-first pane lifecycle makes the agent a child of the terminal profile shell (not the pane PID), the daemon cannot reliably capture an agent's exit code when it exits mid-session; an agent that crashes mid-session shows `idle` with `status_reason: 'idle_after_unexpected_exit'` (surfaced as a red pulse for 30 minutes) rather than `failed`.

Rate-limit recovery is automatic: Claude Code usage-limit banners persist `pane:usage_limited:reset=<iso>` in `status_reason`; the daemon scans for these reset-bound sessions and, on first detection, creates one internal one-shot background scheduled agent at `reset+60s`. When it fires, that background run calls the daemon's internal resume endpoint, which re-reads all currently `rate_limited` / `usage_limited` sessions and submits a system `resume` message to every session whose reset is due. Transient server `rate_limited` sessions without a reset continue through the bounded per-session auto-resume backoff.
[~] 14. Workspace cards, session tabs, and the navigator aggregate display use one four-tone lifecycle taxonomy. Grey (`cit-pulse-idle`) means never started only. Yellow (`cit-pulse-run`) means actively starting/running. Green pulsing (`cit-pulse-done`) means the agent has transitioned from running to done and is awaiting review/human action with no PR conflict or failing CI. Red pulsing (`cit-pulse-bad`) means attention is required: `waiting_for_input`, `rate_limited`, `usage_limited`, `failed`, bad exits, crash/unknown attention reasons (`idle_after_unexpected_exit`, `tmux_missing`, `sentinel_missing_tmux_alive`, `migrated_from_orphaned`), PR conflicts, or failing CI. The shared predicates are `deriveAgentLifecycleTone` / `deriveWorkspaceLifecycleTone` in `@citadel/core`; UI code only maps those tones to pulse classes.
[ ] 9. Session state survives browser refresh/reconnect.
[ ] 10. Switching sessions preserves useful terminal context.
[ ] 11. Sessions surface in the center column as a target-scoped tab strip with a plus button that offers valid specialized roles/actions, freestyle agent runtimes, and Terminal.
[ ] 12. Session tab titles are editable inline. The default title is the role/action display name, agent runtime display name for freestyle agent sessions, and terminal profile display name for terminal sessions.
[ ] 13. Structured workspaces launch PM/manager through explicit lifecycle flows, not by auto-opening a default freestyle agent on first workspace open.
[~] 14. Agent sessions persist `runtime_session_id`, role/action metadata, target scope, checkout id, parent session, managed flag, prompt snapshot, launch warnings, plan version, artifact links, `closed_at`, and restore information.
[ ] 15. Managed sessions launched by the manager persist `manager_action_id` and idempotency key links so crash reconciliation can relink existing side effects instead of relaunching.
[ ] 16. Managed agent-facing tool access is derived from server-held session context or an opaque per-session authority record; request bodies cannot claim `actor: "human"`, session ownership, manager action ownership, or waiver authority.
[ ] 17. Raw authority tokens are never exposed in shell-visible terminal environments, `/api/state`, SSE payloads, logs, prompt snapshots, transcripts, terminal metadata, review artifacts, manager events, or activity.

## Agent Runtimes And Launch Profiles

[ ] 1. Agent runtimes expose capabilities.
[~] 2. Capability examples include start, resume, prompt injection, transcript discovery, model discovery, default model discovery, effort/reasoning support, fast mode support, context/max-context support, status detection, and plan/review modes. Status detection is implemented as a per-runtime adapter that analyzes pane content on each monitor tick and emits canonical status observations (`running` / `idle` / `waiting_for_input` / null). Adapter regexes are anchored to the bottom of the visible pane (mode-line / status-line region) and matched against committed fixture files; UI rendering changes in a runtime trigger fixture-update-and-regex-update as a single PR. Lifecycle signals (`tmux_missing`, `exited_clean`, `exited_failed`) come from the deterministic process layer (tmux session existence, bash wrapper's `.live` / `.exit` sentinel files), runtime-agnostic.
[ ] 3. Runtime health is visible before session start.
[ ] 4. Unavailable runtime adapters explain the missing binary, auth, config, or health issue.
[ ] 5. Agent runtime configuration lives in `config.agentRuntimes` and Citadel settings/config.
[ ] 6. Settings uses the operator-facing name **Agents**, not Runtimes. It distinguishes platform runtimes (`claude-code`, `codex`, `cursor-agent`, `pi`) from Citadel role/action templates. Custom role CRUD is out of scope for v1.
[ ] 7. Plain shell is configured by the singular terminal profile and is never an agent runtime. It never appears in agent counts or MCP agent-session listings, but it is a first-class option when starting a workspace session from the cockpit.
[ ] 8. Role/action templates store semantic launch settings. At launch, Citadel resolves runtime capabilities, validates the configured model/options, falls back to runtime defaults when necessary, drops unsupported options, records warnings, and builds runtime-specific argv centrally.

## Terminal

[~] 1. Terminal output renders real data.
[ ] 2. Terminal layout has stable bounds inside the cockpit.
[~] 3. Terminal sessions are backed by durable tmux sessions. Interactive agent panes are sharded by workspace-specific tmux socket names recorded on `agent_sessions.tmux_socket_name`; persisted legacy rows are backfilled to those workspace sockets on migration, while any still-running pre-migration panes remain on the old socket until they are relaunched/restored. This contains a tmux server crash to the sessions on that workspace socket instead of making every Citadel agent pane share one crash domain.
[~] 4. The browser terminal renderer is Citadel's in-process xterm.js cockpit pane connected to the daemon WebSocket at `/terminal/<sessionId>`. The daemon bridges that socket to the durable tmux session by spawning a disposable node-pty `tmux attach-session` viewer, so interactive TUIs receive real PTY semantics while normal workspace/session switching avoids external renderer processes. Modified keys that tmux attach normalizes incorrectly, such as Shift+Enter for multiline agent input and client-native line editing shortcuts like Cmd+Backspace, are captured before xterm can emit normalized bytes and sent as explicit WebSocket control messages that inject literal input or pane keys into the pane.
[~] 5. Terminal input/output rides the daemon-owned WebSocket bridge and never goes to a 3rd-party host. Terminal bytes move as binary WebSocket frames; JSON is reserved for control messages such as resize, key/input injection, and error/exit state.
[ ] 6. App state, operations, events, and provider health use REST/SSE.
[~] 7. Citadel owns session creation, metadata, workspace/runtime association, per-workspace tmux socket selection, tmux lifecycle, terminal permissions, WebSocket routing, PTY attach cleanup, and tmux-client orphan reaping.
[~] 8. Long terminal buffers stay responsive through bounded tmux scrollback and xterm.js' browser-side renderer. Reconnect reattaches to the same tmux session and resumes from tmux's current visible state plus live PTY output; mounted browser panes keep their own bounded xterm scrollback. The cockpit xterm renderer is opaque over the Stage surface, and active-pane fit/resize work is coalesced and de-duped per WebSocket attach so browser compositor refreshes do not expose decorative underlayers or resize the PTY unnecessarily.
[~] 9. At runtime the daemon periodically detaches orphaned tmux clients (viewer state left behind by closed/crashed cockpit panels) and rotates the per-session pipe-pane log files in `${TMPDIR}/citadel-pty/`, so a long-running deployment does not accumulate per-client memory in the shared tmux server or unbounded log files on disk. The underlying workspace session and any process running inside it are never affected — only the disconnected viewer. The pane process is the configured terminal profile (default `bash -l`); for agent sessions, the agent runs as a child via `tmux send-keys`, so Ctrl+C inside the embedded terminal kills the agent without ending the pane.
[~] 10. Terminal pane state explains connecting, attached, reconnecting, error, and closed states. On transport disconnects after a daemon/Citadel restart (`terminal_disconnected`, `terminal_socket_error`), the cockpit auto-retries the WebSocket attach up to three times with a 5-second backoff while keeping manual Retry available. When the WebSocket bridge cannot attach (`session_not_found`, `tmux_session_missing`, `terminal_unavailable`, `spawn_failed`) the cockpit shows an inline error with the code, detail, settings/runbook links, and a Retry button — never a blank black pane.
[~] 11. The Citadel daemon exposes the xterm/WebSocket gateway at `/terminal/:sessionId` for the cockpit, tooling, and tests.
[~] 12. Trade-offs of the xterm/WebSocket renderer are accepted: Citadel owns a small PTY bridge, but uses xterm.js, node-pty, and tmux attach rather than a from-scratch terminal emulator. The benefit is native terminal semantics for interactive CLIs plus low RAM because normal navigation no longer needs one external renderer process and iframe per active session.
[~] 13. When an agent process exits back to the shell, the pane prints a Citadel hint with the real runtime session id when available: `[citadel] Agent exited. Run any command, or restart the agent (e.g. \`claude resume <real-session-id>\`).` The literal `<sessionId>` placeholder is never shown. If the runtime id is not known at launch time, Claude panes fall back to the latest transcript id in the workspace's `~/.claude/projects/.../*.jsonl` directory, then to an interactive `claude resume` hint.
[~] 14. Session creation, restore, close/kill, global shortcuts, and reconnect flows preserve execution target metadata and cwd. Any target-aware launch into a checkout must resolve to that checkout path, not the workspace Home root.
[ ] 15. Voice dictation into a focused terminal pane uses the same daemon-owned WebSocket terminal input path as keyboard input. The terminal pane forwards the voice shortcut to the Shell-level voice provider, then exposes a session-scoped handle that writes the final transcript to the PTY. With auto-submit enabled, the handle appends exactly one keyboard-Enter-equivalent sequence; with auto-submit disabled, it writes only the dictated literal text. Voice dictation never routes terminal input through the agent message API.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

---

keywords: workspace sessions, agent sessions, agent runtimes, terminal profile, terminal, tmux, xterm, websocket, reconnect, native terminal
