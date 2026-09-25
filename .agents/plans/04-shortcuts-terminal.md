Activate the /implement-task skill first.

# Plan: Shortcuts & terminal

Scratchpad block: `00000004-0004-4004-8004-000000000004`
Branch: `agent/04-shortcuts-terminal-kbcsn8` (orchestration-issued; intentionally not `fb-*`).

## Acceptance Criteria

Transcribed verbatim from the scratchpad scope plus user-confirmed decisions:

- [ ] `cmd+t` launches a new bare Terminal session in the current workspace (uses the built-in `shell` runtime; no agent runtime attached).
- [ ] `cmd+e` launches a new agent session in the current workspace using the workspace's default agent runtime (resolved the same way the create-workspace modal does today: prefer `claude-code` if healthy, else first healthy non-`shell` runtime).
- [ ] `ctrl+1..9` jumps to the Nth workspace in the Navigator's **in-tree visible order**; `ctrl+0` jumps to the 10th. "In-tree visible order" is defined as the flat traversal of the rendered Navigator tree under the current grouping mode (`repo` / `status` / `namespace` / `none`), ignoring collapsed-group state for indexing but auto-expanding the group containing the selected workspace so it becomes visible. Beyond 10 is unreachable from the keyboard in this PR.
- [ ] `cmd+shift+1..9` jumps to the Nth session inside the active workspace's tab strip (tabs are ordered by `createdAt` asc — see `apps/web/src/stage.tsx:27`).
- [ ] When xterm has focus, the following shortcuts reach the cockpit instead of being swallowed by the iframe shim: `cmd/ctrl+K`, `ctrl+1..9`, `ctrl+0`, `cmd+t`, `cmd+e`, `cmd+shift+1..9`, and `Escape` (Escape is also delivered to xterm — see "Adversarial analysis" for the gating rule).
- [ ] Plain terminal scrollback works: the operator can scroll back through historical output of a non-alt-screen pane using the mouse wheel.
- [ ] Claude Code (and any other alt-screen TUI) continues to receive mouse-wheel events and scroll its own buffer — the tmux change must not regress that.
- [ ] Typing shifted-digit characters (`!@#$%^&*(`) inside xterm still works (we deliberately avoid the `shift+digit` keymap).
- [ ] Documented browser caveat for `cmd+t`: in normal browser-tab mode, every major desktop browser (Chrome/Safari/Firefox/Edge) opens a new browser tab and ignores `preventDefault`. PWA mode does NOT universally free `cmd+t`: Chrome PWA window mode still intercepts it on macOS in current builds; Safari "Add to Dock" / standalone web apps reliably free it; Electron/Tauri/dedicated wrappers reliably free it. The honest answer documented in the spec is "use cmd+t inside a Safari-installed PWA or a dedicated wrapper; otherwise use the plus-button menu in the Stage."
- [ ] Documented browser caveat for `cmd+e`: collides with "Use Selection for Find" in Chrome and Safari on macOS. The collision is benign — those browsers expose `cmd+e` as a renderer-level editing shortcut (not a window-management shortcut), so `preventDefault` from the cockpit handler wins. Document the collision in the spec so future maintainers don't re-debate it.

## Context and problem statement

Today's state, from a fresh read of the code:

