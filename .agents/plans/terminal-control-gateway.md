Activate the /implement-task skill first.

# Plan: Terminal Control Gateway

## Acceptance Criteria
- [ ] Performance is best - can run 50 workspaces with 3-5 agents inside and switch between them should feel as snappy as possible.
- [ ] RAM usage is as low as possible - no leaks, we clean properly, no orphans. Ideally under 8GB but if possible, even under 4GB or lower.
- [ ] Reliability is best - we don't lose terminals, we can work for days in citadel without noticing restarts or random kills etc.
- [ ] The operator can change any workspace and agent and it feels snappy.
- [ ] Citadel may optimize tmux+ttyd or use another solution, but should not reimplement a terminal from scratch unless there are clear advantages and the same experience is preserved.
- [ ] Citadel is deployed on a devbox and accessed through a browser on the client machine inside VPN.
- [ ] Optimize Citadel's own setup: tmux, ttyd, daemon, terminal renderer, cleanup.
- [ ] Research similar solutions and prove optimizations with tests/checks, not guesses.
- [ ] Deliver a green PR implementing the improved setup.

## Context and problem statement
Citadel currently starts one `ttyd` process per active browser terminal and renders it in an iframe. Local diagnostics on this host showed 6 ttyd processes using 149.8 MiB RSS total, about 25 MiB each, plus one tmux client per ttyd. At the requested 50 workspaces with 3-5 agents, keeping every terminal warm projects to roughly 3.7-6.2 GiB for ttyd alone before counting agents, tmux server state, the daemon, browser, logs, and provider work. The recent LRU cache lowers RSS by evicting ttyd viewers, but switching then pays ttyd process startup, iframe boot, ttyd's xterm bundle, proxy setup, and WebSocket reconnect.

The repo already contains a diagnostic `/terminal/:sessionId` xterm/WebSocket gateway backed by tmux control mode. Tests cover raw input, paste, resize, long output, alternate screen, reconnect scrollback, and cross-session isolation. Its current weakness is input latency: it shells out to `tmux send-keys` for every input chunk.

External reference points:
- VS Code documents its terminal as xterm.js connected through a pseudoterminal, with persistent sessions and scrollback controls: https://code.visualstudio.com/docs/terminal/advanced
- Coder's web terminal architecture is browser xterm.js over WebSocket to a workspace agent/PTTY, with reconnect tokens and buffered output: https://coder.com/docs/user-guides/workspace-access/web-terminal
- xterm.js documents broad production use, including VS Code and ttyd, and provides headless/server-side APIs for terminal state: https://github.com/xtermjs/xterm.js
- ttyd itself is a WebSocket terminal wrapper built with libwebsockets and xterm.js: https://github.com/mangasagu/ttyd

## Spec alignment
Specs currently name ttyd as the primary cockpit renderer and `/terminal/:sessionId` as diagnostic only. This plan intentionally changes that architecture:
- `specs/B.3-agent-sessions-terminal.md`: primary renderer becomes Citadel's xterm.js WebSocket client over tmux control mode; ttyd remains available as fallback/standalone.
- `specs/B.8-ui-performance-quality.md`: performance criteria must cover 50 workspaces and 3-5 agents without per-session ttyd warmup.
- `specs/C-technical-stack.md`: terminal stack must document xterm/WebSocket primary traffic and ttyd fallback.
- `docs/operations/config-reference.md` and `docs/operations/runbook.md`: terminal renderer documentation must match the new default.

## Implementation approach
Promote the existing tmux-control WebSocket gateway to the default cockpit renderer and keep ttyd as an explicit fallback path.

Backend:
- Move the tmux-control bridge into a focused module so `packages/terminal/src/index.ts` stays under the 800-line limit.
- Keep one `tmux -C attach-session` process per actively mounted browser pane, not one `ttyd` process. This process is a lightweight tmux client attached to the durable session.
- Replace per-input `execFileSync("tmux", "send-keys", ...)` with writes to the persistent control-mode stdin, batching input through tmux commands on the same process.
- Preserve output replay on reconnect by sending a bounded tmux snapshot before streaming incremental control-mode output.
- Allow the daemon resolver to self-heal missing tmux sessions with the existing respawn logic before returning the tmux session name to the WebSocket gateway.

Frontend:
- Replace the default iframe `TerminalPane` with an in-process xterm.js component that connects to `/terminal/:sessionId`.
- Use `@xterm/addon-fit` for stable sizing and resize messages.
- Preserve the existing terminal handle registry for focus/reload/recover affordances.
- Keep standalone/open-in-new-tab as a ttyd fallback URL, so ttyd remains available on demand but is no longer spawned during normal workspace switching.

## Alternatives considered
- Tune ttyd LRU cache: rejected as the primary fix. It trades memory for switch latency, and the measured per-ttyd RSS makes warming 150-250 terminals inherently too expensive.
- Keep ttyd but prewarm more aggressively: rejected because it amplifies the RSS problem and still requires one external renderer process per session.
- Replace tmux with raw node-pty sessions: rejected for this PR because tmux already owns Citadel's durability, session identity, prompt submission, capture, cleanup, and status logic. Replacing it would be broader and riskier.
- Use xterm.js directly over tmux control mode: selected because it reuses proven libraries and existing Citadel tests while removing ttyd process/iframe warmup from the default path.

## Implementation steps

### Specs and docs
- Update the terminal specs to describe the new primary renderer and ttyd fallback.
- Update operator docs to reflect `/terminal/:sessionId` as the default WebSocket path and `/terminals/:sessionId/` as fallback/standalone ttyd.

