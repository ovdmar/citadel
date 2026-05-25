Activate the /implement-task skill first.

# Plan: Scratchpad capture — voice, mobile, Mac satellite (Phase 1)

## Acceptance Criteria

Derived verbatim from the source scratchpad block:

- [ ] AC1 — Voice mode: easy iPhone-first capture into the scratchpad.
- [ ] AC2 — Mobile: scratchpad is the first view that opens.
- [ ] AC3 — Mac satellite: a global shortcut (e.g. `cmd+shift+s`) opens a Spotlight-like scratchpad capture.
- [ ] AC4 — Mac satellite: a separate shortcut shows the native "new workspace" menu so an agent can be started without opening the cockpit.

Phase-1 operationalised acceptance criteria (what the implementation in this PR delivers):

- [ ] AC1a — In the cockpit scratchpad composer, a microphone button is visible when the browser exposes a Web Speech API (`SpeechRecognition` or `webkitSpeechRecognition`, including iOS Safari). Tapping it starts recognition; live results append to the composer text. Tapping again, blurring the composer, or 5s of silence stops it. If neither API is exposed, the button is not rendered (no broken UI).
- [ ] AC2a — On viewports matching `(max-width: 820px)`, navigating to the cockpit root with an **otherwise-bare URL** (no search, no hash) immediately routes the user to `/scratchpad`. The redirect runs only when `isBareRootLanding(window.location)` is true (mirroring the existing helper in `apps/web/src/lib/last-route.ts:57`) so any deep-link search/hash combination — including `/?modal=new-workspace` — continues to land on the cockpit. On wider viewports, `/` continues to render the cockpit dashboard unchanged.
- [ ] AC2b — At 375px width (iPhone reference), the scratchpad layout is usable without horizontal scroll: composer is pinned to the bottom respecting `env(safe-area-inset-bottom)`; tap targets (mic, delete, save) are ≥ 36×36 logical px; history sidebar is hidden by default behind a toggle button in the page header.
- [ ] AC3a — The daemon serves a standalone HTML page at `GET /quick-capture` (no React Router, no cockpit chrome): a single autofocused `<textarea>`, the same mic button as the composer, ⌘/Ctrl-Enter to submit, Esc to attempt `window.close()`. On submit, the page POSTs to `POST /api/scratchpad/blocks`. **Close behavior:** In Chrome `--app=` mode (the helper-script default), `window.close()` succeeds and the window dismisses. In Safari fallback (`window.close()` is a no-op on non-script-opened windows), the page replaces the textarea with an inline `Captured. Press ⌘W to close.` confirmation. Failures display inline and keep focus in the textarea so the user can retry.
- [ ] AC3b — `scripts/mac-satellite/quick-capture.sh` opens the daemon's `/quick-capture` URL in a Spotlight-shaped chromeless window (Chrome `--app=` mode if Chrome is installed, else Safari fallback) sized roughly 640×220, centred on the active screen. **Daemon target:** the systemd long-term daemon on `127.0.0.1:4010` (overridable via `CITADEL_HOST` / `CITADEL_PORT` env vars). Worktree-isolated daemons (4110–4209 per CLAUDE.md) are out of scope for the satellite shortcuts — the README documents this and the rationale (a global shortcut cannot infer which worktree is "active"). Script exits non-zero with a helpful message if the daemon is not running.
- [ ] AC4a — `scripts/mac-satellite/new-workspace.sh` opens the cockpit at `/?modal=new-workspace`. The cockpit recognises that query parameter on mount and auto-opens the existing Create Workspace modal. After the modal closes (created or cancelled) the query parameter is stripped from the URL so a page refresh doesn't re-open it.
- [ ] AC4b — `scripts/mac-satellite/README.md` documents how to bind each script to a global shortcut via Hammerspoon (recommended) and macOS Shortcuts.app (fallback), and explains the prerequisite that the user's local Citadel daemon is reachable.

**Out of scope (deferred to a follow-up plan).** Shipping an actual native `.app` shell (Tauri or Electron) that registers global shortcuts itself. The web-served `/quick-capture` page plus thin helper scripts deliver the user-facing UX in this PR without adding a Rust/Electron toolchain to CI. The follow-up will wrap the same `/quick-capture` page in a native shell and reuse the `?modal=new-workspace` deeplink, so this PR's surface area is forward-compatible.

## Context and problem statement

The Citadel scratchpad is currently capture-from-cockpit-only:

- The web cockpit (apps/web, Vite + React + TanStack Router) renders `/scratchpad` (`apps/web/src/routes/scratchpad.tsx`) as a block list with a pinned composer. It calls `POST /api/scratchpad/blocks` to add a block and `PUT /api/scratchpad/blocks/:id` to edit.
- The daemon (`apps/daemon/src/scratchpad-routes.ts`) backs a single global scratchpad stored at `config.dataDir/scratchpad.md` (NB: `specs/B.7-operations-activity-mcp.md` still calls this "per-workspace" — see Spec alignment below).
- The cockpit has partial mobile responsiveness (`apps/web/src/styles.css` has a `@media (max-width: 820px)` block that activates the mobile column switcher) but the root path (`/`) always renders the desktop-oriented dashboard, and the scratchpad route has no mobile-specific tightening of its own.
- There is no voice capture anywhere in the cockpit.
- There is no off-cockpit capture surface — no quick-capture URL, no helper scripts, no native shell.

The user wants three new capture paths to land:

