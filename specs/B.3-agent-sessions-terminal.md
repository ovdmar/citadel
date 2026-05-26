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
[~] 14. Workspace cards, stage tabs (per-agent), and the navigator "Running" stat all display the small pulsing lifecycle icon and follow the same four-tone `LifecycleTone` taxonomy: `never-started`, `running`, `done`, `attention`. CSS classes are reused from the shared `cit-pulse` / `cit-pulse-sm` chrome plus a new `cit-pulse-done` (green + ripple) and a ripple addition to `cit-pulse-bad`. Per-agent mapping (`deriveAgentLifecycleTone` in `@citadel/core`): `starting`/`running`/`idle` → `running` (active or between-turn waiting); `waiting_for_input` → `attention`; `stopped` with exit code in `{0, null, 130, 143}` → `done`; `stopped` with other non-zero exit → `attention`; `failed` → `attention`; `unknown` → `attention` when `sessionNeedsAttention()` is true (tmux-gone reasons), else `running` (indeterminate but possibly alive). Per-agent never returns `never-started`. Workspace mapping (`deriveWorkspaceLifecycleTone` in `@citadel/core`): filter out shell sessions; if none remain → `never-started`; else aggregate by priority `attention > running > done`; then fold PR/CI — if `prToneFor(pullRequest) === "failing"`, escalate to `attention` regardless of agent aggregate. CI-red wins over a running agent because the failing CI is the more actionable operator signal. CSS class mapping (`lifecycleToneClass` in `apps/web/src/workspace-card.tsx`): `never-started → cit-pulse-idle`, `running → cit-pulse-run`, `done → cit-pulse-done`, `attention → cit-pulse-bad`. `cit-pulse-ok` (solid green) is reserved for non-lifecycle uses (auto-mode pill, deploy-health badge) and is not part of this taxonomy. The navigator receives a `workspacePullRequests` map from the cockpit so per-workspace PR data participates in the aggregate.
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
[ ] 9. ttyd ports come from a configurable loopback-only range (default `7681..7720`); the daemon scans for stale `ttyd` processes inside that range on startup and reaps them.
[ ] 10. Terminal pane state explains starting, attached (`ttyd`), error, and closed states. When ttyd cannot be started (`ttyd_missing`, `no_free_port`, `ttyd_start_timeout`, `tmux_session_missing`, `spawn_failed`) the cockpit shows an inline error with the code, detail, settings/runbook links, and a Retry button — never a blank black pane.
[ ] 11. The Citadel daemon exposes a diagnostic xterm/WebSocket gateway (`/terminal/:sessionId`) for tooling and tests; it is *not* the default cockpit renderer.
[ ] 12. Trade-offs of the ttyd-as-renderer choice are accepted: one external ttyd process per active terminal, dynamic local ports, an additional proxy hop. The benefit is unmodified terminal fidelity (alt-screen, true colour, cursor, key passthrough, paste) without Citadel having to re-implement an xterm gateway.
[~] 13. When an agent process exits, the tmux pane survives via a wrapper `exec`-ing a fallback shell and prints a hint so the operator can restart the agent. The hint is runtime-aware. For `runtimeId === "claude-code"`, the wrapper resolves the agent's actual Claude session UUID at exit time by listing `*.jsonl` files in `~/.claude/projects/<dasherized-cwd>/` (where `<dasherized-cwd>` replaces every non-alphanumeric character in the absolute workspace path with `-`; mirrors `claudeProjectsDir` in `@citadel/runtimes`) and taking the most-recent file's basename. When a UUID resolves, the hint reads exactly: `` [citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume <UUID>`). `` When resolution fails (no transcript yet, dir missing) or the runtime is non-Claude, the hint degrades to: `` [citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume` to pick a session interactively). `` The wrapper must not `cd` anywhere before the resolver runs, since the resolver relies on `pwd` reflecting the workspace cwd that tmux launched the pane in.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

---

keywords: agent sessions, runtime adapters, terminal, tmux, xterm, websocket, reconnect, native terminal
