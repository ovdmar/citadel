Activate the /implement-task skill first.

# Plan: Scratchpad Capture Voice Mobile

## Acceptance Criteria

Requirements come from the grilling session for "Scratchpad capture — voice, mobile, Mac satellite", with the current-main precheck applied on June 4, 2026.

- [ ] Voice mode is a global input method, not scratchpad-only.
- [ ] Voice mode uses the browser Web Speech API only for v1.
- [ ] Voice recognition is hard-coded to `en-US`.
- [ ] Voice mode is push-to-dictate: one capture, one commit/submit, then stop.
- [ ] Recognized speech is treated as literal text only; no spoken commands in v1.
- [ ] Desktop/web/PWA shortcut is `Shift+Cmd+D` on Mac and `Shift+Ctrl+D` elsewhere, pending a first implementation step that verifies browsers deliver this chord to the app.
- [ ] The shortcut works everywhere in Citadel where the browser delivers the key event and targets the currently focused input surface.
- [ ] Voice mode starts dictation immediately from the shortcut when `SpeechRecognition.start()` is accepted by the browser.
- [ ] If shortcut-start is rejected for activation or permission reasons, voice mode keeps the snapshotted target, shows the voice overlay, and requires an explicit mic/retry click to start capture.
- [ ] Mobile has no shortcut requirement; mobile voice entry is through a mic button.
- [ ] The mobile scratchpad composer has a visible mic button when Web Speech API is available.
- [ ] Scratchpad mic button and desktop shortcut use the same global voice-mode engine.
- [ ] A mic button explicitly targets its associated field even when that field was not previously focused.
- [ ] Voice target is snapshotted when dictation starts.
- [ ] Valid v1 targets are `textarea` editables, text-like non-sensitive `input` editables (`text`, `search`, `email`, `tel`, `url`), explicitly registered Citadel edit surfaces, and focused terminal/session panes.
- [ ] Generic `contenteditable` is not a v1 fallback target unless the Citadel surface explicitly registers a voice adapter.
- [ ] If no valid target exists, do not fall back to scratchpad; capture into a temporary copyable buffer and show a clear no-target state.
- [ ] In no-target state, final transcript is committed to the buffer, recognition stops, auto-submit is ignored, and the overlay remains until copied or dismissed.
- [ ] Terminal/session targets use the terminal input path directly, not the agent message API.
- [ ] Agent sessions and plain terminal sessions follow the same terminal-input rule.
- [ ] Auto-submit defaults on and is user-toggleable for later evaluation.
- [ ] Auto-submit preference is persisted locally.
- [ ] Auto-submit submits after a final recognition result plus `FINAL_AUTO_SUBMIT_DELAY_MS = 900`; interim text is never committed.
- [ ] A `NO_RESULT_SILENCE_TIMEOUT_MS = 10_000` hard stop remains as a safety timeout from start or the most recent recognition result.
- [ ] If dictation appends into an existing draft, auto-submit submits the whole draft.
- [ ] Plain terminal auto-submit sends Enter; with auto-submit off, dictated text is inserted without Enter.
- [ ] Normal editable insertion preserves caret/selection behavior and replaces selected text.
- [ ] Auto-submit only fires for registered submit-safe targets and terminal targets. Generic editables insert text only and report "inserted, not submitted."
- [ ] A global floating voice control shows listening state, transcript preview, auto-submit toggle, stop/cancel, copy fallback, and errors.
- [ ] Interim transcript is shown when straightforward, but only final text is committed.
- [ ] If Web Speech API is unavailable or the page is not a secure context, mic controls are hidden.
- [ ] If permission or capture fails after start, show a concise state-specific error and keep any partial transcript copyable.
- [ ] On mobile bare-root launch, Citadel opens the existing scratchpad panel by default as the quick idea path.
- [ ] Mobile bare-root launch uses `replaceState` to `/?scratchpad=1` and opens the existing scratchpad panel before last-route restoration can override it.
- [ ] Mobile root deeplinks with any search or hash are untouched.
- [ ] On mobile auto-open, focus the scratchpad composer where the browser permits it.
- [ ] Do not create a separate mobile scratchpad page in v1; make the existing panel full-screen/mobile-optimized.
- [ ] Mac satellite remains out of scope: no native helper, no OS-global shortcut, no native new-workspace menu.