### Backend terminal bridge
- Create a dedicated tmux-control bridge module in `packages/terminal/src`.
- Export `attachTerminalWebSocket`, parsing helpers, and control input helpers through `packages/terminal/src/index.ts`.
- Add persistent control-mode input batching and tests that prove input no longer shells out per key.
- Wire app-level WebSocket session resolution through existing respawn/self-heal logic.

### Frontend renderer
- Add xterm.js direct dependencies to `apps/web`.
- Rework `TerminalPane` to mount xterm.js, connect to `/terminal/:sessionId`, replay snapshots, stream chunks, send input/paste/resize, and show explicit error/reconnect states.
- Keep ttyd fallback URL for standalone tab/reload escape hatch without default spawning.
- Update CSS for in-process xterm sizing.

### Performance proof
- Add or update performance smoke coverage to assert the cockpit no longer needs to spawn ttyd for normal terminal rendering.
- Run targeted unit tests, typecheck/lint, build, and performance smoke.
- Capture local process/resource evidence before and after the change.

## QA/Test Strategy

### Layer evaluation
| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Backend terminal tests must cover control-mode parsing, raw input, control/meta sequences, paste, resize, long output, alternate screen, reconnect, cross-session isolation, and input batching without per-key shellout. Frontend tests must cover WebSocket URL, reconnect/error UI, handle registry, focus, and no POST `/api/agent-sessions/:id/terminal` on default mount. |
| E2E (Playwright) | Required if local environment supports it | This changes the cockpit terminal user journey. Run `pnpm e2e` or a targeted terminal/cockpit spec if present. If browser dependencies are unavailable locally, rely on CI and record the blocker. |

### New tests to add
- `packages/terminal/src/tmux-control-bridge.test.ts`: unit tests for command quoting/batching and WebSocket bridge behavior if split out from existing tests.
- `apps/web/src/terminal-pane.test.ts`: tests proving the default pane opens `/terminal/:sessionId`, does not call the ttyd ensure endpoint, publishes fallback ttyd URL only for standalone action, and handles output/error messages.

### Existing tests to update
- `packages/terminal/src/index.test.ts`: move or update existing WebSocket gateway tests to the new module exports.
- `apps/web/src/terminal-pane.test.ts`: update iframe/ttyd-specific assertions to xterm/WebSocket behavior while keeping error detection helpers for fallback where still relevant.
- `apps/web/src/stage.test.ts` if terminal handles or standalone tab actions change.

### Assertions to add/change/tighten
- Default cockpit terminal mount must not invoke `POST /api/agent-sessions/:id/terminal`.
- WebSocket connect path is `/terminal/<encoded session id>`.
- Input chunks are sent through the existing WebSocket as `{ type: "input", data }`.
- Resize sends bounded `{ type: "resize", cols, rows }`.
- Backend input uses persistent control-mode stdin for normal input rather than spawning a new `tmux` process per key.
- Reconnect sends a bounded snapshot before incremental chunks.
- Missing tmux sessions self-heal through existing respawn logic where possible.

### Failure modes / edge cases / regression risks
- Dynamic TUIs may depend on alternate-screen behavior; existing alternate-screen tests must stay green.
- xterm.js resize loops can cause layout thrash; use `ResizeObserver` and avoid state churn on every terminal write.
- Control-mode command quoting must preserve spaces, quotes, backslashes, and control keys.
- Multiple browser panes for different sessions must not cross-stream output.
- Browser refresh/reconnect must not spawn ttyd or lose the tmux session.
- Operator standalone fallback must still be available for ttyd-specific compatibility issues.

### Adversarial analysis
- **How could this fail in production?** Bad tmux command escaping could corrupt typed input; missing cleanup could leave tmux control clients; resize storms could degrade typing; xterm renderer import could bloat the app bundle.
- **What user actions trigger unexpected behavior?** Rapid workspace switching, paste of multi-line prompts, Ctrl+C/Ctrl+D, terminal reload, browser sleep/resume, and switching into a session whose tmux pane was killed.
- **What existing behavior could break?** ttyd keyboard shortcut shims, standalone terminal open, theme palette, terminal focus, alternate screen, mouse/wheel behavior.
- **Which tests credibly catch those failures?** Terminal package WebSocket tests, frontend TerminalPane tests, typecheck/lint, E2E cockpit terminal smoke, performance smoke.
- **What gaps remain?** Local browser rendering FPS and true multi-day soak are hard to prove in CI; PR should include local resource measurements and leave ttyd fallback available.

## Tests
- Update backend terminal Vitest coverage first, confirm failing assertions around persistent input/no shellout, then implement.
- Update frontend TerminalPane Vitest coverage, confirm old ttyd POST expectations fail, then implement xterm renderer.
- Run `pnpm vitest run packages/terminal/src/index.test.ts apps/web/src/terminal-pane.test.ts` during development.
- Run `make check`, `make performance`, and `pnpm e2e` before PR where local dependencies allow.

## Schema or contract generation
No schema changes. No contract generation.

## Verification
- `make check` passed locally.
- `make performance` passed locally with isolated daemon/web ports and no cockpit ttyd ensure requests. Recorded timings: `api_state 1772ms`, `web_ade_visible 890ms`, `workspace_switch_long_buffers 859ms`, `workspace_settings_switch 360ms`.
- `pnpm e2e e2e/operator-cockpit.spec.ts --project=desktop --grep "terminal"` passed locally, covering the primary `/terminal/:sessionId` WebSocket path and fallback ttyd endpoint.
- `pnpm typecheck` passed after the final performance-smoke cleanup patch.
- `pnpm lint` passed after the final performance-smoke cleanup patch.
- `git diff --check` passed.
- A full `pnpm e2e` run was attempted. The new terminal specs passed, but unrelated shared-state races failed in existing scratchpad/notes specs across projects; the targeted terminal E2E is the relevant gate for this change.
