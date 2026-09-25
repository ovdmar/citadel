Activate the /implement-task skill first.

# Plan: Terminal Render Stability

## Acceptance Criteria

- [ ] "from time to time, just watching terminal, it changes resolution and renders some dots - then it comes back to full resolution."
- [ ] "it happens so often that i can't work/read the terminal"
- [ ] "can it be related to how our citadel implements terminals?"
- [ ] "audit for a proper and fix and make sure it's the good direction. run /do-tech-plan for this"

## Context and problem statement

The operator is using the Codex terminal inside Citadel as a Chrome PWA on macOS. The visible symptom is that the terminal intermittently appears to drop to a lower-resolution/dotted render, then returns to normal. The session itself is probably not changing terminal dimensions, but Citadel's current xterm viewer makes Chrome compositor refreshes more visible and may amplify them.

Current findings:

- `apps/web/src/stage-terminal.css` paints a low-opacity SVG turbulence/noise texture via `.stage-body::before` underneath the terminal surface. When the xterm layer is transparent or briefly unavailable during a compositor repaint, this can appear as dots.
- `apps/web/src/terminal-pane.tsx` creates xterm with `allowTransparency: true`, so the terminal is explicitly allowed to expose underlying layers.
- The terminal resize path calls `fit.fit()` directly from every `ResizeObserver` callback and `window.resize`, then sends a PTY resize every time the WebSocket is open, even when `terminal.cols` / `terminal.rows` did not change.
- Hidden retained panes are dormant (`active=false`), so the issue is focused on the active xterm viewer rather than background terminal sessions.

The proper direction is to harden the browser viewer boundary without changing the durable tmux / daemon WebSocket / node-pty architecture. The suspected problem is a render-layer and resize-storm interaction, not terminal process lifecycle or server-side session durability.

## Spec alignment

- `specs/A-shared-definitions.md`: Uses the canonical terms Workspace and Agent session. No spec change needed.
- `specs/B.2-ade-cockpit.md`: Aligns with Shell Layout #8 and Center Stage Sessions #6-#8. Terminal scrollback remains inside xterm, the selected session still occupies the column, and keyboard shortcuts continue to pass through.
- `specs/B.3-agent-sessions-terminal.md`: Aligns with Terminal #2, #4, #5, #8, #10, and #12. The xterm/WebSocket/tmux architecture remains unchanged; this plan only stabilizes xterm rendering and resize behavior.
- `specs/B.8-ui-performance-quality.md`: Aligns with UI Quality #9/#10, Performance #2/#6/#7, and Release Quality #7/#11. The xterm host keeps stable bounds and workspace switching should remain responsive with long buffers.

Spec updates are required first because this is a bug/gap fix:

- Update `specs/B.3-agent-sessions-terminal.md` Terminal #8 or #10 to state that the in-process xterm renderer is opaque over the cockpit stage and coalesces/de-dupes active-pane resize work so compositor refreshes do not expose decorative underlayers or resize the PTY unnecessarily.
- Update `specs/B.8-ui-performance-quality.md` Performance #2 / Release Quality #7 to mention renderer-stability regression coverage for the cockpit terminal, not only WebSocket transport smoke.

## Implementation approach

Keep the terminal architecture unchanged and make the active browser viewer compositor-safe:

1. Remove the dotted underlay from the terminal paint path.
   - Delete or disable `.stage-body::before` in `apps/web/src/stage-terminal.css` so the terminal stage no longer has a noise texture beneath xterm.
   - Keep the stage background as an opaque theme surface.

2. Make xterm opaque.
   - Change `allowTransparency` to `false` in `TerminalPane`.
   - Ensure the terminal host/surface remains visibly opaque in both light and dark themes. Prefer xterm's existing theme background for the terminal canvas; use CSS only to avoid transparent host gaps.

3. Coalesce terminal fit/resize work.
   - Replace direct `sendResize()` calls from `ResizeObserver` / `window.resize` with a `requestAnimationFrame` scheduler.
   - Call `fit.fit()` at most once per animation frame while mounted.
   - Schedule an initial resize on WebSocket open and after mount.
   - Guard late callbacks with the existing mounted/disposed flag so WebSocket `open` / `message` / `close` / `error` handlers and scheduled resize work cannot touch a disposed xterm instance.
   - Cancel any pending animation frame during cleanup.