- Global cockpit shortcuts are handled by a single `keydown` listener in `apps/web/src/cockpit.tsx:75-119`. It binds `cmd/ctrl+K` (palette), `ctrl+N` and plain `c` (new workspace), and `Escape` (close palette). No workspace nav, no session nav, no terminal-spawn shortcuts.
- Each terminal renders inside an iframe served by ttyd via the daemon's reverse proxy (`/terminals/<sessionId>/`). The daemon injects `apps/daemon/src/terminal-key-shim.client.js` into ttyd's HTML; the shim registers a single `keydown` listener on `document` at the capture phase (`terminal-key-shim.client.js:373`) and **calls `event.stopPropagation()` + `event.preventDefault()` on every shortcut it handles** — and for keys it does not handle, the event still reaches xterm but never bubbles to `window.parent`. The cockpit's global listener therefore **never receives a single keydown while the iframe has focus**. This is the root cause of "cmd+K doesn't work in the terminal".
- tmux is invoked via `buildAttachCommand` in `packages/terminal/src/ttyd.ts:334-341`. The function sets `extended-keys on` and amends `terminal-features` for `extkeys`, then `exec tmux attach`. It does **not** set `mouse on`, `history-limit`, or `set-clipboard`. With mouse off, the wheel event reaches xterm but xterm's own scrollback is empty for plain panes — tmux paints the visible pane via direct cursor moves, so historical lines are inside tmux's pane buffer (not xterm's). For alt-screen apps like Claude Code, the app reads mouse events directly via xterm passthrough and handles scroll internally — which is why Claude Code "just works" today while a plain bash pane does not.
- **tmux socket scoping.** `packages/terminal/src/index.ts:38,218` calls `tmux new-session` with no `-L` flag, so Citadel uses the user's default tmux socket. This means any `set-option -g …` (global) or `-s …` (server) leaks into the user's personal tmux sessions outside Citadel. Per-session scope (`-t "<session>"` with no `-g`) is the right granularity for options the operator may not want server-wide. The pre-existing `set-option -s extended-keys on` line in `buildAttachCommand` IS a pollution bug (it's already leaking), but it's a documented prior decision and out of scope for this PR — we just won't add new ones.
- **OSC 52 / clipboard.** `apps/daemon/src/terminal-key-shim.client.js:29,375` claims `set-clipboard on` is enabled in `buildAttachCommand`. It is not — verified by `grep -rn set-clipboard packages apps`. This is a pre-existing stale comment AND means tmux's copy-mode currently has no OSC 52 path to the system clipboard. When we enable `mouse on`, drag-to-copy in plain panes shifts from xterm's selection model (which the shim reads via `term.getSelection`) to tmux's copy-mode (which only emits OSC 52 when `set-clipboard on` is set). We therefore MUST set `set-clipboard on` at the same time we set `mouse on` — and fix the stale comment.
- Session creation endpoint (`POST /api/agent-sessions` at `apps/daemon/src/app.ts:501-516`) already accepts any `runtimeId`, including the built-in `shell` runtime (defined at `packages/config/src/index.ts:129`). No new endpoint is needed for the bare-terminal case; cmd+t is just `createAgentSession({ runtimeId: "shell" })` and cmd+e is `createAgentSession({ runtimeId: <default> })`.
- Default-runtime resolution already exists inline in `apps/web/src/modals.tsx:340-347` (prefer `claude-code`, else first healthy non-shell). The plan extracts this into a small shared helper so cmd+e and the create-workspace modal stay in sync.

## Spec alignment

Per the extension's spec mappings, the relevant specs are:

- `specs/B.2-ade-cockpit.md` — cockpit shell, Cmd+K, Esc handling, Center Stage session tabs (Terminal vs agent).
- `specs/B.3-agent-sessions-terminal.md` — terminal renderer, tmux/xterm, scrollback bound (§Terminal 8), pass-through of terminal keyboard shortcuts (§Center Stage Sessions 7 — actually in B.2).
- `specs/A-shared-definitions.md` — canonical terminology (Workspace, Agent session, Terminal/shell runtime).

Discrepancies / additions required (these become Step 1 of implementation):

1. **B.2 §Shell Layout 9** mentions Cmd+K but never enumerates other cockpit shortcuts. Add a new **§Keyboard Shortcuts** section (after §Shell Layout). Draft text (this is what lands in the spec):

   > 1. Global cockpit shortcuts:
   >    - `Cmd/Ctrl+K` — opens the command palette.
   >    - `Ctrl+N` (mac only; Linux/Windows browsers reserve it for "new browser window") and plain `c` (when no editable target is focused) — opens the new-workspace modal.
   >    - `Ctrl+1`…`Ctrl+9`, `Ctrl+0` — jump to the Nth workspace in the Navigator's in-tree visible order (0 = 10th). If the workspace is inside a collapsed group, the group auto-expands. On Chrome/Edge/Firefox on Windows and Linux, `Ctrl+1..9` is browser-reserved (switches browser tabs) — these shortcuts work reliably only on macOS or inside a PWA/desktop wrapper.
   >    - `Cmd+Shift+1`…`Cmd+Shift+9` — jump to the Nth session in the active workspace's Center Stage tab strip, ordered by session `createdAt` ascending.
   >    - `Cmd+T` — spawn a new bare Terminal session in the active workspace. Browser-reserved in normal tab mode; works in Safari standalone PWAs and dedicated wrappers (Electron/Tauri).
   >    - `Cmd+E` — spawn a new agent session in the active workspace using the workspace's default agent runtime (currently resolved as: prefer `claude-code` if healthy, else first healthy non-`shell` runtime). Collides benignly with Chrome/Safari "Use Selection for Find" on macOS — the cockpit handler `preventDefault`s before the browser acts.
   >    - `Escape` — closes the top-most open overlay (command palette, modal, dialog).
   > 2. When focus is inside a terminal iframe (ttyd-rendered xterm), the iframe shim forwards the chords above to the cockpit instead of consuming them locally. `Escape` is forwarded ONLY when at least one cockpit overlay is open (the shim reads a ref-count exposed by the cockpit); otherwise xterm receives `Escape` unmodified so vim/Claude Code work normally. All other keystrokes pass through to xterm as today.

2. **B.2 §Center Stage Sessions 2** — append: "Keyboard equivalents are `Cmd+T` (Terminal) and `Cmd+E` (default agent runtime); the menu item next to each runtime displays the chord."

3. **B.2 §Center Stage Sessions 7** rewrite: "Terminal keyboard shortcuts pass through to the active terminal by default. A small, named allow-list of cockpit shortcuts (see §Keyboard Shortcuts) is forwarded to the parent cockpit when xterm has focus; everything else is delivered to xterm unchanged."

4. **B.3 §Terminal 8** rewrite (this is the new spec text):

   > Scrollback works for both plain shells and alt-screen TUIs. tmux is configured per-attach with session-scoped `mouse on`, `history-limit 50000`, and `set-clipboard on`. Wheel events in a plain pane enter tmux copy-mode and scroll the tmux pane buffer; selections made in copy-mode reach the system clipboard via OSC 52 (intercepted by the iframe shim). Alt-screen TUIs (e.g. Claude Code) continue to receive forwarded wheel events directly and handle scroll internally. ttyd's xterm enforces an upper renderer-side scrollback cap on top of tmux's pane buffer.

All spec updates land in the same PR as the code, as the first implementation step.

## Implementation approach

Single PR, four logical units in this order (each becomes one "Implement: …" task in `/implement-task`):

1. **Specs first.** Update B.2 and B.3 per "Spec alignment" above.
2. **Shortcut registry + cockpit bindings.** Introduce a single source-of-truth registry of cockpit shortcuts (chord descriptor + handler id) in a new file `apps/web/src/shortcuts.ts`. Both the cockpit's global `keydown` handler AND the iframe-shim allow-list import from this registry, so the two stay in lock-step. The cockpit-side handler is the same `keydown` listener that already exists at `apps/web/src/cockpit.tsx:75-119`, extended to call into the registry; we do not introduce a new hook abstraction (one listener suffices).
3. **Iframe shim forwarding.** Extend `apps/daemon/src/terminal-key-shim.client.js` with a forwarding-allow-list block executed BEFORE the existing translation block. Matched events: build a clone via `new KeyboardEvent("keydown", { … })` and dispatch on `window.parent` (same-origin: ttyd is served through the daemon proxy under the cockpit's own host:port). For chords on the allow-list other than Escape: forward, then `event.preventDefault()` + `event.stopPropagation()` so xterm does not also see it. For Escape: forward conditionally (see §Risks: the cockpit publishes a `window.__citadelOverlayOpen` ref-count which the shim reads via `window.parent.__citadelOverlayOpen`; non-zero ⇒ forward; zero ⇒ pass through to xterm only).
4. **tmux scrollback fix (session-scoped).** In `packages/terminal/src/ttyd.ts:334`, extend `buildAttachCommand` with:
   - `tmux set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`
   - `tmux set-option -t "${safe}" history-limit 50000 >/dev/null 2>&1 || true`
   - `tmux set-option -t "${safe}" set-clipboard on >/dev/null 2>&1 || true`

   Session-scoped (`-t "${safe}"`, no `-g`) is the right granularity because Citadel uses the user's default tmux socket (no `-L`; see `packages/terminal/src/index.ts:38,218`). Global (`-g`) options would leak into the user's personal tmux sessions and silently mutate their preferences — unacceptable. The pre-existing `extended-keys` and `terminal-features` lines remain server-scoped as today (prior decision; out of scope to refactor in this PR). `set-clipboard on` is required alongside `mouse on` so drag-to-copy in plain panes still reaches the system clipboard via OSC 52. We do NOT touch `mode-keys` or copy-mode bindings (out of scope; user picked option A, not B).

5. **cmd+t / cmd+e session creation wiring.** The cockpit shortcut handler resolves the `shell` runtime (cmd+t) or default agent runtime (cmd+e via a new exported helper in `apps/web/src/runtime-defaults.ts`, refactored out of `modals.tsx:340-347`), POSTs to the existing `/api/agent-sessions`, then sets the new session as active in the per-workspace session map.

No new HTTP routes, no DB schema changes, no contract changes (the existing `CreateAgentSessionInputSchema` already accepts `runtimeId: "shell"` — see `packages/contracts/src/index.test.ts:76`).

## Alternatives considered

1. **A leader-key system (e.g. `cmd+K` then a letter) for nav** — rejected by user. Heavier muscle memory cost; doesn't solve the xterm-focus problem (`cmd+K` still has to forward).
2. **Use `shift+1..9` for session nav** — initially proposed and explicitly rejected: it would block typing `!@#$%^&*(` inside xterm. `cmd+shift+1..9` is the chosen replacement.
3. **Add a separate `/api/agent-sessions/terminal` endpoint for bare terminals** — rejected after reading the code: the existing endpoint already accepts `runtimeId: "shell"`. Adding a sibling endpoint would duplicate validation and lifecycle logic.
4. **Configure tmux scrollback via a per-session `tmux send-keys` after attach** — rejected: race-prone (the attach might still be initializing) and stateful (one-shot vs persistent). `set-option -g` inside `buildAttachCommand` runs every attach but is idempotent.
5. **Have the shim re-dispatch via `window.parent.postMessage` rather than synthetic KeyboardEvent** — rejected: cockpit's existing listener is `window.addEventListener("keydown", …)`; using a clone of KeyboardEvent keeps a single listener, no second message-handling path. Same-origin guarantees cross-frame `dispatchEvent` works.
6. **Override `cmd+t` / `cmd+w` browser shortcuts via `preventDefault`** — impossible: every major browser ignores `preventDefault` on `cmd+t`, `cmd+n`, `cmd+w` in tab mode. Plan accepts this and documents the PWA-only caveat instead of pretending we can fix it.
7. **Tie cmd+e's "default runtime" resolution to Agents-system block #12 in this PR** — rejected (overlapping work). Block #12 will introduce per-workspace configurable defaults; this PR uses the same resolution logic that's already in the create-workspace modal. When #12 lands a real config field, the helper extracted in step 5 swaps to read it without changing the shortcut.

## Implementation steps

### Step 1 — Specs

- Edit `specs/B.2-ade-cockpit.md`: add §Keyboard Shortcuts; qualify §Center Stage Sessions 7; mention cmd+t/cmd+e in §Center Stage Sessions 2.
- Edit `specs/B.3-agent-sessions-terminal.md` §Terminal 8: rewrite per "Spec alignment §4".
- Run `pnpm specs:lint` if such a script exists (check `package.json`); otherwise skip.

### Step 2 — Shortcut registry + cockpit handler

- New file `apps/web/src/shortcuts.ts` exporting:
  - `type ShortcutId = "command-palette" | "new-workspace-modal" | "nav-workspace" | "nav-session" | "spawn-terminal" | "spawn-agent" | "close-overlay"`
  - `type ShortcutChord = { id: ShortcutId; mods: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }; key: string; index?: number }` — `index` carries the digit for nav-* shortcuts.
  - `matchShortcut(event: KeyboardEvent): ShortcutChord | null`
  - `FORWARDABLE_SHORTCUT_IDS: ReadonlySet<ShortcutId>` — the subset the shim is allowed to forward.
  - `FORWARDABLE_CHORDS: ReadonlyArray<{ id: ShortcutId; modsKey: string; key: string }>` — canonicalized chord descriptors used by the parity test (`modsKey` is a stable string like `"meta+shift"`).
- Refactor `apps/web/src/cockpit.tsx:75-119`'s listener to delegate to `matchShortcut`. Add handlers for `nav-workspace` (visible-order index, see Navigator hook below), `nav-session` (`createdAt`-asc index from `activeWorkspaceSessions`), `spawn-terminal`, `spawn-agent`.
- Extract `defaultAgentRuntimeId(runtimes)` from `apps/web/src/modals.tsx:340-347` into a new `apps/web/src/runtime-defaults.ts`; re-import from both `modals.tsx` and `cockpit.tsx`.
- **Navigator visible-order hook.** Add `useNavigatorFlatOrder(): string[]` (returning workspace IDs in tree traversal order) to `apps/web/src/navigator.tsx`, computed from `buildGroupTree(...)`'s output traversed depth-first under the current grouping. Cockpit consumes the hook for `nav-workspace`. When `ctrl+N` selects a workspace whose parent group is collapsed, the handler also calls a sibling helper `expandGroupContaining(workspaceId)` (also added to `navigator.tsx`) so the workspace becomes visible. The hook + helper share the same group-collapse-state localStorage the Navigator already uses.
- **Overlay ref-count via consolidated hook.** Add `useOverlayPresent(): void` in a new `apps/web/src/use-overlay-present.ts`. The hook increments `window.__citadelOverlayOpen` on mount and decrements on unmount (handles StrictMode double-invoke correctly via a guard). Guards `typeof window === "undefined"` at the top to no-op cleanly in SSR / node-env tests. Wire it into every component that renders an overlay:
  - `CommandPalette` (`apps/web/src/command-palette.tsx`)
  - `CreateWorkspaceModal` (`apps/web/src/modals.tsx`)
  - `AddRepoModal` (also `modals.tsx`)
  - `ScheduledAgentDeleteDialog` (`apps/web/src/scheduled-agent-delete-dialog.tsx`)
  - Settings overlays (`apps/web/src/settings-repositories.tsx:216`, `apps/web/src/settings-runtimes.tsx:340`)
  - Namespace edit overlay (`apps/web/src/namespaces-view.tsx:246`)
  - Inline-edit modal in workspace card (`apps/web/src/workspace-card.tsx:156`)
  - Diff modal in scratchpad route (`apps/web/src/routes/scratchpad.tsx:357`)
  Add a follow-on TODO comment at each call site listing the hook so a future overlay author finds it. Enumeration was derived by `grep -rn '"Escape"\|key.*Escape' apps/web/src --include="*.ts" --include="*.tsx"`.

### Step 3 — Iframe shim forwarding

- Extend `apps/daemon/src/terminal-key-shim.client.js`:
  - Define a top-of-file constant `FORWARDABLE_CHORDS = [...]` mirroring the registry's exported chord list. Cannot share the source file: shim is plain JS read at daemon startup via `fs.readFileSync`, lives in a different package, runs in an iframe sandbox.
  - Expose the matcher on `window.__citadelTerminalShimDebug = { matchForwardable, FORWARDABLE_CHORDS }` so the parity test can call it directly without needing to inspect the source string.
  - Before the existing translation block in `onKeydown`, call `matchForwardable(event)`. If it returns a non-null id:
    - Read `window.parent.__citadelOverlayOpen` (guarded with `try/catch` for unexpected cross-origin failures — should never happen since ttyd is served through the same daemon proxy as the cockpit, but be defensive; log once via `console.error` if the throw is unexpected so devtools surfaces a future regression).
    - Build the clone: `const clone = new KeyboardEvent("keydown", { key, code, ctrlKey, metaKey, shiftKey, altKey, bubbles: true, cancelable: true });`
    - `window.parent.dispatchEvent(clone)` (the cockpit listens on `window`, verified at `apps/web/src/cockpit.tsx:117`).
    - For Escape: only forward when overlay ref-count is > 0; always let xterm see Escape afterward (do NOT consume).
    - For non-Escape forwardables: `consume(event)` so xterm does not also act on the key.
- The existing translations (Shift+Enter→LF, Ctrl+A→SOH, Cmd+Backspace→Ctrl+U, etc.) remain unchanged and run AFTER the forwarding block. They are mutually exclusive with the forwarding set: forwardables all have `meta` or `ctrl` modifiers (often combined with `shift`); translations are either pure `shift+enter` (no meta/ctrl) or `ctrl+a` (without meta/shift) etc. — no chord overlap. Verified by comparing the chord tables.
- **Parity enforcement.** Architecture-boundary note: `scripts/checks/architecture-boundaries.ts` forbids `apps/web/src` from importing `node:*` (so the parity test cannot live in `apps/web` — it needs `fs.readFileSync` to load the shim source). There is no explicit rule on apps/web ↔ apps/daemon imports, but cross-app source imports are not part of the established pattern and pnpm workspaces don't expose them naturally. Decision: place the canonical `FORWARDABLE_CHORDS` data table in `packages/contracts/src/shortcuts.ts` (data-only export; no React, no node) so both sides can import it cleanly:
  - `apps/web/src/shortcuts.ts` re-exports `FORWARDABLE_CHORDS` from `@citadel/contracts` and adds `matchShortcut(event)` (browser-runtime matcher).
  - `apps/daemon/src/terminal-key-shim.client.js` mirrors the table inline (still must — it's IIFE-injected JS); `matchForwardable` is the runtime matcher.
  - Parity test lives at `apps/daemon/src/shortcuts-parity.test.ts`:
    - Imports `FORWARDABLE_CHORDS` from `@citadel/contracts` (the canonical source).
    - Imports `TERMINAL_KEY_SHIM_SOURCE` from the local `./terminal-key-shim.js` (same-package import, no boundary concern).
    - Evaluates the shim source via the existing harness pattern (`new Function(...)`) and extracts `__citadelTerminalShimDebug`.
    - For every chord in `FORWARDABLE_CHORDS`, asserts the shim's `matchForwardable` returns the matching `id` for a synthetic event.
    - For a curated negative-input list, asserts both sides return null.
  - This is behavioral parity — drift in source format doesn't break the test, but drift in actual logic does.
- **Pre-check.** Before merging Step 2, run `pnpm check:arch` to confirm `apps/web/src/shortcuts.ts`'s `import { FORWARDABLE_CHORDS } from "@citadel/contracts"` passes the boundary check. The current `apps/web/src` forbidden list does NOT include `@citadel/contracts` (verified at `scripts/checks/architecture-boundaries.ts:29-37`), so this should pass.
- Update the existing stale comment at `apps/daemon/src/terminal-key-shim.ts:7-24` to mention the new forwarding behavior AND to remove the false claim about `set-clipboard on` being enabled in `buildAttachCommand` (the spec for `set-clipboard on` lives in step 4 now, so the comment becomes accurate again).

### Step 4 — tmux scrollback fix (session-scoped, not server-global)

- Edit `packages/terminal/src/ttyd.ts:334` `buildAttachCommand`. The new options are session-scoped (`-t "${safe}"`, no `-g`) so they don't leak into the user's personal tmux sessions on the default socket. (Citadel doesn't use `-L <socket>`; see `packages/terminal/src/index.ts:38,218`.) The pre-existing `extended-keys` and `terminal-features` lines remain as today — they're documented prior decisions, out of scope for this PR even though they ARE server-scoped.

  ```ts
  return [
    "tmux set-option -s extended-keys on >/dev/null 2>&1 || true",
    "tmux show-options -s -g terminal-features 2>/dev/null | grep -q 'xterm\\*.*extkeys' || tmux set-option -as terminal-features ',xterm*:extkeys' >/dev/null 2>&1 || true",
    `tmux set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`,
    `tmux set-option -t "${safe}" history-limit 50000 >/dev/null 2>&1 || true`,
    `tmux set-option -t "${safe}" set-clipboard on >/dev/null 2>&1 || true`,
    `exec tmux attach -t "${safe}"`,
  ].join("; ");
  ```

  Notes:
  - `set-clipboard on` is required when `mouse on` is set, otherwise drag-to-copy in plain panes (which now goes through tmux copy-mode) cannot reach the system clipboard. The shim's existing OSC 52 handler (`terminal-key-shim.client.js:385-428`) already decodes the `set-clipboard on` payload — so the round-trip works as soon as tmux is configured to emit it.
  - `history-limit` only applies to buffer growth AFTER the option is set; pre-existing scrollback (rare for Citadel — tmux sessions are created fresh in `packages/terminal/src/index.ts:38` per workspace) keeps its previous bound. Acceptable.
  - `-t "${safe}"` uses the already-escaped session name. Verified safe against shell injection at line 335 (`tmuxSession.replace(/"/g, '\\"')`).

- No changes to `tmuxSessionAlive`, `portOpen`, or the ttyd lifecycle. The MEMORY note about "ttyd cleanup-storm pitfalls" (portOpen race + cleanupStale-in-vitest) is unrelated to this code path but the test plan double-checks that no existing test asserting "buildAttachCommand has exactly N lines" or similar breaks.

### Step 5 — cmd+t / cmd+e wiring

- Cockpit handler (already extended in step 2) calls a small `spawnSession(workspaceId, runtimeId)` helper that:
  - POSTs to `/api/agent-sessions` with `{ workspaceId, runtimeId }`.
  - On success, sets `activeSessionByWorkspace[workspaceId] = session.id` and ensures the stage column is in focus (set `mobileView = "stage"`).
  - On failure: surface inline using whatever the existing `+` button uses today (TBD during implementation — check `Stage` component) so behavior matches the menu path.
  - When `runtimeId === ""` (no default agent runtime available — only `shell` installed): do NOT POST. Instead surface the same inline error the Stage's `+` menu shows when the runtime list is empty, message text: "No agent runtime available — install Claude Code or another runtime in Settings."
- The new session ID is set as active immediately; Stage's existing `pendingActive` grace window (4s, at `apps/web/src/stage.tsx:37-51`) handles the lag until SSE refresh delivers the session to `data.sessions`. If SSE refresh takes longer than 4s (slow daemon under spawn-storm), Stage falls back to `tabs[0]` per its existing behavior — user-visible: the new tab appears later instead of immediately. No optimistic cache push (scope creep; the existing grace window covers the common case). Test plan adds an explicit slow-SSE test.

### No schema changes

No DB migrations. No `schema_migrations` row. `PRAGMA foreign_keys` unaffected. Operator data implications: none.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Shortcut registry (`matchShortcut` truth table), iframe shim forwarding (mirror parity + Escape gating + KeyboardEvent clone shape), `buildAttachCommand` output, default-runtime helper, cockpit overlay ref-count. |
| E2E (Playwright) | **Required** | At minimum: ctrl+1 switches workspace, cmd+shift+1 switches session, cmd+t spawns a Terminal session (assert new tab appears), Escape closes command palette from inside xterm focus. Plain scrollback E2E is hard to assert deterministically (wheel events + tmux state); covered manually. |

### New tests to add

- `apps/web/src/shortcuts.test.ts` — truth table for `matchShortcut`. Positive cases for every supported chord on macOS and non-macOS (the registry must not rely on `metaKey` for cross-platform shortcuts). Negative cases: plain `c` while editable target focused, plain digits, `shift+1`, `cmd+1` (must NOT match — Chrome owns it; we don't add it to our registry to avoid pretending we handle it).
- `apps/daemon/src/terminal-key-shim.test.ts` — extend the existing JSDOM-style harness at lines 200-319. The harness already evaluates the IIFE in a controlled scope via `new Function(...)`; extension required: add `runtime.window.parent` (with its own `addEventListener` keydown registry, mirroring the existing `windowKeydownListeners`/`documentKeydownListeners` counters) and a numeric `runtime.window.parent.__citadelOverlayOpen` knob exposed by `setup({ parentOverlayCount?: number })`. New tests:
  - "forwards cmd+K to window.parent and consumes the event for xterm"
  - "forwards ctrl+1..9 to window.parent and consumes" (parametrize)
  - "forwards cmd+shift+1..9 to window.parent and consumes" (parametrize)
  - "forwards cmd+t and cmd+e to window.parent and consumes"
  - "does NOT forward plain `c`, plain digits, shift+digit, shift+enter, ctrl+a, cmd+c, cmd+v, cmd+a, cmd+left/right/backspace" (negative cases — covers the regression that the forwarding block doesn't accidentally swallow translation-block chords)
  - "forwards Escape to window.parent ONLY when window.parent.__citadelOverlayOpen > 0; otherwise does not forward"
  - "always lets xterm see Escape regardless of forwarding" (event NOT consumed)
  - "forwarded keydown reaches the cockpit listener even though `event.target` is the Window object and `event.isTrusted === false`" — covers Concern 6; the test asserts the cockpit's `inEditable` check coerces `target` to null safely (since Window has no `tagName`).
  - "shim's `__citadelTerminalShimDebug.matchForwardable` returns the same id as `apps/web/src/shortcuts.ts`'s `matchShortcut` for every chord in `FORWARDABLE_CHORDS` and null for the curated negative-input list" — this is the parity test, behavioral not string-based.
- `packages/terminal/src/ttyd.test.ts` — add a test for `buildAttachCommand`. If `buildAttachCommand` is not currently exported, export it (or export a wrapper). Assert:
  - Result contains `set-option -t "<session>" mouse on`, `history-limit 50000`, `set-clipboard on`.
  - Result does NOT contain ` -g mouse` or ` -g history-limit` or ` -g set-clipboard` (no server-global pollution).
  - Result still contains `extended-keys on` (existing line preserved).
  - Result ends with `exec tmux attach -t "<session>"` (order matters — options must take effect before attach).
  - Special-character session names (e.g. quotes) are escaped — assert `buildAttachCommand('a"b')` produces a single-line command with `\\"` escaping intact.
- `apps/web/src/runtime-defaults.test.ts` — extracted helper. Cases: claude-code present and healthy → returns claude-code; claude-code missing → returns first healthy non-shell; only shell present → returns "" (no default); empty list → returns "".
- `apps/web/src/cockpit-shortcuts.test.ts` (or extend an existing cockpit test) — render the Cockpit with a stubbed state, dispatch synthetic keydown events for each supported chord, assert the right state transition (active workspace id, active session id, mutation invoked). Include:
  - "slow-SSE path: cmd+t POSTs, sets activeSessionByWorkspace, and Stage's `pendingActive` grace shows the new tab once SSE refresh delivers the session" — covers Concern 8.
  - "cmd+e with no agent runtimes available (only shell) surfaces the inline error and does NOT POST" — covers Concern 5 / Step 5 no-runtime branch.
- `apps/web/src/use-overlay-present.test.ts` — verifies the ref-count increments on mount, decrements on unmount, handles StrictMode double-invoke correctly, that `window.__citadelOverlayOpen` is exactly 0 when no overlays are mounted, AND that the hook is a clean no-op when `window` is undefined (SSR / node-env vitest case — wrap with a `vi.stubGlobal` test or run the hook in a node-env file to assert no throw).
- `apps/web/src/navigator.test.tsx` — extend (or create) with `useNavigatorFlatOrder` cases under each grouping mode (`repo`, `status`, `namespace`, `none`) and various collapse states. Assert: index ordering matches what the user visually sees; `expandGroupContaining(workspaceId)` un-collapses the necessary group.
- `apps/daemon/src/shortcuts-parity.test.ts` — see Step 3. Behavioral parity between `FORWARDABLE_CHORDS` (in `@citadel/contracts`) and the shim's `matchForwardable`. Lives in apps/daemon (not apps/web) because the test imports `node:fs` via the shim source loader, and `apps/web/src` is forbidden from `node:*` imports per `scripts/checks/architecture-boundaries.ts`.
- `apps/daemon/src/agents/claude-code-status-parser.test.ts` (or wherever the Claude Code adapter status parser lives — search during implementation for the regex defined in §B.3 Runtime Adapters 2 with "Adapter regexes are anchored to the bottom of the visible pane") — add a test that feeds a buffer containing tmux mouse-event escape sequences (`\x1b[<0;<col>;<row>M` and `\x1b[<0;<col>;<row>m`) and asserts no status transitions fire. Covers Concern 10 (the "trust the reasoning" gap).
- E2E `e2e/shortcuts.spec.ts` — happy paths listed above. Use the existing harness for spawning a deploy + opening the cockpit (`e2e/*.spec.ts` patterns).

### Existing tests to update

- `apps/web/src/cockpit.test.tsx` (if it exists; otherwise create) — the listener is being refactored to delegate to the registry; existing assertions about cmd+K and plain `c` must keep passing.
- `apps/daemon/src/terminal-key-shim.test.ts` — current assertions about Shift+Enter, Ctrl+A, Cmd+Backspace/arrows/C/V/A must continue to pass; the forwarding block runs FIRST and is mutually exclusive with the translation set.
- `packages/terminal/src/ttyd.test.ts` (if any current tests assert `buildAttachCommand` line count or exact string) — update expectations.

### Assertions to add/change/tighten

- Shim forwarding: assert the synthetic KeyboardEvent dispatched on `window.parent` has the same `key`, `code`, `metaKey`, `ctrlKey`, `shiftKey`, `altKey` as the original — not just that `dispatchEvent` was called.
- Shim Escape gating: assert that with `window.parent.__citadelOverlayOpen === 0`, no dispatch on parent occurs and the event is not consumed; with `> 0`, dispatch occurs AND xterm still sees Escape (event not consumed).
- `buildAttachCommand`: assert `mouse on` precedes `exec tmux attach` (order matters — must take effect before attach completes).
- Cockpit nav: assert `ctrl+1` selects `workspaces[0]` per the Navigator's render order, NOT per `data.workspaces` if the two differ.

### Failure modes / edge cases / regression risks

- **Tmux pollution.** Verified: Citadel uses the default tmux socket (no `-L`). Pre-existing `set-option -s extended-keys on` already pollutes server-wide; new options in this PR all use `-t "${safe}"` (session-scoped) so they do not. Regression check: run `tmux new-session -d -s pre_citadel_check 'sleep 60'; tmux show -tv pre_citadel_check mouse` before a Citadel attach, then again after — values must be unchanged.
- **OSC 52 ↔ mouse-on coupling.** Enabling `mouse on` without `set-clipboard on` would silently regress drag-to-copy in plain panes. Plan adds both at once. Manual smoke: drag-select text in a plain pane, paste into a non-Citadel window, expect the text to land.
- **Same-origin assumption.** The shim does `window.parent.dispatchEvent`. If a future change serves ttyd from a different origin (CSP, subdomain isolation), this breaks silently — the cross-origin throw lands inside the shim's try/catch and the user sees "shortcut doesn't work". Mitigation: log a warning to `console.error` once when the dispatch throws, so devtools surfaces the regression.
- **Cross-platform `cmd` vs `ctrl`.** The registry must use `(metaKey || ctrlKey)` only for the explicitly cross-platform chord `cmd/ctrl+K`. For `ctrl+1..9` workspace nav: ctrlKey only (cmd+1 on Mac is Chrome tab nav and we explicitly let Chrome win). For `cmd+shift+1..9`: metaKey only on Mac, ctrlKey only on non-Mac — pick the navigator-platform-conditional approach the existing code uses (the cockpit handler already conditions on `event.metaKey || event.ctrlKey`).
- **Escape spurious dispatches.** Without the `__citadelOverlayOpen` gate, every Esc the operator hits in vim would close a (closed) command palette / cancel scheduled-agent dialog. The gate prevents this. Test the gate explicitly.
- **Mouse-on regression for Claude Code.** Manually verify wheel events still reach Claude Code after the change. They should: tmux only consumes wheel for non-alt-screen panes when mouse is on, forwarding to the alt-screen app otherwise. The Claude Code adapter's status-detection regexes must not falsely match the mouse-event escape sequences — but since Claude Code is itself an alt-screen app handling its own mouse, the escape sequences never reach the tmux pane text, so the regex won't see them.
- **History-limit memory cost.** 50000 lines per pane × tens of panes = ~tens of MB worst case. Acceptable for a local devbox; document in the spec note.
- **ttyd cleanup-storm memory.** The plan does NOT touch `cleanupStale`, `portOpen`, or the ttyd ensure path — only `buildAttachCommand`. Risk near zero, but the implementation pass must read `MEMORY.md` → `project_ttyd_cleanup_storms.md` before editing `packages/terminal/src/ttyd.ts` to confirm nothing else regresses.
- **`cmd+t` browser collision.** Operator will hit `cmd+t` in a browser tab and get a new browser tab instead. Documented; not a code-level mitigation possible.
- **Plus-button menu still works.** Don't remove the plus-button menu in Stage — only ADD keyboard equivalents.
- **Session nav out-of-range.** `cmd+shift+5` when only 3 sessions exist: no-op (log nothing). Test the no-op.
- **Workspace nav out-of-range.** Same: `ctrl+7` when only 4 workspaces exist: no-op.
- **First-load race.** `ctrl+1` pressed before `data?.workspaces` resolves: no-op until data lands.

### Adversarial analysis

- **How could this fail in production?**
  - Cross-frame `dispatchEvent` silently throws → all forwarded shortcuts dead in xterm. Log+test catches this.
  - tmux version doesn't support `mouse on` (very old tmux) → the `|| true` swallows the error; scrollback stays broken; user sees no error. Acceptable: Citadel's minimum tmux is documented somewhere (check during implementation); add a doc note.
  - `KeyboardEvent` clone is dispatched but cockpit's listener is gone (component unmounted, route changed) → no handler runs; event is dropped silently. Acceptable.
  - Default-runtime resolution returns "" when only `shell` is installed → cmd+e becomes a silent no-op. Surface a brief toast/inline message: "No agent runtime available — install Claude Code or another agent." Wire to the existing inline-error path used by the Stage's plus-button menu.
- **What user actions trigger unexpected behavior?**
  - Typing a `!` in xterm (shift+1) — must work. Negative test asserts shim does NOT forward.
  - Hitting Escape mid-vim — must not close cockpit palette. Gate via overlay ref-count.
  - Switching workspace via `ctrl+1` while a modal is open — does the modal still capture focus? Behavior: the modal's `Escape` handler stays; nav shortcuts work underneath. Acceptable; test that ctrl+1 inside a modal still switches workspace (modal closes naturally on Esc).
- **What existing behavior could break?**
  - The cockpit's `plain c` handler skips when target is editable. Refactor must preserve that guard.
  - The shim's existing translations (Shift+Enter, Cmd+Backspace, etc.) — preserved; forwarding block runs first but doesn't match those chords.
- **Which tests credibly catch those failures?**
  - The negative shift+digit, plain-c, plain-digit tests.
  - The Escape-gating test.
  - The shim translation regression test (existing).
  - The buildAttachCommand snapshot test.
- **What gaps remain?**
  - Manual mouse-wheel verification in Claude Code (can't deterministically Playwright a wheel event into ttyd's iframe; document as manual smoke).
  - PWA-mode `cmd+t` requires a manually installed PWA to test; document as manual smoke.

## Tests

Created (TDD order — tests before implementation in each step):

1. `apps/web/src/shortcuts.test.ts` (precedes step 2)
2. `apps/web/src/runtime-defaults.test.ts` (precedes step 2)
3. `apps/web/src/use-overlay-present.test.ts` (precedes step 2)
4. `apps/web/src/navigator.test.tsx` — `useNavigatorFlatOrder` cases (precedes step 2)
5. `apps/web/src/cockpit-shortcuts.test.tsx` or extension to existing cockpit test, including slow-SSE and no-runtime cases (precedes step 2/5)
6. `apps/daemon/src/terminal-key-shim.test.ts` extensions (precede step 3)
7. `apps/daemon/src/shortcuts-parity.test.ts` — behavioral parity, lives in apps/daemon due to node-import boundary rules (precedes step 3)
8. `packages/terminal/src/ttyd.test.ts` `buildAttachCommand` test, including session-scope assertion (precedes step 4)
9. `apps/daemon/src/agents/<claude-code-status-parser>.test.ts` mouse-escape regression (precedes step 4)
10. `e2e/shortcuts.spec.ts` (after units pass)

Modified:

- `packages/terminal/src/ttyd.ts` — export `buildAttachCommand` if not already exported (or export a small wrapper for testing).
- `apps/daemon/src/terminal-key-shim.ts` — update stale top comment (mention forwarding behavior, remove false `set-clipboard` claim now that step 4 actually enables it).

## Schema or contract generation

No schema changes. No new contracts. `CreateAgentSessionInputSchema` is reused as-is.

## Verification

Run before opening the PR, in this order:

- `make check` — runs `check:arch`, `check:size`, `typecheck`, `lint` (biome), `test` (vitest), `coverage`, `check:deps`, `build`. This is the local gate.
- `make e2e` — required because this PR touches `apps/web` user journeys (keyboard shortcuts). Includes the new `e2e/shortcuts.spec.ts`.
- `make smoke` — optional but cheap; we are not adding a new daemon endpoint, but the iframe shim is served by the daemon and the smoke covers terminal proxy paths.
- `make performance` — NOT required; no startup or rendering hot path changes.

Manual smoke (run in a `make deploy` worktree, since the systemd cockpit can't be touched per CLAUDE.md):

- With cursor in a plain bash pane: scroll wheel up → see historical output (the scrollback fix).
- With cursor in a Claude Code session: scroll wheel up → Claude Code's own scrollback responds (regression check).
- Drag-select text in a plain bash pane: paste into a non-Citadel window → text lands (OSC 52 bridge with `set-clipboard on`).
- Outside Citadel: `tmux new-session -d -s outside_check 'sleep 120'; tmux show -tv outside_check mouse` → value is empty (default), confirming session-scoped options don't leak.
- With xterm focused: `cmd+K` opens palette. `Escape` closes it (overlay open ⇒ Esc forwards). Hit `Escape` again with palette already closed and cursor in xterm → palette stays closed and xterm sees Esc (vim test: open vim in a pane, hit Esc → vim returns to normal mode).
- With xterm focused: `ctrl+1` jumps to first workspace. `cmd+shift+2` jumps to second session in that workspace. Switch Navigator grouping to `namespace`, collapse a group, hit `ctrl+N` where N points to a workspace in the collapsed group → group auto-expands and workspace is selected.
- With xterm focused: `cmd+t` spawns a Terminal session tab (only reliable in Safari standalone PWA / Electron wrapper); `cmd+e` spawns an agent session tab using whichever runtime is the workspace default.
- Inside xterm: type `!@#$%` — characters appear in the pane (shift+digit not stolen).
- Claude Code status: run a Claude Code session, scroll the terminal, observe the session status pill — it should NOT spuriously transition (Concern 10 manual cross-check).