1. Voice transcription on iPhone (so an idea can be dictated into the scratchpad without typing).
2. The scratchpad as the default mobile view (so opening Citadel on iPhone lands directly on capture, not the dashboard).
3. A Mac "satellite" surface — Spotlight-style quick capture under a global shortcut, plus a separate shortcut for launching a new workspace without the full cockpit.

The Mac-native global-shortcut requirement normally implies a `.app` bundle (Tauri or Electron with `globalShortcut`). That carries significant ongoing cost: Rust toolchain in CI, code signing, notarization, packaging, app updater. Doing that in one PR while also shipping the voice + mobile work is high risk and would over-extend `/implement-task`'s self-review and CI loop.

Phase 1 — this plan — therefore unbundles the requirement into two layers:

- **A web-served capture page** that the cockpit's existing daemon hosts (`GET /quick-capture`). It already has the keyboard ergonomics (⌘+Enter submit, Esc close, autofocus textarea, mic button). Hosted in the daemon means the same page works from any device on the LAN — iPhone, iPad, secondary Mac.
- **Two thin shell scripts** that wrap the page into a Spotlight-shaped chromeless popup (Chrome `--app=` mode, with Safari fallback) and that open the cockpit pre-deeplinked to the Create Workspace modal. The user binds them to `cmd+shift+s` and a sibling shortcut via Hammerspoon (one-liner) or macOS Shortcuts.app (a screenshot in the README).

Phase 2 — out of scope for this PR — wraps the same `/quick-capture` page in a Tauri shell that also owns the global-shortcut registration. The Phase 1 design is intentionally forward-compatible so Phase 2 reuses the same URL and the same deeplink.

## Spec alignment

| Spec | Touch | Action |
|------|-------|--------|
| `specs/B.2-ade-cockpit.md` (Scratchpad section) | New behavior: viewport-narrow root redirect; new mic affordance on composer; mobile-tightened layout (composer pinned with safe-area, history sidebar collapsed behind toggle). | **Spec update required.** First implementation step. Add: (a) the mobile-default-route rule, (b) the voice capture button & graceful absence on unsupported browsers, (c) the mobile layout notes. |
| `specs/B.7-operations-activity-mcp.md` (Scratchpad section) | New daemon HTTP endpoint `GET /quick-capture` (HTML page, not part of `/api/*`). New cockpit deeplink `?modal=new-workspace`. | **Spec update required.** First implementation step. Add: the quick-capture page as a daemon-served HTML surface that submits via the existing `POST /api/scratchpad/blocks` (no new public API endpoint). Mention the cockpit deeplink under the cockpit-routing description. Also fix the stale wording — line 64 currently says "per-workspace `scratchpad.md`" but the implementation stores a single global file at `config.dataDir/scratchpad.md`; reword to match reality without changing behavior. |
| `specs/B.1-repositories-workspaces.md` | New cockpit deeplink to the Create Workspace modal (UX entry into existing flow). | **Spec update required.** Note the new query-param entry point (`/?modal=new-workspace`) in the workspace creation UX subsection. No API or storage changes. |
| `specs/C-technical-stack.md` | `scripts/mac-satellite/` directory of shell helpers; no new build-pipeline deps. | **Spec update required.** Brief note under the scripts/tooling subsection that `scripts/mac-satellite/` exists, what it targets (macOS), and that it is intentionally **not** wired into `make check` (it cannot run in CI). |

**Domain glossary check** (specs/A-shared-definitions.md): the new surfaces are *capture* affordances into the existing scratchpad. Plan text uses Scratchpad, Block, Workspace as defined. No new domain terms.

**Term to reuse, not invent:** "quick-capture" (lowercase, hyphenated) consistently for the standalone page and the Mac shortcut surface, to avoid spawning a new noun.

## Implementation approach

Three parallel-shippable workstreams that all submit through the same existing `POST /api/scratchpad/blocks` endpoint, so no new API surface for the scratchpad is added — only one new HTML-serving endpoint and a small cockpit deeplink:

1. **Voice capture (cockpit web only).**
   - A new `useSpeechRecognition` hook in `apps/web/src/lib/use-speech-recognition.ts` that wraps `window.SpeechRecognition ?? window.webkitSpeechRecognition`. It exposes `{ supported, listening, start(), stop(), transcript, error }`. The hook is responsible for the silence timer (default 5000 ms), and for cleaning up on unmount.
   - A new presentational `<VoiceCaptureButton>` component (`apps/web/src/components/voice-capture-button.tsx`) that takes `onTranscript(text: string)` and `onError(message: string)`. Renders `null` when `!supported`. Uses lucide-react `Mic` / `MicOff` icons matching existing icon style. Includes the live "listening…" pulse and an accessible label.
   - Wire the button into the composer in `apps/web/src/routes/scratchpad.tsx` (append transcript with a leading space if composer non-empty) and into each block editor (append to `draft`). Wire the same button into the `/quick-capture` page.
   - On user-facing errors (no permission, `network`, `audio-capture`), surface a transient inline message under the composer for ~4s.

2. **Mobile-first routing.**
   - A new `mobileScratchpadRedirect` helper (`apps/web/src/lib/mobile-redirect.ts`) — pure function `(pathname, mediaQueryMatches) => "/scratchpad" | null` — used both by a top-level router `beforeLoad`-style guard and by an idempotent effect in `Cockpit` that re-checks on mount.
   - Mount the guard in `main.tsx` on `indexRoute` (path `/`) only. On viewports matching `(max-width: 820px)` redirect to `/scratchpad`; otherwise pass through. Deep links to any other route are untouched.
   - Tighten `apps/web/src/scratchpad.css` for narrow viewports inside an existing or new `@media (max-width: 820px)` block: the history sidebar is hidden by default with a small "History" toggle in the page header; composer respects `padding-bottom: max(12px, env(safe-area-inset-bottom))`; mic/delete/save tap targets ≥ 36×36; the page itself becomes a single-column flex stack.
   - Cross-cutting: ensure `apps/web/index.html` already declares `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`. If `viewport-fit=cover` is missing, add it (without it `env(safe-area-inset-bottom)` reads 0 on iOS).

