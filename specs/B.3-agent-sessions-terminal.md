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
[~] 8. Session status uses the canonical seven-value enum: `starting`, `running`, `waiting_for_input`, `idle`, `stopped`, `failed`, `unknown`. Semantics: `starting` = TUI initializing; `running` = agent actively working OR in-turn background work (Monitor, background Bash, subagent) still in flight; `waiting_for_input` = agent has invoked an explicit question / sandbox-approval tool and is blocked on the operator; `idle` = turn ended on the agent's own initiative; `stopped`/`failed` = the CLI process itself exited (rare for persistent TUIs — only when the operator `/quit`s or it crashes; `failed` means a non-zero exit code); `unknown` = liveness cannot be proven (tmux gone, daemon restart with indeterminate state). The legacy `orphaned` and `completed` values collapse into `unknown` and `stopped` respectively, distinguished via a `status_reason` field. Status is persisted in the agent_sessions table along with `last_status_at`, `last_output_at`, `ended_at`, `exit_code`, and `status_reason`.
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
[ ] 3. Terminal sessions are backed by durable tmux sessions.
[ ] 4. The primary browser terminal renderer is `ttyd` served through a Citadel-owned reverse proxy. Each session runs its own ttyd instance bound to `127.0.0.1` and attached to the session's tmux. The cockpit renders it via `<iframe src="/terminals/<sessionId>/">`.
[ ] 5. Terminal input/output happens inside the ttyd-served xterm and rides ttyd's own WebSocket — proxied through the daemon (so the only external port is the daemon's) and never goes to a 3rd-party host.
[ ] 6. App state, operations, events, and provider health use REST/SSE.
[ ] 7. Citadel still owns session creation, metadata, workspace/runtime association, tmux lifecycle, terminal permissions, ttyd spawn/cleanup, and proxy routing. ttyd is only the renderer.
[ ] 8. Long terminal buffers stay responsive; ttyd's xterm is the renderer and its scrollback bound is enforced by the embedded xterm.
[ ] 9. ttyd ports come from a configurable loopback-only range (default `7681..7720`); the daemon scans for stale `ttyd` processes inside that range on startup and reaps them. At runtime the daemon also periodically detaches orphaned tmux clients (viewer state left behind by closed/crashed cockpit panels) and rotates the per-session pipe-pane log files in `${TMPDIR}/citadel-pty/`, so a long-running deployment does not accumulate per-client memory in the shared tmux server or unbounded log files on disk. The underlying agent session and any process running inside it are never affected — only the disconnected viewer.
[ ] 10. Terminal pane state explains starting, attached (`ttyd`), error, and closed states. When ttyd cannot be started (`ttyd_missing`, `no_free_port`, `ttyd_start_timeout`, `tmux_session_missing`, `spawn_failed`) the cockpit shows an inline error with the code, detail, settings/runbook links, and a Retry button — never a blank black pane.
[ ] 11. The Citadel daemon exposes a diagnostic xterm/WebSocket gateway (`/terminal/:sessionId`) for tooling and tests; it is *not* the default cockpit renderer.
[ ] 12. Trade-offs of the ttyd-as-renderer choice are accepted: one external ttyd process per active terminal, dynamic local ports, an additional proxy hop. The benefit is unmodified terminal fidelity (alt-screen, true colour, cursor, key passthrough, paste) without Citadel having to re-implement an xterm gateway.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

## Composing system prompts on launch

The MCP launchers (`launch_implementation_agent`, etc., and `launch_custom_agent`) compose the launching prompt by prepending the agent definition's system prompt to the caller's user prompt under `## System` / `## User prompt` headers. Composition is uniform across all runtimes — no runtime-specific `--system-prompt` flags in v1. Both create-and-launch and reuse-existing-workspace paths route through the same `composeAndLaunchAgent` seam so the system prompt cannot be silently dropped on one path.

---

keywords: agent sessions, runtime adapters, terminal, tmux, xterm, websocket, reconnect, native terminal, system prompt composition