## Context And Problem Statement

The implementation base is current `origin/main` at `f5c0007`. The old branch diffs are intentionally discarded.

Current main already has:

- A Shell-level `ScratchpadPanel` mounted beside the router outlet in `apps/web/src/main.tsx`.
- A `/scratchpad` route component that opens the drawer and navigates to `<last-route>?scratchpad=1` or `/?scratchpad=1`.
- A pure `bootstrapLastRoute` helper in `apps/web/src/lib/last-route.ts`, called before router construction.
- In-process xterm terminal panes connected to the daemon WebSocket at `/terminal/:sessionId`; no ttyd path.
- Canonical shortcut data in `packages/contracts/src/shortcuts.ts`, consumed by `apps/web/src/shortcuts.ts`, `Cockpit`, `TerminalPane`, and `terminal-shortcut-bridge`.
- No `apps/mac-satellite`, no `scripts/mac-satellite`, and no `/quick-capture` implementation or references.

Voice was originally discussed as scratchpad capture, but the grilling session changed the model: voice is a global dictation input method. Scratchpad is one target. On desktop/PWA, `Shift+Cmd/Ctrl+D` should start dictation and route text into the focused target. On mobile, the fast idea path is: bare-root launch opens scratchpad, tap mic in the composer, speak, and auto-submit a block.

Browser contract for v1:

- Voice mode is enabled only in secure browser contexts with `SpeechRecognition` or `webkitSpeechRecognition` present.
- Mic buttons render only when that support check passes.
- Unsupported browsers show no mic entry point; if a shortcut is pressed anyway, Citadel shows an unavailable state rather than falling back to scratchpad.
- Browser-specific behavior is verified by manual QA for Chrome desktop, Chrome PWA/standalone, Safari desktop, iOS Safari, iOS PWA, Android Chrome, and Firefox desktop. The implementation must not assume support in a browser that fails runtime detection.
- If a supported-looking browser rejects `start()` because shortcut activation or permission is insufficient, the overlay keeps the original target snapshot and shows a retry/start mic button that the user can click.

File-size precheck:

- `apps/web/src/scratchpad-panel.tsx` is 799 lines on main. Extract before adding mic/target registration.
- `apps/web/src/cockpit.tsx` is 799 lines on main. Avoid touching it for voice mode; Shell-level voice handling should keep Cockpit out of the change.
- `apps/web/src/terminal-pane.tsx` is 708 lines on main. Terminal voice additions are acceptable there, but keep them focused.

## Spec Alignment

| Spec | Applies | Required update |
|------|---------|-----------------|
| `specs/B.2-ade-cockpit.md` | Yes | Extend the existing `Keyboard Shortcuts` section with `Shift+Cmd/Ctrl+D` voice dictation and browser-delivery caveat. Extend the existing `Scratchpad` section with mobile bare-root `/?scratchpad=1` auto-open, composer mic entry, and focus behavior. |
| `specs/B.3-agent-sessions-terminal.md` | Yes | Add terminal voice-target behavior under the current in-process xterm/WebSocket terminal spec: terminal focus forwards the voice shortcut to Shell, committed text is injected through the terminal WebSocket path, and auto-submit appends Enter exactly once. |
| `specs/C-technical-stack.md` | Minimal | Keep native desktop helper apps out of scope if the spec needs a reminder; do not reintroduce Mac satellite scope. |
| `specs/B.7-operations-activity-mcp.md` | No code scope | Do not add `/quick-capture`; current main has removed that surface. |
| `specs/A-shared-definitions.md` | Glossary only | Use "Workspace session", "Agent session", and "Terminal profile" consistently. No new domain term needs definition. |

Spec updates are the first implementation step because the requested behavior adds new user-facing keyboard, mobile, and terminal behavior.

## Implementation Approach