3. **Quick-capture page + Mac helper scripts.**
   - New daemon route module `apps/daemon/src/quick-capture-route.ts`: `GET /quick-capture` serves a self-contained HTML document (inline CSS + inline JS, no bundler involvement) that the daemon renders from a string constant. The page calls the existing `POST /api/scratchpad/blocks` with `{ text }` and on success calls `window.close()`. On failure it shows an inline error and keeps focus. The mic button uses the same `webkitSpeechRecognition` code path as the cockpit but inlined (no shared bundle dependency, since this page must be served standalone).
   - Register the route from `apps/daemon/src/app.ts` next to the existing scratchpad routes registration. Order matters: register **before** the SPA fallback at line 754 so `/quick-capture` is not swallowed by `res.sendFile(index.html)`.
   - New cockpit deeplink handler in `apps/web/src/cockpit.tsx` (or `main.tsx`): on mount, if `URLSearchParams` has `modal=new-workspace`, auto-open the existing `CreateWorkspaceModal` and strip the param from the URL via `history.replaceState`.
   - New `scripts/mac-satellite/quick-capture.sh` — POSIX shell, no dependencies beyond `curl` and macOS' `open` / `osascript`. Probes the daemon health endpoint (`/api/health` if it exists, else `/api/scratchpad`); if reachable, opens the URL via Chrome `--app=` if Chrome present, else Safari. Centers on the active display via AppleScript-derived screen dimensions. Configurable via env vars `CITADEL_HOST` (default `127.0.0.1`) and `CITADEL_PORT` (default `4010`, but the script reads `.citadel/dev.json` first if present so it works in a worktree).
   - New `scripts/mac-satellite/new-workspace.sh` — same daemon-resolution logic; opens `/?modal=new-workspace` in the user's default browser (the user keeps a cockpit tab pinned in their normal browser).
   - New `scripts/mac-satellite/README.md` — wiring instructions for Hammerspoon (5-line Lua snippet binding `cmd+shift+s`) and Shortcuts.app (5-step recipe). Calls out that the user is responsible for granting Accessibility permission to Hammerspoon if used.

## Alternatives considered

1. **Ship a native Tauri/Electron `.app` in this PR (rejected).** Adds a Rust or Node-side build pipeline, code-signing flow, notarization step, and a non-trivial update story. None of those things are usefully test-covered by `make check` and none can run on Linux CI. The user gets a noisier PR, more risk of CI failure, longer review, and zero additional capture capability beyond what the web-served page + helper scripts deliver. The follow-up plan that does ship a `.app` will reuse the `/quick-capture` page and `?modal=new-workspace` deeplink unchanged.
2. **Make the entire cockpit a PWA and rely on iOS "Add to Home Screen" for mobile (rejected for now).** Conceptually attractive (works offline, full-screen on iPhone). But it adds a service worker, asset versioning, install prompt copy, and an icon-set design — none of which is required to satisfy AC1/AC2. Keep the scope to "the cockpit's mobile breakpoint defaults to scratchpad". Revisit in a follow-up once the user has lived with this for a week.
3. **Use a third-party transcription API (Whisper, Deepgram) instead of the Web Speech API (rejected).** Adds an API key requirement, billing surface, network round-trip, and a non-trivial server proxy (sending mic audio bytes to a third-party). Web Speech API works on iOS Safari natively. Quality is "good enough" for note-capture; the user can always edit. Worth revisiting only if real users hit transcript quality issues.
4. **Per-workspace scratchpads in the URL (`/quick-capture?workspaceId=…`) (rejected for now).** Code uses a single global `scratchpad.md` at `config.dataDir`. Per-workspace requires an extra storage refactor that's out of scope. The plan flags the stale "per-workspace" wording in B.7 as a spec fix, but does not change behavior.
5. **A new HTTP endpoint specifically for voice/quick capture (`POST /api/quick-capture`) (rejected).** The existing `POST /api/scratchpad/blocks` does exactly what is needed (creates a new block with the given text, end position, with version-history coalescing). Adding a parallel endpoint splits the codepath and complicates the MCP tools' invariants. The /quick-capture page just POSTs to the existing endpoint.

## Implementation steps

> Spec updates ship first, then code, with tests written before the production code they cover (TDD). Steps are grouped so each group becomes one `Implement: …` unit in `/implement-task`.

### 0. Pre-work: split `apps/daemon/src/app.ts` to make room (must land first)

**Why this is step 0.** Today `apps/daemon/src/app.ts` is at 804 lines; `pnpm exec tsx scripts/checks/file-size.ts` reports it as 805 / 800-line cap (already 5 over the limit — confirmed against repo state). The `check:size` gate inside `make check` is therefore already red on `main`-equivalent state, and any single-line registration insert pushes it further. We must reduce app.ts before adding the new `registerQuickCaptureRoute(...)` line.

**The split.** Extract the SPA-fallback + static-asset block (currently around `apps/daemon/src/app.ts:749–756`) into a new module. **Mechanical extraction only** — preserve the existing handler shape verbatim, including the `if (req.path.startsWith("/api/") || req.path === "/events") return next();` guard inside the wildcard handler. The extraction is not a refactor; do not "simplify" the guard out, or `GET /api/unknown` would render the SPA shell instead of reaching the JSON 404 path.

