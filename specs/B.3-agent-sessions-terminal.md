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
[~] 14. Workspace cards, session tabs, and the navigator aggregate display use one four-tone lifecycle taxonomy. Grey (`cit-pulse-idle`) means never started only. Yellow (`cit-pulse-run`) means actively starting/running. Green pulsing (`cit-pulse-done`) means the agent has transitioned from running to done and is awaiting review/human action with no PR conflict or failing CI. Red pulsing (`cit-pulse-bad`) means attention is required: `waiting_for_input`, `rate_limited`, `usage_limited`, `failed`, bad exits, crash/unknown attention reasons (`idle_after_unexpected_exit`, `tmux_missing`, `sentinel_missing_tmux_alive`, `migrated_from_orphaned`), PR conflicts, or failing CI. The shared predicates are `deriveAgentLifecycleTone` / `deriveWorkspaceLifecycleTone` in `@citadel/core`; UI code only maps those tones to pulse classes.
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
[ ] 3. Terminal sessions are backed by durable tmux sessions.
[ ] 4. The primary browser terminal renderer is `ttyd` served through a Citadel-owned reverse proxy. Each session runs its own ttyd instance bound to `127.0.0.1` and attached to the session's tmux. The cockpit renders it via `<iframe src="/terminals/<sessionId>/">`.
[ ] 5. Terminal input/output happens inside the ttyd-served xterm and rides ttyd's own WebSocket — proxied through the daemon (so the only external port is the daemon's) and never goes to a 3rd-party host.
[ ] 6. App state, operations, events, and provider health use REST/SSE.
[ ] 7. Citadel still owns session creation, metadata, workspace/runtime association, tmux lifecycle, terminal permissions, ttyd spawn/cleanup, and proxy routing. ttyd is only the renderer.
[ ] 8. Long terminal buffers stay responsive; ttyd's xterm is the renderer and its scrollback bound is enforced by the embedded xterm.
[ ] 9. ttyd ports come from a configurable loopback-only range (default `7681..7720`); the daemon scans for stale `ttyd` processes inside that range on startup and reaps them. At runtime the daemon also periodically detaches orphaned tmux clients (viewer state left behind by closed/crashed cockpit panels) and rotates the per-session pipe-pane log files in `${TMPDIR}/citadel-pty/`, so a long-running deployment does not accumulate per-client memory in the shared tmux server or unbounded log files on disk. The underlying agent session and any process running inside it are never affected — only the disconnected viewer. The pane process is the operator's login shell (`bash -l`); the agent runs as a child via `tmux send-keys`, so Ctrl+C inside the embedded terminal kills the agent without ending the pane.
[ ] 10. Terminal pane state explains starting, attached (`ttyd`), error, and closed states. When ttyd cannot be started (`ttyd_missing`, `no_free_port`, `ttyd_start_timeout`, `tmux_session_missing`, `spawn_failed`) the cockpit shows an inline error with the code, detail, settings/runbook links, and a Retry button — never a blank black pane.
[ ] 11. The Citadel daemon exposes a diagnostic xterm/WebSocket gateway (`/terminal/:sessionId`) for tooling and tests; it is *not* the default cockpit renderer.
[ ] 12. Trade-offs of the ttyd-as-renderer choice are accepted: one external ttyd process per active terminal, dynamic local ports, an additional proxy hop. The benefit is unmodified terminal fidelity (alt-screen, true colour, cursor, key passthrough, paste) without Citadel having to re-implement an xterm gateway.
[~] 13. When an agent process exits back to the shell, the pane prints a Citadel hint with the real runtime session id when available: `[citadel] Agent exited. Run any command, or restart the agent (e.g. \`claude resume <real-session-id>\`).` The literal `<sessionId>` placeholder is never shown. If the runtime id is not known at launch time, Claude panes fall back to the latest transcript id in the workspace's `~/.claude/projects/.../*.jsonl` directory, then to an interactive `claude resume` hint.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

---

keywords: agent sessions, runtime adapters, terminal, tmux, xterm, websocket, reconnect, native terminal