Implement one web-only voice-mode system, mounted at Shell level, with target adapters for registered Citadel surfaces, generic text-like `input`/`textarea` editables, and terminal handles.

The core pieces:

- A pure Web Speech controller wrapping `SpeechRecognition` / `webkitSpeechRecognition`. It requires `window.isSecureContext`, sets `lang = "en-US"`, separates interim and final transcripts, commits only final transcript, arms `FINAL_AUTO_SUBMIT_DELAY_MS = 900` after final text, and stops after one commit. It also keeps `NO_RESULT_SILENCE_TIMEOUT_MS = 10_000`, measured from start until the first recognition result and then from the most recent recognition result.
- A `VoiceModeProvider` mounted in `apps/web/src/main.tsx` near `ScratchpadPanel`. It owns recording state, persisted `autoSubmit` setting, snapshotted target, final/interim transcript, copyable fallback buffer, and global floating control.
- A voice target registry in web code. Components can register explicit insert/submit behavior for their DOM node. If no registered target matches, the engine falls back only to generic `textarea` and text-like non-sensitive `input` insertion (`text`, `search`, `email`, `tel`, `url`). Generic `contenteditable` is excluded from v1 unless a Citadel surface registers a voice adapter.
- Shortcut integration through the current canonical shortcut path. Add a `voice-dictation` shortcut id to `packages/contracts/src/shortcuts.ts` with `modifier: "primary"`, `shift: true`, `key: "d"`, and include it in `FORWARDABLE_SHORTCUT_IDS`.
- Non-terminal shortcut handling lives in Shell/VoiceProvider, not Cockpit. The provider listens at capture phase, recognizes only `voice-dictation`, prevents default, snapshots the focused target, and starts voice mode.
- Terminal focus reuses the existing terminal shortcut bridge only to notify Shell that `voice-dictation` was pressed while xterm had focus. Dictated text delivery goes through the registered `TerminalHandle`, which writes to the terminal WebSocket; auto-submit appends exactly the same Enter-equivalent sequence as keyboard Enter.
- Scratchpad composer mic button uses the same provider and explicitly passes the composer as the target. It does not run its own speech-recognition logic.
- Mobile bare-root bootstrap runs before `bootstrapLastRoute`. If `window.location` is exactly bare root and `matchMedia("(max-width: 820px)")` matches, replace the URL with `/?scratchpad=1`; then the existing Shell query-param behavior opens the panel. Existing `/scratchpad` route normalization remains route-owned and separate. Any search/hash deeplink wins over the mobile default.

No server transcription, audio upload, native desktop helper, OS-global shortcut, `/quick-capture`, or spoken-command parser is included in v1.

## Alternatives Considered

- **Scratchpad-specific speech hook:** rejected because voice mode must target regular sessions and whatever field is focused.
- **Agent message API for agent sessions:** rejected because the requirement is focused terminal/session input, and plain terminals need the same behavior.
- **Separate mobile scratchpad page:** rejected because the existing Shell-level panel already owns blocks, composer, history, search, refine, SSE refresh, and URL state.
- **Auto-submit off by default:** rejected because the user wants to test the fast path immediately. The default remains on, with a persistent toggle.
- **Server-side transcription:** rejected for v1 because browser Web Speech API is good enough and avoids audio upload/privacy plumbing.
- **Native Mac satellite:** rejected by product direction.
- **Parallel voice shortcut matcher:** rejected after the main precheck because current main has canonical shortcut data in `packages/contracts/src/shortcuts.ts`. Voice must join that path to keep Shell, terminal forwarding, and tests in sync.

## Implementation Steps

### 0. Branch hygiene

- Work from a clean branch based on current `origin/main`, e.g. `fb-scratchpad-capture-voice-mobile`.
- Do not apply the old `pre-main-pull scratchpad-capture-voice-mobile` stash.
- Do not carry Mac satellite or `/quick-capture` cleanup diffs; current main already removed those surfaces.
- The voice/mobile PR should not change `pnpm-lock.yaml` or `pnpm-workspace.yaml` unless implementation unexpectedly adds a dependency. No dependency is expected.