- New file: `apps/daemon/src/spa-fallback-route.ts`, exporting `registerSpaFallback({ app, webDist }: { app: express.Express; webDist: string }): void`.
- Tests live in `apps/daemon/src/spa-fallback-route.test.ts`: (a) returns 200 with `Content-Type: text/html` when index.html exists for a non-API GET; (b) **`GET /api/unknown` still falls through to the JSON 404 handler — does NOT return the SPA shell** (regression guard for the guard preservation); (c) registers no routes when index.html doesn't exist (probe a known unknown path returns 404, not the SPA shell).
- Replace the inline block in `app.ts` with `registerSpaFallback({ app, webDist })`. Net reduction: ~7 lines.

**Baseline target.** After the split, `apps/daemon/src/app.ts` ≤ 795 lines (current 804 − 7 ≈ 797; refactor + 1 new import lands at ~795). The new `registerQuickCaptureRoute({ app })` line in step 4 then keeps app.ts strictly under 800. The plan's QA section now includes a verification step: run `pnpm exec tsx scripts/checks/file-size.ts` after **each** of step 0 and step 4 and confirm `apps/daemon/src/app.ts` is below 800.

This step is independent of the feature work and could ship as its own small commit inside the same PR; doing it first means the rest of the plan executes against a green file-size gate.

### 1. Spec updates (must land first)

- Update `specs/B.2-ade-cockpit.md` Scratchpad section: add the three new behaviors (mobile-default-route, mic affordance, mobile-tightened layout).
- Update `specs/B.7-operations-activity-mcp.md`: add the `GET /quick-capture` daemon-served HTML page (note: not under `/api/*`, posts to existing block endpoint); fix the stale "per-workspace `scratchpad.md`" wording to "the global `scratchpad.md` stored at `config.dataDir/scratchpad.md`"; add a **Security / trust model** subsection that documents the daemon's existing posture (bound to `127.0.0.1` by default; CORS allow-all when bound to a LAN address; no per-request auth) and states explicitly that `/quick-capture` does not change that posture — the existing `POST /api/scratchpad/blocks` is already an unauthenticated write surface, the new HTML page just makes it convenient to use. Cross-LAN exposure is operator-responsibility (e.g., SSH tunnel, VPN, or a reverse proxy that adds auth).
- Update `specs/B.1-repositories-workspaces.md`: note the `/?modal=new-workspace` deeplink under workspace-creation UX.
- Update `specs/C-technical-stack.md`: brief note that `scripts/mac-satellite/` exists, is macOS-only, and is intentionally out of `make check`.

### 2. Voice capture (cockpit)

- TDD: write `apps/web/src/lib/use-speech-recognition.test.ts` first. **Mock strategy:** the test sets `window.SpeechRecognition = MockSpeechRecognition` in `beforeEach` and deletes it in `afterEach`; no change to a global `vitest.setup.ts`. Assertions: (a) `supported` is false when neither global is present, (b) `start()` invokes recognition.start exactly once, (c) the silence timer (constant `SILENCE_TIMEOUT_MS` exported from the hook module — default 10000ms, raised from the originally-proposed 5s because real dictation includes thinking pauses) triggers `stop()` and is cleared when a result arrives or the component unmounts, (d) errors surface via `onError`, (e) **`start()` throwing synchronously** (the iOS Safari failure mode when the page is not HTTPS / the gesture-context check fails) is caught and surfaced via `onError` rather than crashing the component.
- Implement `apps/web/src/lib/use-speech-recognition.ts`.
- TDD: write `apps/web/src/components/voice-capture-button.test.tsx` covering: (a) renders null when hook reports `supported=false`, (b) renders a button with a recognisable accessible name when supported, (c) clicking toggles `listening` state, (d) calls `onTranscript` when the hook produces a transcript.
- Implement `apps/web/src/components/voice-capture-button.tsx`.
- Wire the button into `apps/web/src/routes/scratchpad.tsx` composer and per-block editor. Append transcript to composer/draft state, prefixing with a space when the existing text is non-empty.
- Add CSS for the mic button in `apps/web/src/scratchpad.css` (≥ 36×36 tap target, listening-state pulse animation, hidden text accessible label).

### 3. Mobile-first routing & layout