4. De-dupe PTY resize control messages.
   - Track the last `{ cols, rows }` successfully sent to the WebSocket.
   - After each fit, send `{ type: "resize", cols, rows }` only when the WebSocket is open, `cols > 0`, `rows > 0`, both values are finite, and the terminal size changed.
   - Scope `lastSentResize` to the current WebSocket / active effect generation. A reconnect or manual reload must send its first valid size again, even when the new terminal dimensions match the old socket's last sent size.
   - Do not mark a size as sent while the WebSocket is still connecting; the open handler must still send the first actual size.
   - Do not send zero/invalid dimensions observed during transient layout collapse; a later valid fit must still send normally.
   - Continue running `fit.fit()` on scheduled resize frames even when the terminal size ultimately stays the same, so browser/device-pixel-ratio changes can still let xterm refresh its own backing store.

5. Keep scope out of the daemon unless implementation proves otherwise.
   - Do not change `packages/terminal` or `apps/daemon` for the first implementation pass.
   - If manual or automated evidence shows duplicate resize controls are still reaching the bridge, add a tiny daemon-side duplicate guard as a follow-up with its own targeted test.

## Alternatives considered

- Disable Chrome hardware acceleration or stop using the PWA: rejected as the product fix. Those remain operator workarounds, but Citadel should not make compositor flicker unreadable.
- Change the terminal transport or tmux/node-pty bridge: rejected. The symptom points to browser painting and resize behavior; the existing architecture is explicitly accepted by B.3 and is working for terminal semantics.
- Only remove the noise texture: rejected as incomplete. It would hide the most visible "dots" but leave resize storms and transparent xterm behavior intact.
- Only throttle resize calls: rejected as incomplete. It reduces redraw pressure but still leaves a dotted underlay visible during compositor refreshes.
- Introduce a new renderer/dependency: rejected. xterm.js is already the chosen terminal renderer, and no dependency is needed for a small scheduling/paint fix.

## Implementation steps

### Spec updates (first, before code)

- Update `specs/B.3-agent-sessions-terminal.md` to document opaque xterm rendering over the stage and coalesced/de-duped active-pane resize controls as part of Terminal #8/#10.
- Update `specs/B.8-ui-performance-quality.md` to document renderer-stability coverage for the cockpit terminal in Performance / Release Quality.

### Frontend Renderer

- Update `apps/web/src/terminal-pane.tsx`:
  - Set `allowTransparency: false`.
  - Replace direct resize calls with a `requestAnimationFrame`-backed scheduler.
  - Track `lastSentResize` locally inside the active terminal effect / WebSocket instance so it resets on reconnect, reload, session id change, and active remount.
  - Validate resize dimensions before sending: finite positive `cols` and `rows` only.
  - Ensure cleanup disconnects `ResizeObserver`, removes the `window.resize` listener, cancels the pending frame, closes the WebSocket, and disposes xterm exactly once.
  - Ensure every WebSocket event handler checks the mounted/disposed flag before writing to xterm, setting React state, or scheduling resize work.
  - Preserve existing behaviors for binary output, raw input, shortcut handling, Shift+Enter control input, paste, Ctrl+C user-action recording, reconnect/error UI, and theme updates without reconnecting.

### Stage Styling

- Update `apps/web/src/stage-terminal.css`:
  - First verify `.stage-body::before` is only used for the terminal stage. If it is terminal-only, remove the pseudo-element. If it is shared by future non-terminal stage content, suppress it only for the terminal stage path and document the scope in a nearby CSS comment.
  - Keep `.stage-body`, `.terminal-surface`, and `.terminal-xterm-host` opaque and bounded.
  - Ensure no terminal-visible surface relies on transparent backgrounds that expose parent decoration.

### E2E Renderer Guard

- Update `e2e/operator-cockpit.spec.ts` with a desktop-only UI terminal render assertion:
  - Create a workspace and shell session as existing tests do.
  - Open the cockpit, select the session, and wait for `.terminal-active .terminal-xterm-host`.
  - Assert the terminal host has stable non-zero bounds before and after a short wait / viewport nudge.
  - Assert the terminal stage no longer exposes the pseudo-element noise layer and that terminal-visible backgrounds are not transparent.
  - Keep the existing WebSocket terminal smoke unchanged; it covers transport semantics.

### Migration strategy

No schema changes.

### Hard-gate notes

