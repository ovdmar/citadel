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
[ ] 8. Session status includes running, waiting, failed, orphaned, completed, and needs-attention states.
[ ] 9. Session state survives browser refresh/reconnect.
[ ] 10. Switching sessions preserves useful terminal context.
[ ] 11. Sessions surface in the center column as a tab strip with a plus button that offers `Terminal` plus every healthy agent runtime.
[ ] 12. Session tab titles are editable inline. The default title is the runtime display name (`Terminal` for the shell runtime).
[ ] 13. When a workspace opens for the first time and a default agent runtime is healthy, Citadel opens that agent session automatically.

## Runtime Adapters

[ ] 1. Runtime adapters expose capabilities.
[ ] 2. Capability examples include start, resume, prompt injection, transcript discovery, model selection, status detection, and plan/review modes.
[ ] 3. Runtime health is visible before session start.
[ ] 4. Unavailable runtime adapters explain the missing binary, auth, config, or health issue.
[ ] 5. Runtime adapter configuration lives in Citadel settings/config.

## Terminal

[~] 1. Terminal output renders real data.
[ ] 2. Terminal layout has stable bounds inside the cockpit.
[ ] 3. Terminal sessions are backed by durable tmux sessions.
[ ] 4. Browser terminal rendering uses xterm.js.
[ ] 5. Terminal input/output uses WebSocket.
[ ] 6. App state, operations, events, and provider health use REST/SSE.
[ ] 7. Citadel owns attach, reconnect, visible snapshot, live streaming, input routing, and terminal permissions.
[ ] 8. Long terminal buffers stay responsive.
[ ] 9. Terminal scrollback is bounded or virtualized.
[ ] 10. Terminal state explains disconnected, reconnecting, attached, read-only, and failed states.
[ ] 11. The terminal renderer ships a built-in dark-blue palette (Citadel theme) for the 16 ANSI colors, cursor, and selection — independent of the user's shell profile.
[ ] 12. The initial reattach snapshot uses tmux's visible viewport with escape sequences (`capture-pane -p -e`) and restores the recorded cursor cell, so cursor and text always land in the same place after reconnect.
[ ] 13. When the underlying tmux session exits or the snapshot fails, the cockpit writes a visible inline message in the terminal pane (e.g. `[session exited: …]`, `[snapshot error: …]`, `[connection refused: …]`) and flips the status badge to `closed`; the cockpit never leaves a blank black surface without context.

## Future Terminal Surfaces

[ ] 1. Terminal/session model supports multiple renderers.
[ ] 2. A future desktop client can render local sessions in native terminals.
[ ] 3. A future remote daemon can stream remote terminal sessions to web or desktop clients.
[ ] 4. Local and remote sessions share the same session identity model.

---

keywords: agent sessions, runtime adapters, terminal, tmux, xterm, websocket, reconnect, native terminal
