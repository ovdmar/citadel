Activate the /implement-task skill first.

# Plan: Terminal PTY Gateway

## Acceptance Criteria
- [x] Performance is best - can run 50 workspaces with 3-5 agents inside and switch between them should feel as snappy as possible.
- [x] RAM usage is as low as possible - no leaks, we clean properly, no orphans. Ideally under 8GB but if possible, even under 4GB or lower.
- [x] Reliability is best - we don't lose terminals, we can work for days in citadel without noticing restarts or random kills etc.
- [x] The operator can change any workspace and agent and it feels snappy.
- [x] Citadel may optimize tmux+ttyd or use another solution, but should not reimplement a terminal from scratch unless there are clear advantages and the same experience is preserved.
- [x] Citadel is deployed on a devbox and accessed through a browser on the client machine inside VPN.
- [x] Optimize Citadel's own setup: tmux, daemon, terminal renderer, cleanup.
- [x] Research similar solutions and prove optimizations with tests/checks, not guesses.
- [x] Deliver a green PR implementing the improved setup.

## Context and problem statement
The previous attempt promoted a tmux control-mode renderer. It sounded efficient but broke interactive terminal behavior for Claude Code/Codex-class TUIs because Citadel was interpreting tmux control output instead of attaching through a real PTY. The existing ttyd design had correct PTY semantics, but one ttyd process and iframe per warm terminal does not scale to 150-250 sessions without either high RAM or slow cold switches.

Research points the fix toward the common architecture used by mature web terminals: xterm.js in the browser, a WebSocket transport, and a server-side pseudoterminal. node-pty is the Microsoft-maintained PTY binding used by VS Code and other terminal emulators; xterm.js documents VS Code and ttyd as real-world users; ttyd itself is a good reference that validates xterm.js for terminal rendering, while Citadel's cost problem was the per-session ttyd process/proxy/iframe model.

Research references:
- xterm.js documents the standard pattern as browser terminal IO wired to a backing pseudoterminal such as node-pty, and lists VS Code/ttyd among real-world users: https://github.com/xtermjs/xterm.js/
- node-pty provides `forkpty(3)` bindings so programs receive real pseudoterminal file descriptors and terminal control sequences: https://github.com/microsoft/node-pty
- VS Code documents its integrated terminal as xterm.js plus a pseudoterminal transport, and notes local echo is disabled for dynamic programs such as tmux: https://code.visualstudio.com/docs/terminal/advanced

## Spec alignment
- `specs/B.3-agent-sessions-terminal.md`: primary renderer becomes xterm.js over WebSocket to node-pty `tmux attach-session`; ttyd fallback is removed.
- `specs/B.8-ui-performance-quality.md`: workspace switching and mobile terminal layout describe xterm/PTY attach rather than iframe/ttyd startup.
- `specs/C-technical-stack.md`: required terminal stack is git, tmux, xterm.js, node-pty, and the daemon WebSocket bridge.
- `specs/B.2-ade-cockpit.md`: workspace focus now targets the in-process xterm pane directly.
- Operator docs and architecture docs must match the single supported terminal path.

## Implementation approach
Keep tmux as the durable session owner, but make every browser viewer a disposable PTY attach:

- Browser: `TerminalPane` mounts xterm.js and opens `/terminal/:sessionId`.
- Transport: terminal input/output bytes use binary WebSocket frames; JSON is reserved for resize/error/exit controls.
- Daemon: the bridge resolves the session id to a tmux session name, self-heals via the existing respawn path when possible, and spawns `tmux attach-session` with node-pty.
- Cleanup: WebSocket close/error kills the PTY viewer with `SIGHUP`; the systemd unit kills daemon child processes on restart; the existing tmux-client reaper remains for abrupt viewer death.
- Scope: remove the ttyd proxy, ttyd manager, iframe key shim, ttyd port config, standalone route, and related tests/docs instead of keeping fallback code.

## Alternatives considered
- Keep tuning ttyd LRU: rejected. It trades memory for switch latency and still scales with external renderer processes.
- Keep tmux control mode: rejected by operator feedback. It loses native PTY semantics for full-screen/interactive CLIs.
- Replace tmux with raw long-lived node-pty sessions: rejected for this PR. tmux already owns durability, prompt submission, capture, status, restore, and cleanup.
- Use xterm.js + node-pty + tmux attach: selected. It preserves the same terminal semantics as a normal tmux attach while removing ttyd process/iframe overhead.

## Implementation steps
1. Update specs/docs to describe the single PTY terminal path and removed ttyd fallback.
2. Replace the terminal bridge with node-pty `tmux attach-session`, binary frame IO, resize controls, and PTY cleanup.
3. Update `TerminalPane` for binary IO, xterm shortcut handling, Ctrl+C user-action signaling, reconnect/error UI, and no legacy ensure calls.
4. Delete ttyd route/proxy/manager/shim/slot code and remove `http-proxy` plus ttyd env/config references.
5. Update unit, e2e, and performance smoke coverage for the new bridge.
6. Run local targeted checks, performance smoke, e2e terminal smoke, then push and monitor PR CI.

## QA/Test Strategy

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Backend terminal tests cover raw input, control/meta sequences, paste, resize, long output, alternate screen, reconnect, cross-session isolation, and invalid controls. Frontend tests cover WebSocket URL, binary output/input, resize control, shortcut handling, Ctrl+C user action, handle registry, and error UI. |
| E2E (Playwright) | Required | Terminal cockpit smoke opens a real shell session over `/terminal/:sessionId`, sends bytes through the WebSocket, and observes output. Remove fallback endpoint coverage because the endpoint is intentionally gone. |

Adversarial checks:
- Interactive TUIs must see a real PTY, not command-encoded control-mode input.
- Browser refresh and workspace switching must not kill the durable tmux session.
- Closing viewers must not leave node-pty/tmux attach children behind.
- Long output must not require replaying unbounded history on every switch.
- App shortcuts and Ctrl+C must work while xterm has focus.

## Tests
- `pnpm vitest run packages/terminal/src/index.test.ts apps/web/src/terminal-pane.test.ts apps/daemon/src/orphan-reaper.test.ts apps/daemon/src/scheduled-agent-service.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm check:arch`
- `pnpm check:deps`
- `pnpm build`
- `pnpm exec playwright test e2e/operator-cockpit.spec.ts --project=desktop --grep "terminal"`
- `pnpm performance`
- `pnpm check`

## Schema or contract generation
No schema changes. No contract generation.

## Verification
Passed locally:
- `pnpm check` (architecture, size, typecheck, lint, Vitest, coverage, dependency policy, build): 103 test files / 1003 tests passed; coverage all-files statements 89.02%, branches 81.12%.
- `pnpm exec playwright test e2e/operator-cockpit.spec.ts --project=desktop --grep "terminal"`: 1 passed.
- `pnpm performance`: `api_state 1934ms`, `web_ade_visible 902ms`, `workspace_switch_long_buffers 931ms`, `workspace_settings_switch 352ms`.

Additional terminal-specific proof:
- `packages/terminal/src/index.test.ts` now covers binary WebSocket input/output, invalid control messages, heredoc-style multi-line paste, resize, alternate screen, reconnect scrollback, session isolation, and server shutdown cleanup of upgraded terminal sockets.
- `apps/web/src/terminal-pane.test.ts` covers binary xterm IO, resize controls, app shortcut forwarding, Ctrl+C user-action reporting, and removal of the legacy terminal ensure endpoint.