- Architecture-boundary gate: applies because `apps/web/**` changes. The implementation must not import daemon internals; it should use only existing web dependencies and contracts.
- Schema-safety gate: skipped; no DB/schema changes.
- File-size gate: applies. `terminal-pane.tsx` and `stage-terminal.css` are both comfortably under 800 lines today; the implementation must keep them under the limit.
- Current line counts before implementation: `apps/web/src/terminal-pane.tsx` 462, `apps/web/src/terminal-pane.test.ts` 370, `apps/web/src/stage-terminal.css` 622, `e2e/operator-cockpit.spec.ts` 410, `specs/B.3-agent-sessions-terminal.md` 58, `specs/B.8-ui-performance-quality.md` 76. Re-check all touched files after implementation. If any non-generated source file would exceed 800 lines, split test helpers or extract CSS before merging.
- Provider-degradation gate: skipped; no provider-backed code changes.
- Workspace-cleanup-safety gate: skipped; no workspace lifecycle changes.
- Terminal-completeness gate: applies because xterm/terminal code changes. Existing `packages/terminal/src/index.test.ts` covers WebSocket raw input/output, resize, alternate screen, long output, reconnect scrollback, and cross-session isolation. This plan adds explicit frontend assertions for raw input, control/meta key sequences, paste, resize coalescing, invalid resize suppression, open/reconnect resize behavior, and late-event cleanup.
- Lockfile-sensitivity gate: skipped; no dependency or lockfile changes.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Update `apps/web/src/terminal-pane.test.ts` to pin opaque xterm options, resize coalescing, resize de-duping, cleanup of pending animation frames, and existing keyboard/input behavior. Existing `packages/terminal/src/index.test.ts` remains the terminal bridge semantic guard. |
| E2E (Playwright) | Required | Update `e2e/operator-cockpit.spec.ts` to verify the real cockpit terminal surface is opaque, bounded, and not exposing the stage noise layer. Run the existing terminal WebSocket smoke as transport coverage. |

### New tests to add

- `apps/web/src/terminal-pane.test.ts`: `creates an opaque xterm renderer` - assert the fake terminal receives `allowTransparency: false` and the expected theme background.
- `apps/web/src/terminal-pane.test.ts`: `coalesces resize events and sends PTY resize only when rows or columns change` - fake `ResizeObserver` and `requestAnimationFrame`; fire repeated observer/window/open events in one frame; assert one `fit()` and one resize message, then change fake `cols`/`rows` and assert one additional resize.
- `apps/web/src/terminal-pane.test.ts`: `does not send invalid terminal dimensions` - set fake terminal `cols`/`rows` to zero, negative, `NaN`, or `Infinity`; assert no resize control is sent, then set valid dimensions and assert the next scheduled frame sends them.
- `apps/web/src/terminal-pane.test.ts`: `cancels pending resize work on unmount` - schedule a resize, unmount before flushing the frame, then assert no late `fit()` / WebSocket send occurs.
- `apps/web/src/terminal-pane.test.ts`: `ignores late WebSocket events after unmount` - unmount, then trigger fake WebSocket `open`, `message`, `close`, and `error`; assert no writes, no resize sends, and no state updates/errors.
- `apps/web/src/terminal-pane.test.ts`: `keeps raw input, control/meta shortcuts, and paste working after resize scheduler changes` - extend existing shortcut coverage to include raw `onData`, Cmd/Ctrl shortcut interception, Shift+Enter control input, Cmd+V clipboard paste, and Ctrl+C user-action reporting if not already covered.
- `apps/web/src/terminal-pane.test.ts`: `sends the first valid resize when the WebSocket opens after an earlier fit` - prove a pre-open fit does not poison `lastSentResize`.
- `apps/web/src/terminal-pane.test.ts`: `sends the first valid resize again after reconnect` - send an initial resize on one fake WebSocket, force a reload/reconnect, open the new fake WebSocket with the same `cols`/`rows`, and assert the resize is sent again on the new socket.
- `e2e/operator-cockpit.spec.ts`: `desktop terminal surface is opaque and stable in the cockpit` - open a real shell session in the browser UI and assert stable bounds plus non-transparent/no-noise terminal styling.

### Existing tests to update

- `apps/web/src/terminal-pane.test.ts`: update `writes WebSocket output to xterm and sends input/resize over the same socket` so it flushes the fake animation frame before expecting the initial resize.
- `e2e/operator-cockpit.spec.ts`: keep `desktop primary terminal WebSocket streams a fresh shell session` as the transport smoke; do not weaken its assertions.

### Assertions to add/change/tighten

- Assert xterm is constructed with `allowTransparency: false`.
- Assert repeated resize events in one frame do not produce repeated `fit()` calls.
- Assert repeated resize events with unchanged `terminal.cols` / `terminal.rows` do not send duplicate PTY resize controls.
- Assert a resize before WebSocket open does not suppress the first resize after WebSocket open.
- Assert a reconnect/new WebSocket sends its first valid resize even when dimensions match the prior socket.
- Assert zero, negative, `NaN`, and `Infinity` dimensions are not sent as PTY resize controls.
- Assert late WebSocket `open`, `message`, `close`, and `error` events after unmount do not write to disposed xterm or schedule resize work.
- Assert cleanup cancels pending resize work.
- Assert raw input, Shift+Enter, Cmd/Ctrl shortcuts, Cmd+V paste, and Ctrl+C user-action reporting still behave as before.
- Assert terminal-visible backgrounds are not transparent in the real cockpit DOM.
- Assert the stage body pseudo-element no longer contributes a background image/content under the terminal.