### 1. Spec updates first

- Update `specs/B.2-ade-cockpit.md` in the existing `Keyboard Shortcuts` and `Scratchpad` sections.
- Update `specs/B.3-agent-sessions-terminal.md` in the existing `Terminal` section.
- Avoid `/quick-capture` references; that surface is gone on main.

### 2. Code reconnaissance and file-size protection

- Inspect current patterns for Shell-level providers, localStorage-backed stores, shortcut registry tests, terminal handle publication, scratchpad panel tests, and Playwright mobile projects.
- Verify browser shortcut delivery for `Shift+Cmd+D` / `Shift+Ctrl+D` with a tiny local event-capture page or Citadel dev build before depending on the chord. Check Chrome desktop, Chrome PWA/standalone, Safari desktop, Firefox desktop, iOS Safari/PWA where hardware keyboard is available, and Android Chrome if hardware keyboard is available. If a required desktop/PWA browser swallows the chord, pause implementation and get a user-approved fallback shortcut.
- Add characterization coverage for current scratchpad composer behavior before extraction: submit-on-Cmd/Ctrl-Enter, blur submit, autosize, error rendering, focus behavior.
- Extract composer markup/handlers from `apps/web/src/scratchpad-panel.tsx` into `apps/web/src/scratchpad-composer.tsx` or a small hook/component pair.
- Keep extraction behavior-preserving and confirm no non-generated source file exceeds 800 lines.

### 3. Voice recognition core

- Add `apps/web/src/lib/speech-recognition-controller.ts` with support detection, secure-context gating, prefixed/unprefixed API selection, `en-US` setup, interim/final handling, concrete timers, synchronous `.start()` errors, permission/capture errors, and disposal.
- Model state distinctly: unavailable, idle, listening, start-retry-required, permission-denied/no-transcript, capture-error-with-partial-transcript, final-captured/no-target, committed, and cancelled.
- Add `apps/web/src/lib/use-speech-recognition.ts` only if React adaptation is non-trivial.
- Use no new dependencies.
- `apps/web` must not import `@citadel/daemon` or daemon implementation modules. Any daemon communication remains through existing API/contracts/WebSocket paths and is enforced by `scripts/checks/architecture-boundaries.ts`.

### 4. Voice target registry and insertion semantics

- Add `apps/web/src/lib/voice-targets.ts`.
- Define target kinds: registered editable target, generic text-like `input`/`textarea` target, terminal target, and no-target buffer.
- Registered target API supports `insertText(text)`, `getDraft()`, optional `submit()`, and `canAcceptVoiceCommit()`.
- Generic text-like `input`/`textarea` insertion uses the native `HTMLInputElement` / `HTMLTextAreaElement` value setter, `setRangeText` where appropriate, dispatches `InputEvent`/`input`, replaces selected text where browser selection APIs exist, and preserves caret after inserted text where supported.
- Generic editables never call nearest-form `requestSubmit()` in v1. They always report inserted-not-submitted when auto-submit is enabled.
- Contenteditable support is limited to explicitly registered Citadel surfaces with a concrete adapter.
- Registered submit-safe targets submit from a computed post-insertion draft or DOM value, not stale React state.

### 5. Voice mode provider and floating control

- Add `apps/web/src/voice-mode-provider.tsx`, `apps/web/src/voice-mode-overlay.tsx`, and a small store/helper split as needed to stay below file-size limits.
- Persist auto-submit in localStorage, defaulting to true.
- Start modes:
  - shortcut start: resolve current focused target and snapshot it.
  - button start: use the explicit target passed by the button.
  - terminal start: use the forwarded session id and terminal handle.
- Overlay displays listening state, interim transcript, final transcript/buffer, auto-submit toggle, stop, cancel, copy, retry, and error state.
- Overlay focus policy: do not autofocus overlay controls on start; snapshot target before rendering voice UI; keep the active capture target immutable unless the user cancels and starts over.
- Accessibility: controls are keyboard reachable, icon buttons have labels, status/errors use `aria-live`, and focus-visible styles remain visible.
- If target disappears, becomes disabled/read-only/hidden, changes session identity, disconnects, or no target exists, preserve text in a copyable buffer and ignore auto-submit.
- Cleanup timers/listeners on provider unmount, route changes, target unregister, controller disposal, and recording cancel/stop.