- TDD: write `apps/web/src/lib/mobile-redirect.test.ts` for the pure helper `mobileScratchpadRedirect(loc: Pick<Location, "pathname" | "search" | "hash">, narrow: boolean): "/scratchpad" | null`. **Semantics mirror `isBareRootLanding` from `apps/web/src/lib/last-route.ts:57`:** returns `'/scratchpad'` ONLY when `loc.pathname === '/'` AND `loc.search === ''` AND `loc.hash === ''` AND `narrow === true`; returns `null` in every other case. Test cases must include: `('/', '', '', false)` → null; `('/', '', '', true)` → `/scratchpad`; `('/', '?modal=new-workspace', '', true)` → null (must NOT eat the deeplink); `('/', '', '#foo', true)` → null; `('/scratchpad', '', '', true)` → null; `('/settings', '', '', true)` → null.
- Implement `apps/web/src/lib/mobile-redirect.ts`. Implementation may compose `isBareRootLanding` directly to keep the two helpers in sync.
- Wire the guard **synchronously in `main.tsx` before `createRouter` is constructed**, next to the existing `bootstrapLastRoute(window.location, window.history)` call at `main.tsx:137`. Use `window.matchMedia("(max-width: 820px)").matches` for the narrow check; when the helper returns a target, call `window.history.replaceState({}, '', target)` so the router picks up the corrected URL on first render. **Not a `useEffect` inside Cockpit** — that would flash the dashboard for one paint before bouncing.
- **Ordering with `bootstrapLastRoute`:** call `mobileScratchpadRedirect` **before** `bootstrapLastRoute`. Rationale: AC2 is "scratchpad is the first view that opens on mobile". A persisted desktop last-route (e.g. `/settings`) restored into the URL bar by `bootstrapLastRoute` would otherwise pre-empt the redirect (because `isBareRootLanding` would then be false). Calling the mobile redirect first guarantees a bare landing on a narrow viewport always lands on `/scratchpad` regardless of saved state; `bootstrapLastRoute` still works for desktop (matchMedia returns `matches:false`, helper returns `null`, no replaceState, bootstrap runs normally).
- Add a Vitest test alongside `main.test.tsx` (or `bootstrap-redirect.test.ts` if `main.test.tsx` doesn't exist) using a fake `window.location` + `window.history` to assert the pre-router call sequence: (a) narrow + bare URL + saved last route `/settings` in localStorage → URL ends at `/scratchpad` (mobile redirect wins); (b) wide + bare URL + saved last route `/settings` → URL ends at `/settings` (bootstrap wins); (c) narrow + `/?modal=new-workspace` → URL stays at `/?modal=new-workspace` (neither fires).
- Update `apps/web/src/scratchpad.css` mobile breakpoint to pin the composer with `padding-bottom: max(12px, env(safe-area-inset-bottom))`, hide the history sidebar by default with a "History" toggle in the page header, and ensure tap targets ≥ 36×36.
- Verify `apps/web/index.html` viewport meta includes `viewport-fit=cover`. If missing, add.

### 4. Quick-capture page (daemon)

- **Module siting decision.** `apps/daemon/src/extra-routes.ts` already exists but is `registerWorkspaceExtraRoutes` — workspace-scoped routes off `/api/workspaces/:id/...`. The quick-capture route is daemon-global and not under `/api/*` at all, so it belongs in a sibling module rather than being shoehorned into the workspace extras file. New file `apps/daemon/src/quick-capture-route.ts` is the right home, with signature mirroring `registerScratchpadRoutes` exactly:
  ```ts
  export function registerQuickCaptureRoute({ app }: { app: express.Express }): void
  ```
- TDD: write `apps/daemon/src/quick-capture-route.test.ts` covering: (a) `GET /quick-capture` returns HTML with status 200 and `Content-Type: text/html; charset=utf-8`, (b) response body contains a `<textarea>` and the literal string `/api/scratchpad/blocks` (regression guard against the endpoint being renamed without updating the inline page), (c) HEAD/POST to `/quick-capture` return 405 or a meaningful status (not the HTML page), (d) `/quick-capture/anything-else` falls through to existing handlers (no over-broad path matching — register with the exact path, not a wildcard).
- Implement `apps/daemon/src/quick-capture-route.ts`. The HTML is a string constant; CSS and JS are inlined. The JS uses `fetch('/api/scratchpad/blocks', …)` then attempts `window.close()`; if `window.opener === null` and `document.visibilityState` is still `'visible'` ~50ms after the close attempt (Safari fallback case), replace the textarea with the inline `Captured. Press ⌘W to close.` message.
- Wire registration from `apps/daemon/src/app.ts` **before** the `registerSpaFallback({ app, webDist })` call introduced in step 0.
- Add an E2E `e2e/quick-capture.spec.ts` that visits `/quick-capture`, types text, clicks submit, asserts a new block appears via the existing scratchpad API.
- After this step lands, re-run `pnpm exec tsx scripts/checks/file-size.ts` and confirm `apps/daemon/src/app.ts` is still under 800 lines.

### 5. Cockpit deeplink: `?modal=new-workspace`

- TDD: write `apps/web/src/lib/new-workspace-deeplink.test.ts` for a pure helper `shouldOpenNewWorkspaceModal(search)` that returns `true` only when `URLSearchParams(search).get('modal') === 'new-workspace'`.
- Implement the helper in `apps/web/src/lib/new-workspace-deeplink.ts`.
- Wire into `apps/web/src/cockpit.tsx`: on mount, if the helper returns true, set the existing modal state to open and call `history.replaceState({}, '', location.pathname)` to strip the param. Add a small RTL component test asserting the modal is opened and the URL is cleaned up.

### 6. Mac helper scripts

- `scripts/mac-satellite/quick-capture.sh` — POSIX shell. **Daemon target:** the systemd long-term daemon at `127.0.0.1:4010`, overridable via `CITADEL_HOST` / `CITADEL_PORT` env vars. **Worktree-isolated daemons (4110+) are deliberately not auto-discovered** — a global shortcut cannot infer which worktree the user means; the README documents this and tells worktree users to set `CITADEL_PORT` manually if they want a shortcut bound to a specific worktree. Probes liveness (curl `/api/scratchpad` with `--max-time 2 --fail`), opens the page chromelessly via Chrome `--app=` mode if Chrome is installed, else Safari fallback. Print a helpful message and exit non-zero if the daemon is unreachable.
- `scripts/mac-satellite/new-workspace.sh` — same `CITADEL_HOST` / `CITADEL_PORT` resolution (default 127.0.0.1:4010), opens `?modal=new-workspace` in the default browser.
- `scripts/mac-satellite/README.md` — Hammerspoon snippet (default) + Shortcuts.app fallback steps; a "**Trust model**" paragraph mirroring the B.7 spec language (daemon is localhost-trusted; cross-LAN exposure is operator-responsibility); a "**Worktrees**" paragraph explaining why the shortcut targets the long-term systemd daemon by default and how to point it at a worktree if needed; a note that these scripts intentionally don't run in `make check`.
- Add a tiny smoke test `apps/daemon/src/quick-capture-route.test.ts` (already in step 4) — no shell-script unit testing on Linux CI; these scripts are documented as macOS-only.

### 7. Tighten test coverage for the integration

- Add `apps/web/src/routes/scratchpad.test.tsx` (or extend an existing test file) to assert: mic button hidden when `SpeechRecognition` mock not provided; composer state mutated when `onTranscript` fires; **on narrow viewport (matchMedia mock returning `matches: true` for `(max-width: 820px)`), the History sidebar element is hidden and a History toggle button is rendered in the page header**.
- Add E2E happy-paths:
  - `e2e/scratchpad-mobile.spec.ts` — viewport 375×812 (iPhone X). Navigate to `/`; assert URL becomes `/scratchpad` and composer is the visible focused element. Assert the mic button's `boundingBox()` is ≥ `{ width: 36, height: 36 }`. Assert the History sidebar is not visible by default and the History toggle button is.
  - `e2e/scratchpad-mobile-deeplink.spec.ts` — viewport 375×812. Navigate to `/?modal=new-workspace`. Assert URL **stays** at `/?modal=new-workspace` (no mobile redirect, because the URL is non-bare), and assert the Create Workspace modal opens. (Regression guard for the BLOCKER-2 fix.)
  - Note: `env(safe-area-inset-bottom)` cannot be asserted in Playwright headless Chromium (the inset is 0 outside a real iOS environment). Deferred to manual QA.

### Migration strategy

No schema changes. The scratchpad storage format, `schema_migrations` table, and `PRAGMA foreign_keys` posture are unchanged.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Hooks (`useSpeechRecognition`), pure helpers (`mobileScratchpadRedirect`, `shouldOpenNewWorkspaceModal`), the `<VoiceCaptureButton>` component, the daemon's `quick-capture-route` handler, the daemon's new `spa-fallback-route` extraction (step 0), the pre-router redirect wiring in `main.tsx`, the cockpit deeplink mount behavior, and the narrow-viewport scratchpad layout (History toggle visible / sidebar hidden). |
| E2E (Playwright) | **Required** | (a) Mobile viewport redirect from `/` to `/scratchpad` + mic button ≥ 36×36 + History toggle present. (b) Mobile viewport + `/?modal=new-workspace` does NOT redirect; modal opens. (c) `/quick-capture` page submits a block end-to-end. The voice path itself is **not** covered by Playwright — Web Speech API is gated on real microphone permission and cannot be deterministically driven in headless Chromium; Vitest mocks the API directly. |

### New tests to add

- `apps/daemon/src/spa-fallback-route.test.ts` — extracted handler returns 200 HTML when index.html exists; absence registers nothing; `/quick-capture`-shaped paths must still 404 here (the new route registers in front of this one in `app.ts`).
- `apps/web/src/lib/use-speech-recognition.test.ts` — covers `supported=false` when no global, `start()` toggles `listening`, silence-timer fires `stop()` after `SILENCE_TIMEOUT_MS` (10000), errors propagate via `onError`, `.start()` throwing synchronously is caught and surfaced via `onError`, cleanup on unmount.
- `apps/web/src/components/voice-capture-button.test.tsx` — `null` render when unsupported; toggles listening on click; calls `onTranscript`.
- `apps/web/src/lib/mobile-redirect.test.ts` — full table per the helper semantics: returns `/scratchpad` ONLY for `({pathname:'/', search:'', hash:''}, true)`; explicitly tests that `({pathname:'/', search:'?modal=new-workspace', hash:''}, true) === null` (BLOCKER-2 regression guard); also `(…hash:'#x'…, true)`, `(/scratchpad,'','', true)`, `(/settings,'','', true)`, and `(/,'','', false)` all → null.
- `apps/web/src/main.test.tsx` (new, or `apps/web/src/lib/bootstrap-redirect.test.ts` if a `main.test.tsx` is awkward) — pre-router wiring: with `matchMedia` mock returning `matches:true`, fake `window.location='/'` + empty search + empty hash, the bootstrap calls `history.replaceState(_, _, '/scratchpad')`; with `matchMedia` returning `matches:false`, no replaceState; with `location='/?modal=new-workspace'` even on narrow, no replaceState.
- `apps/web/src/lib/new-workspace-deeplink.test.ts` — `true` only for `?modal=new-workspace`; `false` for empty, other values, missing key.
- `apps/web/src/cockpit.test.tsx` (new or extend existing) — mounting cockpit with `location.search='?modal=new-workspace'` opens the modal and strips the param from the URL via `history.replaceState`.
- `apps/daemon/src/quick-capture-route.test.ts` — `GET /quick-capture` returns HTML 200 with the right content-type and references the existing `/api/scratchpad/blocks` string verbatim; HEAD/POST behave sanely (not the HTML page); `/quick-capture/anything-else` falls through (no wildcard).
- `e2e/scratchpad-mobile.spec.ts` — 375×812 viewport navigates to `/` and ends on `/scratchpad` with composer focused; mic button `boundingBox()` ≥ {36, 36}; History sidebar hidden by default, toggle present.
- `e2e/scratchpad-mobile-deeplink.spec.ts` — 375×812 viewport navigates to `/?modal=new-workspace`; URL stays put; Create Workspace modal opens.
- `e2e/quick-capture.spec.ts` — opens `/quick-capture`, types, submits, asserts a new block surfaces in the cockpit's scratchpad view.

### Existing tests to update

- `apps/daemon/src/app.test.ts` (if it exists, else create on first new daemon-test addition) — if there's a "route registration count" smoke or a "SPA fallback returns index.html for unknown paths" test, update it to special-case `/quick-capture`.
- `apps/web/src/routes/scratchpad.test.tsx` — extend (or create) to cover the new mic affordance integration into the composer.

### Assertions to add/change/tighten

- Voice hook: assert `stop()` is called exactly once when the silence timer fires after `SILENCE_TIMEOUT_MS` (use vi.useFakeTimers). Assert `start()` throwing is caught.
- Mobile redirect helper: explicit assertion that `mobileScratchpadRedirect({pathname:'/', search:'?modal=new-workspace', hash:''}, true) === null` — regression guard for BLOCKER-2.
- Quick-capture route: response body contains the literal string `/api/scratchpad/blocks`; HEAD/POST do not return the HTML; `/quick-capture/sub` is NOT matched.
- File-size: a `make check` invocation in step 0 and again in step 4 confirms `apps/daemon/src/app.ts` is < 800 lines after each.
- Cockpit deeplink: assert `window.history.replaceState` is invoked with a URL that no longer contains `modal=new-workspace`.
- Mobile narrow layout: RTL test asserts History sidebar element has computed style `display: none` (via injecting a `matchMedia` mock that returns `matches:true`) and the History toggle button is in the DOM.

### Failure modes / edge cases / regression risks

- **Mic button on browsers without Web Speech API.** Risk: button renders but does nothing, or throws. Covered: hook returns `supported=false`, component returns `null`.
- **iOS Safari `webkitSpeechRecognition` quirks.** Requires iOS ≥ 14.5; requires HTTPS or `localhost`; `.start()` can throw synchronously when the gesture-context check fails. The button is a `<button onClick>` so the gesture is satisfied; the hook explicitly catches synchronous `.start()` throws and surfaces them via `onError`. Manual QA bullet adds the iOS-version + HTTPS requirement.
- **`window.close()` is a no-op in Safari for pages not opened via `window.open()`.** Mitigation: the quick-capture page detects this (post-fetch, attempts close, if still visible ~50ms later, swaps the textarea for an inline `Captured. Press ⌘W to close.` confirmation). Chrome `--app=` mode is the helper script's preferred path because close works there.
- **Silence timer firing while the user is composing.** `SILENCE_TIMEOUT_MS=10000` (10s). Any interim result resets the timer; finalResult also stops listening explicitly.
- **Composer state lost if the user dictates while editing an existing block.** Mitigation: the mic appends to the existing `draft`, never replaces.
- **Mobile redirect creating a loop, eating a deeplink, or stranding the user.** Mitigation: helper mirrors `isBareRootLanding` (pathname=`/` AND no search AND no hash). `?modal=new-workspace` and any other deeplink land on the cockpit even on mobile. Explicit Vitest + Playwright tests guard this.
- **Mobile redirect flash-of-wrong-UI.** Mitigation: redirect runs synchronously in `main.tsx` before `createRouter` is constructed — Cockpit never mounts under `/` on mobile, so no dashboard flash.
- **`viewport-fit=cover` missing in `index.html` → `env(safe-area-inset-bottom)` reads 0 → composer overlaps the iOS home indicator.** Mitigation: step 3 explicitly verifies/adds the meta tag. Note: no existing iOS-sim screenshot tests in the repo, so no screenshot-diff regression to worry about.
- **Quick-capture page swallowed by the SPA fallback.** Mitigation: step 0 extracts the fallback into `registerSpaFallback(...)`; step 4 registers `/quick-capture` BEFORE that call in `app.ts`. The route test asserts that `/quick-capture` returns the expected HTML, and a separate test asserts the SPA fallback still serves `index.html` for arbitrary other paths.
- **File-size gate (`scripts/checks/file-size.ts`) already red on `apps/daemon/src/app.ts` (804 lines vs 800 cap).** Mitigation: step 0 extracts ~7 lines into `spa-fallback-route.ts` BEFORE any new code is added. Re-measured after each of step 0 and step 4.
- **Daemon trust model.** The daemon is single-user / `127.0.0.1`-bound by default with `cors()` allow-all. `/quick-capture` does not add a new auth gap (the underlying `POST /api/scratchpad/blocks` is already unauthenticated), but it lowers friction for cross-device writes. Mitigation: documented in the B.7 spec update and the satellite README; cross-LAN exposure is operator-responsibility.
- **Quick-capture posts a block when the user is on a different scratchpad workspace than the cockpit shows.** Currently moot — single global scratchpad. Flag in the spec update so a future per-workspace refactor knows to revisit the quick-capture page's targeting story.
- **Mac helper scripts fail silently when the daemon isn't running.** Mitigation: liveness probe with `--fail --max-time 2`; non-zero exit + visible message.
- **Hammerspoon not installed → user gets nothing.** Mitigation: README documents the Shortcuts.app fallback in equal detail.
- **Browser popup window opened by Chrome `--app=` doesn't autoclose because `window.close()` is restricted on a tab the user did not open via script.** Mitigation: Chrome's `--app=` mode treats the page as a standalone window and `window.close()` works there. README calls out that on Safari fallback, the user will need to ⌘+W.

### Adversarial analysis

- **How could this fail in production?** Web Speech API permission denied → user sees a fleeting error and assumes the button is broken. Quick-capture page silently does nothing if the daemon is on a non-default port and the script's env vars aren't set.
- **What user actions trigger unexpected behavior?** Rotating the iPhone from portrait to landscape mid-composition (viewport stays narrow; redirect doesn't re-fire because we already navigated). Dictating while a block is open for edit (transcript appends to that block's draft, not the composer — correct, but worth documenting in the README).
- **What existing behavior could break?** The cockpit dashboard at `/` for users with narrow desktop windows (< 820px). Mitigation: documented in spec; the redirect is a deliberate UX choice and matches the AC.
- **Which tests credibly catch those failures?** Vitest covers the helpers and the route handler; Playwright covers the mobile-viewport redirect and the quick-capture happy path. Manual QA covers the iOS Safari mic flow (Web Speech API can't be driven headlessly).
- **What gaps remain?** No automated test for the Mac helper scripts (POSIX shell on macOS only, can't run in Linux CI). Tracked as manual QA in the PR description.

## Tests

Concrete files to add / modify, in TDD order — each test in this list is written and red before the production code that satisfies it:

1. `apps/daemon/src/spa-fallback-route.test.ts` (step 0)
2. `apps/daemon/src/spa-fallback-route.ts` (step 0) + edit `apps/daemon/src/app.ts` to call `registerSpaFallback({app, webDist})`
3. Spec updates: `specs/B.2-ade-cockpit.md`, `specs/B.7-operations-activity-mcp.md` (incl. Security/trust-model subsection + stale-wording fix), `specs/B.1-repositories-workspaces.md`, `specs/C-technical-stack.md`
4. `apps/web/src/lib/use-speech-recognition.test.ts`
5. `apps/web/src/lib/use-speech-recognition.ts`
6. `apps/web/src/components/voice-capture-button.test.tsx`
7. `apps/web/src/components/voice-capture-button.tsx`
8. `apps/web/src/lib/mobile-redirect.test.ts` (incl. `?modal=new-workspace` regression case)
9. `apps/web/src/lib/mobile-redirect.ts`
10. `apps/web/src/main.test.tsx` (or `apps/web/src/lib/bootstrap-redirect.test.ts`) — pre-router wiring assertions
11. `apps/web/src/main.tsx` — synchronous pre-router redirect next to `bootstrapLastRoute(...)`
12. `apps/web/src/lib/new-workspace-deeplink.test.ts`
13. `apps/web/src/lib/new-workspace-deeplink.ts`
14. `apps/daemon/src/quick-capture-route.test.ts`
15. `apps/daemon/src/quick-capture-route.ts` + edit `apps/daemon/src/app.ts` to call `registerQuickCaptureRoute({app})` BEFORE `registerSpaFallback(...)`
16. Cockpit composer + per-block mic integration: extend `apps/web/src/routes/scratchpad.tsx` and add/extend `apps/web/src/routes/scratchpad.test.tsx` (incl. narrow-viewport History toggle assertion)
17. Cockpit deeplink wiring: extend `apps/web/src/cockpit.tsx` and add `apps/web/src/cockpit.test.tsx` (or extend the existing one)
18. `e2e/scratchpad-mobile.spec.ts`
19. `e2e/scratchpad-mobile-deeplink.spec.ts`
20. `e2e/quick-capture.spec.ts`
21. Scripts (no test layer): `scripts/mac-satellite/{quick-capture.sh,new-workspace.sh,README.md}`
22. CSS: `apps/web/src/scratchpad.css` (mobile breakpoint additions, mic-button styles); verify/add `viewport-fit=cover` in `apps/web/index.html`.
23. After all steps: re-run `pnpm exec tsx scripts/checks/file-size.ts` and confirm `apps/daemon/src/app.ts` is < 800 lines (also covered by `make check`).

## Schema or contract generation

Not applicable. No DB schema changes, no new contract types (everything reuses `ScratchpadBlockSummary` and `CreateWorkspaceInputSchema`).

## Verification

Before opening the PR, all of the following must pass locally:

- `make check` — comprehensive gate: `check:arch`, `check:size` (gate that step 0 specifically fixes), `typecheck`, `lint` (biome), `test` (vitest), `coverage`, `check:deps`, `build`.
- `make e2e` — Playwright including the three new specs (`scratchpad-mobile`, `scratchpad-mobile-deeplink`, `quick-capture`).
- `make smoke` — daemon HTTP smoke. **Specific addition:** the smoke harness gets a new probe asserting `GET /quick-capture` returns 200 with `Content-Type: text/html` and that the body contains the literal string `/api/scratchpad/blocks`. If the existing smoke harness shape doesn't accommodate a non-`/api` HTML route, document that as a one-line follow-up in the PR description rather than fabricating a check.
- `make performance` — **dropped**. The mobile redirect runs once per cold load and is not in a hot path the existing perf-smoke harness covers; the per-request middleware footprint is unchanged. Including it would be decoration.

Manual QA in the PR description:

- iOS Safari real device (**iOS ≥ 14.5 required**; daemon must be reached over HTTPS or via `localhost` for the Web Speech API to function): open the daemon URL on the LAN → lands on `/scratchpad` → tap the mic button → grant permission → dictate → text appears in composer → tap composer Save → block persists. Verify the composer respects the home-indicator safe area (visible inset gap below the textarea on a notched iPhone).
- macOS: bind `scripts/mac-satellite/quick-capture.sh` to `cmd+shift+s` via Hammerspoon → press → Spotlight-shaped window opens → type / dictate → ⌘+Enter → block appears in the cockpit's scratchpad view → window closes.
- macOS: run `scripts/mac-satellite/new-workspace.sh` → default browser opens cockpit with Create Workspace modal already open → fill → submit → workspace created.