### Failure modes / edge cases / regression risks

- Initial resize could be lost if the scheduler records a size before the WebSocket opens.
- Reconnect could inherit stale de-dupe state and skip the new socket's initial resize unless `lastSentResize` is scoped per WebSocket/effect generation.
- Coalescing could under-fit when the container changes several times quickly.
- De-duping could accidentally skip PTY resize after a real rows/columns change.
- Invalid dimensions observed during transient layout collapse could resize the PTY to unusable rows/columns if not guarded.
- Cleanup could leave a queued animation frame that touches a disposed xterm instance.
- Late WebSocket events after unmount could write to a disposed xterm instance or set React state after cleanup.
- Removing the noise layer could regress the stage's intended visual treatment.
- Making xterm opaque could expose a mismatch between xterm theme background and the surrounding terminal surface.
- Shortcut handling, paste, raw input, and Ctrl+C reporting could regress if resize code changes the effect lifecycle.
- Headless Playwright may not reproduce Chrome PWA compositor behavior; manual PWA verification remains necessary.

### Adversarial analysis

- **How could this fail in production?** The terminal could still flicker if Chrome's PWA compositor has a deeper canvas bug, but the dotted underlay and transparent xterm layer would no longer make that failure unreadable. A resize scheduler bug could also cause wrong PTY dimensions.
- **What user actions trigger unexpected behavior?** Moving the PWA between displays, changing macOS display scaling, resizing/collapsing Citadel columns, switching workspaces/sessions, opening modals over the terminal, and long terminal output while the viewport changes.
- **What existing behavior could break?** Initial attach sizing, terminal keyboard shortcuts, paste, Ctrl+C user-action logging, hidden-pane dormancy, theme switching without reconnect, and WebSocket cleanup.
- **Which tests credibly catch those failures?** The new `terminal-pane.test.ts` resize scheduler tests catch lost initial resize, duplicate resize messages, and cleanup leaks. Existing terminal unit tests catch raw transport, resize semantics, alternate screen, long output, reconnect, and isolation. The new Playwright UI assertion catches transparent/noise-layer regressions in the real cockpit DOM.
- **What gaps remain?** Playwright cannot fully model macOS Chrome PWA compositor behavior or multi-monitor Retina/non-Retina transitions. Implementation QA must include a manual Chrome PWA smoke on macOS after automated checks pass.

## Tests

TDD order:

1. Update `specs/B.3-agent-sessions-terminal.md` and `specs/B.8-ui-performance-quality.md`.
2. Update `apps/web/src/terminal-pane.test.ts` with failing tests for opaque xterm construction, resize coalescing/de-duping, invalid resize suppression, first-open resize behavior, reconnect/new-socket initial resize behavior, pending-frame cleanup, late WebSocket events, and raw input/control/meta/paste preservation.
3. Update `e2e/operator-cockpit.spec.ts` with the failing desktop terminal opacity/stability assertion.
4. Implement `TerminalPane` scheduler and opaque xterm changes.
5. Implement scoped stage CSS cleanup.
6. Re-check touched file lengths with `wc -l apps/web/src/terminal-pane.tsx apps/web/src/terminal-pane.test.ts apps/web/src/stage-terminal.css e2e/operator-cockpit.spec.ts specs/B.3-agent-sessions-terminal.md specs/B.8-ui-performance-quality.md`; split before continuing if any file approaches/exceeds 800 lines.
7. Run targeted checks:
   - `pnpm vitest run apps/web/src/terminal-pane.test.ts`
   - `pnpm vitest run packages/terminal/src/index.test.ts`
   - `pnpm exec playwright test e2e/operator-cockpit.spec.ts --project=desktop --grep "terminal"`
8. Run full verification commands.

## Schema or contract generation

No schema changes. No contract generation.

## Verification

- `make check` - comprehensive local gate: architecture, file size, typecheck, lint, Vitest, coverage, dependency policy, and build.
- `make e2e` - Playwright cockpit flows, including the terminal UI renderer assertion and existing terminal smoke.
- `make performance` - required because this changes the terminal rendering/resize hot path and should not regress workspace switching with long buffers.

Manual QA after automated checks:

- Install/open Citadel as a Chrome PWA on macOS.
- Watch an active Codex terminal for several minutes during no input, long output, workspace switching, and column/window resizing.
- Confirm the dotted/low-resolution repaint no longer interrupts reading, and confirm `stty size` inside the terminal remains stable except during intentional layout changes.