### 6. Shortcut and terminal forwarding

- Update `packages/contracts/src/shortcuts.ts`:
  - Add `ShortcutId` value `"voice-dictation"`.
  - Add `{ id: "voice-dictation", modifier: "primary", shift: true, key: "d" }` to `SHORTCUT_CHORDS`.
  - Include `"voice-dictation"` in `FORWARDABLE_SHORTCUT_IDS`.
- Update `apps/web/src/shortcuts.test.ts` with positive `Shift+Cmd+D` / `Shift+Ctrl+D` cases and negative `Shift+Cmd+V`, unshifted `Cmd+D`, and Alt variants.
- Add Shell/VoiceProvider capture-phase keydown handling for `voice-dictation`. Keep Cockpit unchanged unless type changes force a no-op branch in `resolveShortcutAction`.
- Update `apps/web/src/terminal-shortcut-bridge.ts` so `voice-dictation` is parseable from terminal messages but is treated like a Shell-owned action, not a Cockpit action. `terminalShortcutMatch()` should return `null` for `voice-dictation`, like it does for `scratchpad-toggle` and `new-workspace`.
- Extend `apps/web/src/main.tsx` Shell message handling to start voice mode for terminal session ids after `isRegisteredTerminalMessageSource` accepts the message.
- Extend `TerminalHandle` with `sendVoiceInput(text, { submit })`. Implementation writes text through the existing WebSocket input path.
- Terminal auto-submit must reuse the exact existing keyboard Enter path/sequence and append it exactly once. Verify the current xterm/WS sequence before implementing.
- If shortcut-start fails due to browser activation/permission, leave overlay open with the target snapshot and a click-to-start retry control.

### 7. Scratchpad mic and mobile first-view behavior

- Add a reusable `VoiceCaptureButton` component that renders `null` when Web Speech API is unavailable and uses lucide `Mic` / `MicOff`.
- Wire the extracted scratchpad composer to register a voice target with `submitComposer`, and render the mic button in the composer row. Button-origin starts explicitly target the composer.
- If block editor support is low-cost after target registry exists, register block editors too. Otherwise shortcut-origin dictation into a focused block editor still works via generic textarea insertion, but auto-submit reports inserted-not-submitted unless registered.
- Add a mobile bootstrap helper near `apps/web/src/lib/last-route.ts` or `main.tsx` and call it before `bootstrapLastRoute`.
- Predicate: client-only, pathname `/`, empty search, empty hash, `matchMedia("(max-width: 820px)").matches`. On match, `replaceState(null, "", "/?scratchpad=1")`.
- Keep `/scratchpad` route normalization owned by `apps/web/src/routes/scratchpad.tsx`.
- Update scratchpad drawer CSS so the modal is full-screen at `(max-width: 820px)`, not only 767px.
- Preserve composer focus on open and verify mobile auto-open reaches that path.

### Migration Strategy

No database schema changes. No DDL, no `schema_migrations` row, no foreign-key posture change, and no operator database data migration.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Speech controller, voice target registry, provider state, overlay, shortcut registry update, terminal bridge/TerminalPane behavior, scratchpad composer extraction/target registration, and mobile bootstrap helper all need deterministic tests. |
| E2E (Playwright) | Required | Browser flows must prove mobile root opens scratchpad, deeplinks are not eaten, desktop shortcut opens voice UI with mocked Web Speech API, and scratchpad mic creates a block with auto-submit. |
| Manual browser QA | Required | Web Speech permission UX and shortcut delivery cannot be trusted from headless tests alone. |

### New tests to add

