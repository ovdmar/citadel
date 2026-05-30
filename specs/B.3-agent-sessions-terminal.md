# [B.3] Agent Sessions And Terminal

**Status:** Draft

> Agent sessions are durable workspace collaborators. Terminal is one renderer over those sessions.

## Agent Sessions

[~] 1. A workspace can have multiple agent sessions.
[ ] 2. The session list shows runtime, status, task/title, started time, last activity, and attention state.
[ ] 3. The operator can start a new session in a workspace.
[ ] 4. The operator can choose the runtime adapter when starting a session.
[ ] 5. The operator can provide an initial prompt/task when starting a session.
[ ] 6. The operator can resume or reconnect to an existing session.
[ ] 7. The operator can stop a session with confirmation.
[~] 8. Session status uses a canonical enum: `starting`, `running`, `waiting_for_input`, `rate_limited`, `usage_limited`, `idle`, `stopped`, `failed`, `unknown`. Semantics: `starting` = TUI initializing; `running` = agent foreground process is the runtime binary (claude/codex/etc.) AND/OR in-turn background work still in flight; `waiting_for_input` / `rate_limited` / `usage_limited` = runtime-adapter-derived from pane content; `idle` = the pane's foreground command is a shell binary (agent not currently running — covers both "agent finished cleanly" and "operator Ctrl+C'd the agent"); `stopped` = operator explicitly stopped the session via the cockpit Stop button (kills the tmux session); `failed` is RESERVED for `launch_failed` reducer signals only (the initial `tmux new-session` itself errored before the pane was alive) — historical rows may still display `failed` from the previous architecture; `unknown` = tmux unreachable. Status is persisted in `agent_sessions` along with `last_status_at`, `last_output_at`, `ended_at`, `exit_code`, `status_reason`, and `status_reason_at`. Because the shell-first pane lifecycle makes the agent a child of bash (not the pane PID), the daemon cannot reliably capture an agent's exit code when it exits mid-session — operator-visible signal loss versus the legacy wrapper architecture: an agent that crashes mid-session shows `idle` with `status_reason: 'idle_after_unexpected_exit'` (which the cockpit's attention predicate surfaces as a red pulse for 30 minutes) rather than `failed`; the operator reads the pane content to see what happened.
[~] 14. Workspace cards display a small pulsing status icon before the workspace name, aggregated across the workspace's agent sessions. The icon reuses the shared `cit-pulse` / `cit-pulse-sm` chrome already used by the bottom-bar "auto mode" pill, the navigator "Running" stat, and the inspector deploy/runtime pulses. Tones: `cit-pulse-run` (warn/yellow with ripple) when at least one agent is `starting` or `running`; `cit-pulse-bad` (red) when at least one is `waiting_for_input`, `failed`, or `unknown` with a tmux-gone reason (`tmux_missing`, `sentinel_missing_tmux_alive`, or `migrated_from_orphaned`); `cit-pulse-idle` (grey, static) otherwise. Priority bad > run > idle. The aggregation predicate is implemented as `deriveWorkspaceAgentTone` in `apps/web/src/workspace-card.tsx`; the attention condition delegates to `sessionNeedsAttention` in `@citadel/core` so all readiness derivations share the same definition.
[ ] 9. Session state survives browser refresh/reconnect.
[ ] 10. Switching sessions preserves useful terminal context.
[ ] 11. Sessions surface in the center column as a tab strip with a plus button that offers `Terminal` plus every healthy agent runtime.
[ ] 12. Session tab titles are editable inline. The default title is the runtime display name (`Terminal` for the shell runtime).
[ ] 13. When a workspace opens for the first time and a default agent runtime is healthy, Citadel opens that agent session automatically.

## Runtime Adapters