- `apps/web/src/lib/speech-recognition-controller.test.ts` — support detection, secure-context gating, prefixed API, `en-US`, interim/final handling, timers, start errors, permission errors, retry state, disposal.
- `apps/web/src/lib/voice-targets.test.ts` — text-like input/textarea insertion, selected replacement, native setter updates React-controlled inputs, input event dispatch, generic no-submit behavior, no-target fallback, disconnected/disabled/read-only/hidden fallback, registered submit-safe draft submission.
- `apps/web/src/voice-mode-provider.test.tsx` — auto-submit default true, localStorage persistence, shortcut target snapshot, start rejection retry, button explicit target, no-target buffer, cleanup on unmount/route change/target unregister, cancel/stop behavior.
- `apps/web/src/voice-mode-overlay.test.tsx` — listening/interim/final/error/copy/toggle/retry states, keyboard operability, labels, `aria-live`, non-autofocused overlay policy.
- `apps/web/src/components/voice-capture-button.test.tsx` — hides when unsupported or insecure, click starts provider with explicit target, accessible label/pressed state.
- `apps/web/src/scratchpad-composer.test.tsx` — characterization/extraction behavior plus mic target registration when supported.
- `apps/web/src/lib/mobile-scratchpad-bootstrap.test.ts` or `apps/web/src/lib/last-route.test.ts` additions — narrow bare root becomes `/?scratchpad=1`; wide bare root falls through to `bootstrapLastRoute`; root with search/hash and non-root paths are untouched; saved `/settings` does not override mobile bare-root scratchpad.

### Existing tests to update

- `apps/web/src/shortcuts.test.ts` — add canonical `voice-dictation` cases and uniqueness/forwardable assertions.
- `apps/web/src/terminal-shortcut-bridge.test.ts` if present, otherwise add coverage near the bridge — parse `"voice-dictation"` from current origin/session id, reject wrong origin/source, and ensure `terminalShortcutMatch()` returns `null` for Shell-owned voice action.
- `apps/web/src/terminal-pane.test.ts` — `Shift+Cmd/Ctrl+D` while terminal has focus posts `"voice-dictation"` and sends no terminal bytes; existing raw input, paste, Ctrl+C, Cmd+Backspace, Shift+Enter, scroll, and cockpit shortcut tests remain green.
- `apps/web/src/terminal-pane-basic.test.ts` or a focused new terminal handle test — `TerminalHandle.sendVoiceInput("hello", { submit:false })` writes only text; `{ submit:true }` writes text plus exactly one Enter-equivalent sequence; handle is session-scoped and disconnected handles fall back to copyable buffer.
- `apps/web/src/main.tsx`/Shell tests if a Shell test exists, otherwise provider tests should cover Shell message handling for terminal-origin voice.
- `e2e/scratchpad-editor.spec.ts` may gain an assertion that `/?scratchpad=1` still opens the panel after mobile bootstrap changes.

### E2E tests

- `e2e/scratchpad-mobile.spec.ts` — mobile project, bare `/` lands on `/?scratchpad=1`, scratchpad panel visible, composer visible/focused where browser allows, mic button visible when fake Web Speech API is injected, mic target at least 36x36.
- `e2e/scratchpad-mobile-deeplink.spec.ts` — mobile project, `/?modal=new-workspace` and `/#hash` are not rewritten to scratchpad.
- `e2e/voice-mode.spec.ts` — inject fake `webkitSpeechRecognition`, focus scratchpad composer or another Citadel field, press `Shift+Cmd/Ctrl+D`, emit interim/final fake results, assert overlay preview and committed final text. With auto-submit off, text remains inserted. With auto-submit on in scratchpad composer, a new scratchpad block appears.
- Optional if cheap: terminal voice smoke against a seeded terminal session; otherwise keep terminal behavior at Vitest and document the E2E gap.

### Manual browser QA

- Before implementation depends on `Shift+Cmd+D`, verify keydown delivery for Chrome desktop, Chrome PWA/standalone, Safari desktop, Firefox desktop, and any hardware-keyboard mobile environment available. If a required browser swallows the chord, stop and pick a user-approved fallback shortcut.
- Verify first-use permission prompt, denied permission, previously granted permission, retry-from-click after shortcut failure, unavailable browser behavior, and insecure-context behavior in Chrome desktop, Safari desktop, iOS Safari/PWA, Android Chrome, and Firefox desktop.
- Record the manual QA artifact in the implementation notes or PR description with browser/PWA matrix, date, shortcut result, supported/unavailable state, first-use prompt, denied permission, retry-from-click, and insecure-context outcome.