[ ] 1. Runtime adapters expose capabilities.
[~] 2. Capability examples include start, resume, prompt injection, transcript discovery, model selection, status detection, and plan/review modes. Status detection is implemented as a per-runtime adapter that analyzes pane content on each monitor tick and emits canonical status observations (`running` / `idle` / `waiting_for_input` / null). Adapter regexes are anchored to the bottom of the visible pane (mode-line / status-line region) and matched against committed fixture files; UI rendering changes in a runtime trigger fixture-update-and-regex-update as a single PR. Lifecycle signals (`tmux_missing`, `exited_clean`, `exited_failed`) come from the deterministic process layer (tmux session existence, bash wrapper's `.live` / `.exit` sentinel files), runtime-agnostic.
[ ] 3. Runtime health is visible before session start.
[ ] 4. Unavailable runtime adapters explain the missing binary, auth, config, or health issue.
[ ] 5. Agent adapter configuration lives in Citadel settings/config.
[ ] 6. Settings uses the operator-facing name **Agents**, not Runtimes. It distinguishes **platform agents** (shipped with Citadel: `claude-code`, `cursor-agent`, `pi`, and the built-in `shell`/Plain Terminal) from operator-defined **custom agents**. The platform group exists even when the binary is missing — Citadel surfaces it as `unavailable` and explains how to install it. Custom agents can be added from the Agents settings panel without using Advanced.
[ ] 7. The built-in shell runtime (`shell`) is treated as a Plain Terminal, not an agent runtime — it never appears in agent counts, but it is a first-class option when starting a session.

## Terminal

[~] 1. Terminal output renders real data.
[ ] 2. Terminal layout has stable bounds inside the cockpit.
[~] 3. Terminal sessions are backed by durable tmux sessions. Interactive agent panes are sharded by workspace-specific tmux socket names recorded on `agent_sessions.tmux_socket_name`; persisted legacy rows are backfilled to those workspace sockets on migration, while any still-running pre-migration panes remain on the old socket until they are relaunched/restored. This contains a tmux server crash to the sessions on that workspace socket instead of making every Citadel agent pane share one crash domain.
[~] 4. The browser terminal renderer is Citadel's in-process xterm.js cockpit pane connected to the daemon WebSocket at `/terminal/<sessionId>`. The daemon bridges that socket to the durable tmux session by spawning a disposable node-pty `tmux attach-session` viewer, so interactive TUIs receive real PTY semantics while normal workspace/session switching avoids external renderer processes. Modified keys that tmux attach normalizes incorrectly, such as Shift+Enter for multiline agent input, are sent as explicit WebSocket control messages and injected into the pane as literal input.
[~] 5. Terminal input/output rides the daemon-owned WebSocket bridge and never goes to a 3rd-party host. Terminal bytes move as binary WebSocket frames; JSON is reserved for control messages such as resize and error/exit state.
[ ] 6. App state, operations, events, and provider health use REST/SSE.
[~] 7. Citadel owns session creation, metadata, workspace/runtime association, per-workspace tmux socket selection, tmux lifecycle, terminal permissions, WebSocket routing, PTY attach cleanup, and tmux-client orphan reaping.
[~] 8. Long terminal buffers stay responsive through bounded tmux scrollback and xterm.js' browser-side renderer. Reconnect reattaches to the same tmux session and resumes from tmux's current visible state plus live PTY output; mounted browser panes keep their own bounded xterm scrollback.
[~] 9. At runtime the daemon periodically detaches orphaned tmux clients (viewer state left behind by closed/crashed cockpit panels) and rotates the per-session pipe-pane log files in `${TMPDIR}/citadel-pty/`, so a long-running deployment does not accumulate per-client memory in the shared tmux server or unbounded log files on disk. The underlying agent session and any process running inside it are never affected — only the disconnected viewer. The pane process is the operator's login shell (`bash -l`); the agent runs as a child via `tmux send-keys`, so Ctrl+C inside the embedded terminal kills the agent without ending the pane.
[~] 10. Terminal pane state explains connecting, attached, reconnecting, error, and closed states. When the WebSocket bridge cannot attach (`session_not_found`, `tmux_session_missing`, `terminal_unavailable`, `spawn_failed`) the cockpit shows an inline error with the code, detail, settings/runbook links, and a Retry button — never a blank black pane.
[~] 11. The Citadel daemon exposes the xterm/WebSocket gateway at `/terminal/:sessionId` for the cockpit, tooling, and tests.
[~] 12. Trade-offs of the xterm/WebSocket renderer are accepted: Citadel owns a small PTY bridge, but uses xterm.js, node-pty, and tmux attach rather than a from-scratch terminal emulator. The benefit is native terminal semantics for interactive CLIs plus low RAM because normal navigation no longer needs one external renderer process and iframe per active session.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

---

keywords: agent sessions, runtime adapters, terminal, tmux, xterm, websocket, reconnect, native terminal