### Implementation QA note — 2026-06-05 UTC

- Automated coverage completed with mocked Web Speech API: `make check`, `make e2e`, and `make performance`.
- Real-browser microphone permission/runtime QA was not executed in this local agent environment. The PR QA artifact must still record Chrome desktop, Chrome PWA/standalone, Safari desktop, Firefox desktop, iOS Safari/PWA, Android Chrome, and any hardware-keyboard mobile checks before merge.

### Assertions to add/change/tighten

- Voice never commits interim transcript.
- Auto-submit commits the whole current draft, not only the newly dictated phrase.
- Auto-submit default is true before any localStorage value exists.
- Turning auto-submit off during recording affects the current commit.
- No-target capture never writes to scratchpad.
- Generic text-like `input`/`textarea` targets never submit forms.
- React controlled inputs receive native setter plus input event and retain dictated value.
- Shortcut-start rejection keeps the snapshotted target and exposes click-to-retry.
- Provider unmount, route change, target unregister, and controller disposal clear timers/listeners and do not commit later.
- Terminal voice shortcut does not emit literal `D`/modifier bytes to xterm.
- Terminal auto-submit appends Enter exactly once.
- Mobile bootstrap runs before last-route restoration.
- Deeplinks with any search/hash are preserved exactly.
- Scratchpad composer mic is absent when Web Speech API is unavailable.

### Terminal-completeness gate

This plan touches terminal input. Coverage must explicitly preserve:

- Raw input: existing `apps/web/src/terminal-pane.test.ts` raw `term.emitData("abc")` remains green.
- Control/meta sequences: extend terminal tests with `Shift+Cmd/Ctrl+D` forwarding and keep Cmd+C/Cmd+V/Cmd+Backspace/Shift+Enter assertions.
- Paste: existing paste test remains green; voice insertion uses a separate handle method and must not affect paste.
- Resize: existing `apps/web/src/terminal-pane-resize.test.ts` remains green.
- Long output/scrollback: existing scrollback/reconnect coverage remains green.
- Alternate screen: existing terminal package alternate-screen tests remain green.
- Reconnect: disconnected terminal handle falls back to copyable buffer.
- Cross-session isolation: voice input is sent only to the target session handle.

## Tests

TDD order:

1. Update specs listed in Spec alignment.
2. Run code reconnaissance and shortcut delivery probe; stop for user fallback if `Shift+Cmd+D` is swallowed in required desktop/PWA browsers.
3. Add scratchpad composer characterization tests, then extract the composer.
4. Add speech controller tests, then implement controller/hook.
5. Add voice target tests, then implement target registry.
6. Add provider/overlay/button tests, then implement voice mode UI.
7. Update shortcut registry/bridge/terminal tests, then implement shortcut forwarding and terminal input handle.
8. Add mobile bootstrap tests, then implement pre-last-route mobile `/?scratchpad=1` behavior.
9. Add scratchpad composer mic tests, then wire the composer target and mic.
10. Add Playwright mobile and mocked voice flows.
11. Run manual browser QA matrix for shortcut delivery and Web Speech permission/runtime behavior.

## Schema Or Contract Generation

No schema generation. No database migration. The canonical shortcut contract changes in `packages/contracts/src/shortcuts.ts`; no generated artifacts are required.

## Verification

- `make check` — required comprehensive gate: architecture boundaries, file size, typecheck, lint, Vitest, coverage, dependency policy, build.
- `make e2e` — required for mobile scratchpad and browser voice flows.
- `make performance` — required because the plan touches pre-router startup behavior and terminal hot-key input paths. Expected posture: no speech controller construction before first use, no startup network dependency, and O(1) keydown work for global and terminal handlers.
- Manual browser QA matrix above — required before handoff because headless automation cannot prove real Web Speech permission UX or reserved browser shortcut delivery.
