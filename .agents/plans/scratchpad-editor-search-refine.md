Activate the /implement-task skill first.

# Plan: Scratchpad — editor, viewer, search, refine

Bundle of scratchpad UX/feature work from the orchestrator scratchpad block `00000001-0001-4001-8001-000000000001`. The user has confirmed "everything in one PR" — this plan groups the work into reviewable sub-features but ships as a single PR off branch `agent/01-scratchpad-editor-m45cvq` (already created by the orchestrator).

## Acceptance Criteria

Verbatim from the scratchpad block:

- [ ] Open without hiding the navigation
- [ ] Auto-scroll to the bottom (latest row) when opened
- [ ] Floating fuzzy searchbar; expose fuzzy search via MCP too
- [ ] Line numbers
- [ ] `cmd+shift+s` toggles open/close (closing returns to the prior view); show a preview hint in the left nav so the shortcut is discoverable
- [ ] `cmd+s` saves with an animated confirmation; keep the debounced auto-save as the silent fallback
- [ ] Exiting feels instant (currently has a small delay)
- [ ] Refine button with custom prompt + scratchpad history files + `refine_scratchpad` MCP
- [ ] Editor formatting bug: blocks containing `<>` chars get visually mutated when returning to read-only after auto-save — preserve formatting exactly

User clarifications captured during grilling:
- Fuzzy search uses **fuse.js** on **block text only**.
- `cmd+shift+s` is claimed for the in-cockpit toggle (Mac satellite app deferred).
- Refine = launches an agent in a workspace with a **configurable prompt** stored under a new **Citadel Actions** settings page (the broader pattern; refine is the first such action). Default refine prompt: tells the agent to use Citadel MCP to read the scratchpad, deduplicate, group similar items, **and skip blocks marked `in-progress`** (per memory entry `project_scratchpad_workflow.md`).
- Everything ships in one PR.

## Context and problem statement

The scratchpad today (`apps/web/src/routes/scratchpad.tsx`, route `/scratchpad`) is a full-page view that replaces the cockpit shell — the user must back out to the cockpit to access nav. It supports block-level editing with debounced auto-save and a version-history sidebar. It does not have:

- A way to open inline alongside the cockpit nav.
- A keyboard shortcut to toggle visibility.
- A "save now" interaction with visible confirmation (only silent debounced save).
- A search affordance (the block list grows unbounded).
- Per-block line numbers.
- Any "refine" workflow.

It also has a rendering bug: block text containing bare `<…>` sequences (e.g. `lookup <user_id>`) round-trips through `marked` (which tokenizes `<word>` as inline HTML) and then `DOMPurify` (which strips unknown tags). The result: the rendered HTML loses the angle-bracket content while the stored markdown is fine. After auto-save fires and the block snaps back to read-only, the user sees mutated text even though the daemon stored the input correctly.

The MCP surface (`packages/mcp/src/scratchpad-tools.ts`) currently exposes `read_scratchpad`, `write_scratchpad`, `append_scratchpad`, `list_blocks`, `add_block`, `update_block`, `delete_block`. It has no fuzzy search and no agent-launch helper for the refine flow.

## Spec alignment

Two specs apply:

- **`specs/B.2-ade-cockpit.md`** — cockpit UI surface (scratchpad lives here). Line 108 references the scratchpad as "the cockpit's scratchpad view." The spec keywords list (line 121) already includes `scratchpad, blocks` — no rename needed.

  **Update required — concrete deltas:**
  - In the existing "scratchpad view" paragraph (~line 108): replace "full-page view" with "right-anchored overlay drawer over the cockpit, keeping the navigator visible."
  - Add a new subsection "Scratchpad shortcuts": `Shift+Cmd+S` (Mac) / `Shift+Ctrl+S` (other) toggles the drawer; `Cmd+S` / `Ctrl+S` while the drawer is open flushes the debounced auto-save and shows a check-mark pulse on success (or a red pulse on failure).
  - Add a new subsection "Line numbers": per-block gutter restarting at 1, counts `\n` boundaries in the block's `text`.
  - Add a new subsection "Fuzzy search": floating searchbar (triggered by `/` when no input is focused), fuse.js scoring on block text only, highlights with `<mark>`.
  - Add a new subsection "Citadel Actions": configurable action presets (name + description + icon + prompt template) stored at `<dataDir>/citadel-actions.json`; built-in `refine-scratchpad` action seeds on first read; surfaced under a new "Actions" settings section.

- **`specs/B.7-operations-activity-mcp.md`** — MCP surface and scratchpad storage format.

  **Update required — concrete deltas:**
  - In the MCP tools list (~line 88): add `fuzzy_search_scratchpad(query, limit?) → { matches: [{ block, score, matches: [{ indices }] }] }` and `refine_scratchpad(repoId?, repoName?, prompt?) → { workspaceId, sessionId, warning? }`.
  - Add a new "HTTP endpoints" subsection (or extend the existing one) documenting `GET /api/scratchpad/blocks/search?q=&limit=`, `POST /api/scratchpad/refine`, and the `GET/POST/PUT/DELETE /api/citadel-actions[/:id]` cluster including `POST /api/citadel-actions/:id/reset`.
  - Document that `citadel-actions.json` lives next to `scratchpad.md` under `dataDir`, is JSON, is seeded with built-ins on first read, and is serialized through a daemon-side mutex.
  - Document that `refine_scratchpad` is a thin convenience over `launch_agent` — the MCP handler dispatches over HTTP to the daemon (does not import daemon modules).

No spec divergence — these are net-new behaviors, not behavior changes. Spec updates are the **first** implementation step.

## Implementation approach

### UX presentation — overlay drawer

The scratchpad opens as a **right-anchored overlay drawer** rendered inside the root `Shell` (`apps/web/src/main.tsx:107`), which wraps every route via `<Outlet />`. This means the drawer is reachable from `/`, `/settings`, `/history`, `/scheduled-agents`, etc. — true to the AC "open without hiding navigation" interpreted as "open from anywhere in the cockpit, never replaces the view." Rationale:

- Mounting in `Shell` (not in `Cockpit`) means the panel survives route changes — no remount, no state loss when the user navigates between pages with the drawer open.
- Keeps the left navigator visible whenever the user is on `/` (the cockpit) → satisfies "open without hiding navigation" for the primary view.
- "Exit" hides the drawer in place → no SSE refetch, no route transition → satisfies "exiting feels instant."
- The existing `/scratchpad` route stays as a deep-link entry that converges on the same drawer.

**Mounting & state lifecycle:** `ScratchpadPanel` is rendered as a sibling to `<Outlet />` inside `Shell` and is **always mounted** (once per app session). When closed, the panel root has the `hidden` HTML attribute (`display: none` semantics with React vdom retained). This:
- Preserves all local state (scrollTop, searchQuery, wasAtBottom, gutter sync, blocks cache) across close/reopen AND across route changes — no context, no Zustand, no sessionStorage handoff.
- Visibility is driven by a `scratchpadOpen` boolean lifted out of `Cockpit` into `Shell` (a `useState` in `Shell` plus a simple module-level event-emitter is sufficient; alternative: a tiny `ScratchpadDrawerContext` provider rendered at the same level). Pick the one that keeps `Shell` simpler — the module-level emitter is fine since `Shell` is the only writer and `ScratchpadPanel`/`Navigator`/`Cockpit` keyboard handler are the only readers.
- **SSE policy:** the EventSource subscription is panel-lifetime-scoped (NOT gated on `open`). The panel is always mounted, so SSE stays attached for the whole session. Closing the drawer keeps state fresh — when the user reopens, no refetch is needed because the panel has been listening all along. This matches the multi-tab/MCP-driven model the scratchpad spec calls out (B.7).
- **Keyboard shortcut wiring:** since the keydown handler currently lives in `Cockpit` and we want `cmd+shift+s` to work even on `/settings`, the keydown listener also moves into `Shell` (or a small `useGlobalKeydown` hook called from `Shell`). The Cockpit-specific shortcuts (`cmd+k`, `c`, etc.) stay where they are.

**`/scratchpad` deep-link handoff:** the existing `/scratchpad` route is reduced to a redirect component:
1. On mount, call `setOpen(true)` via the drawer-store emitter.
2. Read the stored last-route via `loadLastRoute()` (storage-only accessor in `apps/web/src/lib/last-route.ts` — NOT `bootstrapLastRoute`, which is the pre-router URL-bar shim guarded by `isBareRootLanding`).
3. Compute the redirect target: `loadLastRoute()` if it returns a non-`/scratchpad` path, else `/`. Then `navigate(target + "?scratchpad=1", { replace: true })`.
4. Add `/scratchpad` to `EXCLUDED_PREFIXES` in `apps/web/src/lib/last-route.ts` so the router's `onResolved` subscriber (which calls `saveLastRoute(event.toLocation.href)`) never persists `/scratchpad` as the last route — this is the belt-and-braces defense in addition to the in-redirect filter in step 3.

The query param is the source of truth at app cold-start; the in-memory `scratchpadOpen` state is the source of truth thereafter.

**`/scratchpad` is a one-shot deep link** — after the first visit it normalizes to `<last-route>?scratchpad=1` (or `/?scratchpad=1`) and subsequent navigations preserve that normalized form. Bookmarking `/scratchpad` works, but the URL bar will show the normalized form after navigation; this is intentional (consistent with how the drawer is now route-orthogonal).

Tests assert:
- `/scratchpad` URL with no prior last-route → drawer open, URL normalized to `/?scratchpad=1`.
- `/scratchpad` URL with last-route = `/settings` → drawer open over settings, URL normalized to `/settings?scratchpad=1`.
- `/scratchpad` URL with last-route = `/scratchpad` (stale storage edge case) → drawer open at `/?scratchpad=1`, NOT a loop back to `/scratchpad?scratchpad=1`.
- `EXCLUDED_PREFIXES` change covered by `apps/web/src/lib/last-route.test.ts`: `saveLastRoute("/scratchpad")` is a no-op.
- Toggling open via shortcut updates the query param without re-rendering the active route.
- Reload at `/settings?scratchpad=1` → settings view with the drawer open over it.

**Drawer width & responsive behavior:** desktop default `min(720px, 60vw)`, resizable via a left-edge handle (persisted in localStorage like the cockpit columns). On viewports narrower than 768px, the drawer expands to full width (covering the nav) since the nav itself collapses to the mobile switcher on those widths. Specify in CSS, no JS resize logic beyond what `startColumnDrag` already provides.

**File-size containment (file-size hard gate):** to keep the panel under 800 lines, extract into:
- `apps/web/src/scratchpad-panel.tsx` — shell, drawer header, state, SSE wiring, scroll-on-open effect.
- `apps/web/src/scratchpad-panel-block.tsx` — `BlockItem` + line-number gutter.
- `apps/web/src/scratchpad-panel-search.tsx` — floating searchbar component.
- `apps/web/src/scratchpad-refine-modal.tsx` — refine prompt modal.
- `apps/web/src/scratchpad-history-list.tsx` — version sidebar (already conceptually separate; extract during the move).
- `apps/web/src/scratchpad-diff-overlay.tsx` — the diff modal (similarly).
- `apps/web/src/scratchpad-drawer-store.ts` — module-level emitter / hook for `scratchpadOpen` and toggle (so `Shell`, `Navigator`, and the redirect route share the same source of truth).

For the MCP package (`packages/mcp/src/index.ts` currently 762 lines), extract scratchpad-specific tool handlers into `packages/mcp/src/scratchpad-handlers.ts` and import them. The `main.tsx`/`Shell` shortcut additions are minimal (one shared keydown effect) — no extraction required, but if the diff grows, extract into `apps/web/src/shell-shortcuts.ts`.

### Line numbers — per-block gutter restarting at 1

Each block gets a left gutter showing line numbers `1, 2, 3, …` counting newlines within that block's `text`. Block boundaries reset the counter. Rationale:

- Blocks are the unit (the data model already groups by block) — a single document-wide counter would be misleading because reordering blocks would shift numbers.
- In read-only mode the gutter is rendered alongside the sanitized HTML; in edit mode it sits next to the textarea, kept in sync via the same scroll position. (Edit-mode line numbers are a "if cheap, include" — the read-only gutter is the AC; we'll ship the textarea-mode gutter too unless it bloats the panel.)

**Wrap & sync details:** the textarea uses `wrap="off"` with `overflow-x: auto` so visual lines and `\n`-counted lines stay 1:1. The gutter is a sibling element with the **same** `font-family`, `font-size`, `line-height`, and `padding-top` as the textarea/rendered HTML. The textarea's `onScroll` forwards `scrollTop` to the gutter's `scrollTop`. Test coverage: a block with a long line (no newlines) renders exactly one gutter row regardless of horizontal overflow; a block with three `\n`s renders four gutter rows; resizing the drawer does not desync the gutter.

**Trade-off acknowledged:** `wrap="off"` means long single-line content forces horizontal scroll inside the drawer instead of soft-wrapping. We accept this as the cost of accurate gutter sync — users are expected to break long lines with explicit `\n`s in markdown content. A virtual-line-counting alternative (preserve soft-wrap, count visual lines) was considered and rejected for this PR (extra complexity, brittle across font/zoom changes).

### Auto-scroll-to-bottom on open

The existing effect (`apps/web/src/routes/scratchpad.tsx:108–112`) scrolls on `blocks.length` change but only after initial load completes. The "open" event currently doesn't exist (it's a route mount). With the drawer:

- A dedicated `scrollToBottomOnOpen` effect runs on the **first** open per session (initial mount + blocks loaded) using `useLayoutEffect` so the scroll happens before paint.
- On subsequent reopens, the scroll position is **preserved** (the drawer keeps state alive); we only auto-scroll-to-bottom on reopen if the user was already at the bottom (`scrollTop + clientHeight >= scrollHeight - 4px` tolerance) when they closed. The "was-at-bottom" flag is captured on close.
- If a search is active, no auto-scroll fires regardless — the user's match position takes precedence.
- Tests assert: first open → scroll-to-bottom fires; close mid-scroll → reopen preserves scrollTop; close at bottom → reopen with new blocks → still at bottom.

### Keyboard shortcuts

Two new shortcuts. `cmd/ctrl + shift + s` is registered at the **Shell** level (so it works on every route, not just `/`); `cmd/ctrl + s` is registered inside the panel itself (so it only fires when the drawer is open). The existing cockpit-level handler (`apps/web/src/cockpit.tsx:75–119`) keeps `cmd+k`, `c`, and `ctrl+n` — those remain cockpit-scoped because they create or navigate to cockpit-specific surfaces.

- `cmd/ctrl + shift + s` (Shell-level) — `preventDefault`, toggle the scratchpad drawer via the `scratchpad-drawer-store` emitter. Works from any route. Updates the `?scratchpad=1` query param via `router.navigate({ search: …, replace: true })` so reloads preserve drawer state.
- `cmd/ctrl + s` (only when the drawer is open) — `preventDefault`, flush the pending debounced auto-save (cancel pending timer + issue PUT immediately), and on **successful response** show a green checkmark pulse animation in the drawer header for ~800ms. On **failed response** show a red error pulse and surface the error inline (same channel as existing `composerError`/`loadError`). Pulse never fires on press alone. The pulse timer is held in a single `useRef<number | null>` — every new pulse clears the prior timer before setting a new one (so rapid `cmd+s` double-presses don't race the removal-edge timeout). Tests cover: single fire (set + clear); double fire within 800ms (attribute remains set through both windows, cleared once 800ms after the second response).

The left-nav scratchpad link gets a small `<kbd>` hint next to the label using **text labels** (`Shift+Cmd+S` on Mac, `Shift+Ctrl+S` elsewhere) — no Mac-specific glyph chars (`⇧⌘`) since they don't render reliably across platform fonts. Platform detection via `navigator.platform` (the same pattern used elsewhere in the cockpit).

**Shortcut precedence & input-focus guards:**
- The `/` searchbar trigger (see Fuzzy search) only fires when no input/textarea/contenteditable element is focused (use the same `inEditable` check pattern as `cockpit.tsx:78`).
- `Esc` precedence inside the drawer: (1) if searchbar is open, clear/close it; (2) else if a block is being edited, cancel that edit; (3) else if the diff modal is open, close it; (4) else close the drawer.
- `cmd+s` only fires when the drawer is open; it does NOT trigger anywhere else (avoids confusing the user with "save what?" elsewhere in the cockpit).

### Instant exit

Drawer close is a simple `setOpen(false)`. We remove the prior delay by:
- Not refetching blocks on close (the drawer keeps state alive; reopening is instant too).
- No CSS transition longer than `120ms` on the drawer slide-out.

### Fuzzy search

Floating searchbar at the top-right of the drawer, opens with `/` (the only currently-unused easy key inside the drawer; not used by the cockpit either). Uses **fuse.js** with:

- Threshold ~0.3 (forgiving but not noisy).
- Single field: `text` of `ScratchpadBlockSummary`.
- `includeMatches: true` so we can highlight hits inline.

When a query is active:
- Non-matching blocks collapse out of the list.
- Matching blocks render with `<mark>` around each match index range (using fuse's match info).
- `Esc` clears the query and closes the searchbar.

**Performance:**
- The query input is **debounced ~80ms** before triggering a re-search — keystroke jitter doesn't re-run fuse on every char.
- The `Fuse` instance is `useMemo`-ed on `blocks` identity (not on every render or every keystroke). Re-instantiated only when the block array reference changes.
- Test: `Fuse` constructor is called once per blocks-change, not once per keystroke (spy on the constructor; type 5 chars; assert 1 invocation, not 5).

**MCP exposure** — new tool `fuzzy_search_scratchpad`:

```
{
  name: "fuzzy_search_scratchpad",
  inputSchema: {
    query: string (min 1),
    limit?: number (1..50, default 20)
  },
  output: { matches: [{ block: ScratchpadBlockSummary, score: number, matches: [{ indices: [number, number][] }] }] }
}
```

Daemon endpoint: `GET /api/scratchpad/blocks/search?q=…&limit=…`. The fuzzy logic is shared between the daemon endpoint and the web — both import a `fuzzySearchBlocks(blocks, query, limit)` function from a new `packages/core/src/scratchpad-search.ts`. Core stays pure.

**Architecture-boundary verification (architecture-boundary hard gate):** before merge, verify fuse.js has no `fs`, `process`, `node:*`, `react`, or other forbidden imports — `pnpm why fuse.js` + a quick `grep -rE "require\\(|from ['\"]node:|from ['\"]fs" node_modules/fuse.js/dist/` check. fuse.js is published as browser+node compatible UMD/ESM. The architecture-boundaries script (`scripts/checks/architecture-boundaries.ts`) operates on source imports, not transitive deps, so adding `fuse.js` to `packages/core/package.json` is allowed as long as core's own source doesn't grow forbidden imports. Document the verification step in the PR description.

**Lockfile gate:** pin fuse.js to a specific minor (e.g. `^7.0.0` if current; whatever is latest stable at implementation time). Add the dep via `pnpm add fuse.js --filter @citadel/core`. Note that fuse.js has no `preinstall`/`install`/`postinstall` lifecycle scripts (verified at install time) — call this out in the PR description.

### Refine button + Citadel Actions

**Data shape** — a "Citadel Action" is:

```ts
type CitadelAction = {
  id: string;              // stable slug, e.g. "refine-scratchpad"
  name: string;            // display name, e.g. "Refine scratchpad"
  description?: string;
  icon?: string;           // lucide icon name
  promptTemplate: string;  // raw prompt string with {{placeholders}}
  builtIn?: boolean;       // built-ins can be reset to default but not deleted
};
```

**Storage:** a new JSON file at `<dataDir>/citadel-actions.json` (parallel to `scratchpad.md`). Reasoning: keeps the existing zod-validated `citadel.config.json` schema untouched; CRUD is dead simple; file is small.

**Concurrency:** writes are serialized through a daemon-side mutex on the file (one promise queue per dataDir). Two browser tabs editing the same action: the second PUT waits for the first to land, then re-reads. Reads are not serialized. We also include an `updatedAt` field on each action; client PUTs send the `updatedAt` they last saw, and the daemon returns `409` if the stored `updatedAt` is newer (stale-write protection). The mutex is the floor (no torn writes); the `updatedAt` check is the ceiling (no silent overwrites).

**Built-in default action — `refine-scratchpad`:**

```
You are working on a Citadel scratchpad — a markdown file split into UUID-fenced blocks.
Use the citadel MCP server's read_scratchpad / list_blocks tools to read the current state.

Task: deduplicate similar items, group related items together, and tidy formatting.
NEVER touch blocks whose text begins with a status header line ending in `\`in-progress\``
(format: \`**<title>** — \`in-progress\`\`) — those blocks are owned by other agents and
must be left untouched.

Use update_block / add_block / delete_block to apply your changes. Do not call
write_scratchpad (which would clobber concurrent edits).
```

**Settings UI** — add a `citadel-actions` section to `apps/web/src/routes/settings.tsx`:
- Lists actions; each row shows name + description + a "Reset to default" button (for built-ins) or "Delete" (for custom).
- Editor pane on selection lets the user edit name, description, icon, and prompt template.
- "New action" button creates a custom action.

**Refine button placement:** drawer header, to the left of the close button. Icon: lucide `Wand2`.

**Refine flow** when clicked:
1. Open a small modal pre-filled with the saved `refine-scratchpad` prompt and a "Will run in: `<repo-name>`" line (the cockpit's currently active repo by default; if none active, the line shows a repo dropdown). The repo line is always shown and always overridable via the same dropdown.
2. User can edit the prompt for this run only (does not persist back unless they explicitly click "Save as default").
3. On confirm, POST `/api/scratchpad/refine` with `{ prompt, repoId }`.
4. Daemon calls `OperationService.launchAgent({ repoId, prompt, runtimeId: "claude-code", workspaceName: \`refine-scratchpad-<timestamp>\` })`.
5. Returns the new workspace + session id (plus an optional `warning` string); UI redirects to that workspace in the cockpit.

**Degradation (provider-degradation hard gate):**
- If no `claude-code` runtime is registered, `POST /api/scratchpad/refine` returns `400 { error: "runtime_unavailable", detail: "claude-code runtime is not configured" }`. The modal surfaces the message inline with a "Configure runtime" deep-link to `/settings#agents`. Modal stays open.
- If the relevant provider's health is `unavailable` (per `list_provider_health`), the daemon still attempts the launch (matches existing `launch_agent` semantics) but the response includes `warning: "provider <name> is currently unhealthy; the agent may not be able to complete"`. The modal renders this inline.
- If `OperationService.launchAgent` throws after creating the workspace, the daemon catches and removes the orphan workspace (best-effort `removeWorkspace` under the existing cleanup-safety policy — only if the worktree is clean), then returns `502 { error: "launch_failed", detail }`. If cleanup itself fails (dirty worktree), the workspace persists and the error response includes its id so the user can clean it up manually.
- If no repo is configured at all (fresh install), the modal disables the confirm button and instructs the user to register a repo in Settings.

**`in-progress` safeguard:** before launch, the daemon checks whether the resolved prompt contains the literal substring `in-progress` (case-insensitive). If it does NOT, the response includes `warning: "Your refine prompt does not mention 'in-progress' — blocks owned by other agents may be modified."`. The modal renders this warning inline above the launch button on a second click ("Launch anyway" / "Cancel"). This is a soft check, not a hard block — the user is in control.

**Workspace-cleanup-safety:** refine workspaces are normal workspaces from a lifecycle perspective. They follow the existing cleanup-safety policy (no auto-delete of dirty worktrees, ever). Naming follows `refine-scratchpad-<ISO-date-truncated-to-minute>` so the user can identify and clean them up later from Settings.

**MCP exposure** — new tool `refine_scratchpad`:

```
{
  name: "refine_scratchpad",
  description: "Launch a refine pass over the scratchpad. Uses the user's saved 'refine-scratchpad' Citadel Action prompt by default; pass `prompt` to override for this run. Returns { workspaceId, sessionId } of the launched agent.",
  inputSchema: {
    repoId?: string,
    repoName?: string,
    prompt?: string,    // overrides saved template
  }
}
```

This is a thin convenience wrapper around `launch_agent`. **Architecture-boundary compliance:** `packages/mcp` must not import `@citadel/daemon`. The MCP handler dispatches over HTTP to `POST /api/scratchpad/refine` using the same daemon-MCP bridge pattern already used by `launch_agent` (`apps/daemon/src/daemon-mcp-tool.ts` exposes the MCP-to-HTTP shim). The handler reads the daemon base URL from the existing MCP runtime context (same field `launch_agent` uses).

**MCP response shape — discriminated union.** Both success and failure paths share a single documented `output` shape, tagged by `ok`:

```ts
type RefineScratchpadOutput =
  | { ok: true; workspaceId: string; sessionId: string; warning?: string }
  | { ok: false; error: "runtime_unavailable" | "repo_required" | "launch_failed"; detail: string; workspaceId?: string };
```

The MCP tool definition documents this union explicitly so downstream-agent consumers can branch on `ok`. The MCP handler in `packages/mcp/src/scratchpad-handlers.ts` maps the daemon's HTTP status + body to this shape (200 → `ok: true`; 400/502 → `ok: false`).

### `<>` formatting bug

Hypothesis confirmed by reading `apps/web/src/routes/scratchpad-markdown.ts`: `marked.parse(text, { breaks: true })` treats `<foo>` as inline HTML; `DOMPurify.sanitize` then strips the unknown tag → the rendered HTML loses content.

**Risk: autolinks** — markdown has a legitimate construct `<https://example.com>` and `<foo@bar.com>` (autolinks) that share angle-bracket syntax with raw HTML. Whatever fix we ship must preserve autolinks.

**Fix approach (TDD):**

1. Add failing tests:
   - `renderBlockMarkdown("lookup <user_id> in the table")` → DOM contains the visible text `<user_id>` (or escaped `&lt;user_id&gt;` in HTML source).
   - `renderBlockMarkdown("see <https://example.com>")` → contains `<a href="https://example.com">` (autolink preserved).
   - `renderBlockMarkdown("contact <foo@bar.com>")` → contains `<a href="mailto:foo@bar.com">` (email autolink preserved).
   - Fenced-code variant: ``` ```\n<user_id>\n``` ``` → inside `<pre><code>`, brackets escaped (existing escaping rule).
   - Inline-code variant: `` `<user_id>` `` → inside `<code>`, brackets escaped.
2. Pick the fix mechanism, in order of preference (try first, validate against the test suite, move to next if a test fails):
   - **(a) Override the `html` tokenizer in marked v12+** via `marked.use({ extensions: [...], tokenizer: { html(_src) { return undefined; } } })` — returning `undefined` opts out of the html tokenizer and lets text/autolink/other tokenizers handle the input. (The exact API surface — `tokenizer` vs `extensions` — must be confirmed at implementation time against the installed marked version; the implementation step is gated by passing the autolink-preservation tests.)
   - **(b) `walkTokens` post-pass** — keep marked's default tokenization but walk the AST and convert any `html`-typed text token whose `raw` doesn't match an autolink/email shape into a plain `text` token with escaped content.
   - **(c) Pre-escape angle brackets in text segments only** — last resort; brittle.
3. Re-run all existing sanitization tests in `apps/web/src/routes/scratchpad-markdown.test.ts` (script-tag stripping, javascript:-URL stripping, `<img>` forbidden) — must still pass. DOMPurify remains the second-stage guarantor: even if marked emits unexpected HTML, DOMPurify sanitizes.
4. New tests + existing tests together prove BOTH invariants: angle-bracket text is preserved (positive presence) AND XSS payloads are stripped (negative absence).

**Why this is safe:** the two-stage pipeline (marked → DOMPurify) means we can shift behavior in marked confidently — DOMPurify is the security net. The risk is rendering correctness (autolinks), addressed by tests in step 1.

**Targeted-revert candidate:** this markdown-renderer change is the highest-risk single point of failure in the PR. If a regression surfaces post-merge, the fix is a one-file revert of `apps/web/src/routes/scratchpad-markdown.ts` (the rest of the PR is independent). Call this out in the PR description.

## Alternatives considered

**Alternative 1 — Nested route with persistent shell instead of overlay drawer.** Refactor the router so cockpit-shell is a layout for all routes (`/`, `/scratchpad`, `/settings`, etc.) and the right-side content is the route outlet. Cleaner long-term, but touches every existing route (settings, history, scheduled-agents, operations, onboarding, dashboard, repo-settings). Risk vs reward is bad — overlay drawer ships the same UX with zero blast radius.

**Alternative 2 — Pre-escape `<` and `>` in user text before passing to marked.** Walk the input string, escape `<`/`>` outside fenced code blocks and inline backticks. Rejected: brittle (we'd be partially reimplementing marked's tokenizer), and `marked.use({ tokenizer: { html: false } })` is a one-line fix supported by the library.

**Alternative 3 — Make `refine_scratchpad` return the refined content directly (synchronous LLM call from the daemon).** Rejected: the daemon doesn't run LLM inference itself; the refine flow is "spawn an agent that uses the MCP" — keeping this pattern uniform with `launch_agent` is the right shape, and lets the user watch progress in the cockpit.

**Alternative 4 — Per-line line numbers (single document-wide counter).** Rejected per the rationale in Implementation approach.

## Implementation steps

Grouped by reviewable unit; each becomes one task in the `/implement-task` skeleton.

### Step 1 — Spec updates (FIRST)

- Edit `specs/B.2-ade-cockpit.md` to document the drawer presentation, `cmd+shift+s` toggle, line-number gutter, fuzzy searchbar, and Citadel Actions surface.
- Edit `specs/B.7-operations-activity-mcp.md` to document `fuzzy_search_scratchpad`, `refine_scratchpad`, the new HTTP endpoints, and the `citadel-actions.json` storage file.

### Step 2 — `<>` formatting bug

- Add failing regression test in `apps/web/src/routes/scratchpad-markdown.test.ts` covering bare `<word>`, `<word_with_underscore>`, `<word with spaces>`, and the same inputs inside fenced code blocks (where they MUST still render as code).
- Update `apps/web/src/routes/scratchpad-markdown.ts` to disable marked's inline+block HTML tokenizers.
- Verify all existing sanitization tests still pass.

### Step 3 — Drawer extraction + Shell-level mount + auto-scroll-on-open

- Create `apps/web/src/scratchpad-drawer-store.ts` — module-level emitter + `useScratchpadDrawer()` hook exposing `{ open, toggle, setOpen }`.
- Extract the inner UI of `apps/web/src/routes/scratchpad.tsx` into a new `apps/web/src/scratchpad-panel.tsx` component (and the file-split children listed above) — the panel reads its visibility from `useScratchpadDrawer()`.
- Render `ScratchpadPanel` as a sibling to `<Outlet />` inside `Shell` in `apps/web/src/main.tsx`. Use the `hidden` attribute when `open` is false.
- Move the `cmd/ctrl+shift+s` keydown handler into `Shell` (or a small `useGlobalKeydown` hook called from `Shell`); it toggles the drawer via the store and updates `?scratchpad=1` via the router.
- Replace the `/scratchpad` route component with a redirect: on mount, call `setOpen(true)`, then `navigate` to `loadLastRoute()` (filtered to ignore stale `/scratchpad` values) or `/` with `?scratchpad=1`.
- Add `/scratchpad` to `EXCLUDED_PREFIXES` in `apps/web/src/lib/last-route.ts` so the route never persists itself as the last-visited route.
- Implement `useLayoutEffect` to scroll to bottom on the **first** `open=false → true` transition per session (subsequent reopens preserve scrollTop unless was-at-bottom).
- Keep SSE attached for the panel's lifetime (NOT gated on `open`) so closed-drawer state remains fresh from MCP/multi-tab writers.
- Implement the close handler with no SSE refetch and ≤120ms CSS transition.

### Step 4 — Line numbers gutter

- New `apps/web/src/scratchpad-line-numbers.tsx` (or a self-contained sub-component inside the panel file if small).
- Render `1..N` (N = lines in `block.text`) in a fixed-width gutter to the left of the block content for both read-only and editing modes.
- Keep textarea + gutter scroll in sync (textarea's `onScroll` propagates `scrollTop` to the gutter).

### Step 5 — Keyboard shortcuts

- Wire `cmd/ctrl + shift + s` into the Shell-level keydown handler (set up in Step 3).
- Wire `cmd/ctrl + s` inside the panel itself (only fires when the panel is open and visible — the `hidden` attribute does not block React keydown handlers, so the handler explicitly checks `open` from the drawer store).
- Add the platform-aware `<kbd>` hint to the left-nav scratchpad link in `apps/web/src/navigator.tsx`.
- Add the save-confirmation pulse: when `cmd+s` fires AND the PUT resolves successfully, surface a temporary `data-saving="ok"` attribute on the drawer header; on failure, `data-saving="err"`. CSS handles the brief pulse animation (≤800ms). Use a single `useRef<number | null>` to hold the removal-edge timeout id and clear it on every new pulse (race-safe under rapid double-press).

### Step 6 — Fuzzy search (shared core + UI + MCP)

- Add `fuse.js` as a dependency of `packages/core` (or wherever `scratchpad-blocks.ts` resolves cleanly).
- Implement `fuzzySearchBlocks(blocks, query, limit)` in `packages/core/src/scratchpad-search.ts` returning `{ block, score, matches }[]`.
- Daemon endpoint `GET /api/scratchpad/blocks/search?q=…&limit=…` in `apps/daemon/src/scratchpad-routes.ts`.
- Floating searchbar UI in the panel, triggered by `/` when the panel is focused. Highlights matches with `<mark>`.
- MCP tool `fuzzy_search_scratchpad` registered in `packages/mcp/src/scratchpad-tools.ts`; handler wired in `packages/mcp/src/index.ts`.

### Step 7 — Citadel Actions storage + settings page

- Add a `CitadelAction` contract in `packages/contracts/src/index.ts` (Zod schema + type) and a list/CRUD endpoint cluster on the daemon: `GET /api/citadel-actions`, `PUT /api/citadel-actions/:id`, `POST /api/citadel-actions`, `DELETE /api/citadel-actions/:id`, `POST /api/citadel-actions/:id/reset` (for built-ins).
- Storage at `<dataDir>/citadel-actions.json`. Daemon module: `apps/daemon/src/citadel-actions.ts`. On first read, seed with the built-in `refine-scratchpad` action.
- Add `"actions"` section to `apps/web/src/routes/settings.tsx` (new SECTIONS entry); panel implementation in `apps/web/src/settings-citadel-actions.tsx`. Mirrors the structure of `settings-runtimes.tsx`.

### Step 8 — Refine button + flow + MCP

- Refine button in the panel header (lucide `Wand2`) opens a modal pre-filled with the `refine-scratchpad` action's `promptTemplate`.
- Modal lets the user edit the prompt for this run; "Save as default" updates the stored template.
- On confirm, POST `/api/scratchpad/refine` → daemon resolves prompt + repo → calls `OperationService.launchAgent({ … })` → returns `{ workspaceId, sessionId }`.
- UI: cockpit navigates to the launched workspace.
- MCP tool `refine_scratchpad` in `packages/mcp/src/scratchpad-tools.ts`; handler in `packages/mcp/src/index.ts` proxies through the daemon's launch path (the same way other MCP-launch flows work).

### Step 9 — Contract & spec regeneration

- Run any contract bundle regen (`pnpm -r build` exercises it via project references; no separate generator).
- Verify the new MCP tool defs surface in the MCP server's tool list (`packages/mcp/src/index.test.ts` should be updated, see Tests).

### Step 10 — Verification + browser pass

- `make check`, `make e2e`, `make smoke` (daemon HTTP surface changed).
- `make deploy` from the worktree; manually exercise all 9 ACs in the browser per CLAUDE.md.

### Migration strategy

No schema changes. The new `citadel-actions.json` file is created on first read with the built-in action seeded; existing installs gracefully pick it up. The scratchpad storage format is unchanged.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Markdown renderer (regression for `<>` bug), fuzzy search core, citadel-actions storage, scratchpad-routes new endpoints, MCP tool handlers, UI panel component (open/close/scroll/save-pulse), settings citadel-actions panel. |
| E2E (Playwright) | **Required** | Full user flows: drawer open via nav click + via `cmd+shift+s`, close returns to cockpit, save-pulse on `cmd+s`, search filters list, refine launches a workspace, `<>` content renders intact end-to-end. |

### New tests to add

**Unit — markdown renderer (the `<>` bug):**
- `apps/web/src/routes/scratchpad-markdown.test.ts`:
  - `it("preserves bare angle-bracket sequences as text")` — `renderBlockMarkdown("lookup <user_id> in users")` → output contains `&lt;user_id&gt;` (or visible `<user_id>` in DOM).
  - `it("preserves https autolinks")` — `renderBlockMarkdown("see <https://example.com>")` → contains `<a href="https://example.com">` with `rel="noopener noreferrer" target="_blank"`.
  - `it("preserves email autolinks")` — `renderBlockMarkdown("contact <foo@bar.com>")` → contains `<a href="mailto:foo@bar.com">`.
  - `it("preserves angle-bracket sequences inside fenced code blocks")` — fenced ``` ```\n<foo>\n``` ``` renders inside `<pre><code>` with brackets escaped.
  - `it("preserves angle-bracket sequences inside inline code")` — `` `<foo>` `` renders inside `<code>` with brackets escaped.
  - Round-trip property: parse → sanitize → text-extract → input text contains every angle-bracket fragment from the input.

**Unit — fuzzy search core:**
- `packages/core/src/scratchpad-search.test.ts`:
  - Empty query → all blocks returned in original order (or empty, depending on the chosen spec — plan calls for empty result on empty query).
  - Single-word query → ranks blocks by similarity, ties broken deterministically by `updatedAt` desc.
  - Multi-word query → at least one match indices range covers each word.
  - Limit respected.
  - Diacritic / case insensitive.

**Unit — citadel-actions storage:**
- `apps/daemon/src/citadel-actions.test.ts`:
  - First read seeds the built-in `refine-scratchpad` action.
  - Updating a built-in's prompt persists.
  - Reset restores the built-in default (compared against a frozen string constant).
  - Cannot delete a built-in (`409` or similar).
  - Custom actions: full CRUD round-trip.
  - Concurrent writes (mutex): two `await Promise.all([put(A), put(B)])` calls land one after the other (file content reflects exactly one of A or B, not a torn merge); the loser's response is `409 stale_updated_at` if it sent an older `updatedAt`.
  - `updatedAt` field returned on every read; PUT without `updatedAt` from client is rejected `400`.

**Unit — scratchpad-routes new endpoints:**
- `apps/daemon/src/scratchpad-routes.test.ts` (or `scratchpad-routes-blocks.test.ts`):
  - `GET /api/scratchpad/blocks/search?q=…` returns the expected fuzzy results.
  - Missing/empty `q` → 400.
  - `limit` clamping to 1..50.
- `apps/daemon/src/scratchpad-refine-route.test.ts` (new):
  - `POST /api/scratchpad/refine` resolves the saved prompt template when no `prompt` body provided.
  - Delegates to `OperationService.launchAgent` with the right `runtimeId`, `prompt`, and `workspaceName` shape.
  - Returns `400 runtime_unavailable` when `claude-code` runtime is not registered.
  - Returns `400 repo_required` when no `repoId` provided and no active repo can be inferred.
  - Returns a response with `warning` when the prompt does not contain `in-progress` (case-insensitive).
  - Returns a response with `warning` when the relevant provider's health is `unavailable` (mock the health source).
  - On `launchAgent` throw mid-flow, the route cleans up the just-created workspace if its worktree is clean; responds `502 launch_failed`. If the worktree is dirty, the route leaves the workspace and responds `502 launch_failed { workspaceId }`.

**Unit — MCP tool handlers:**
- `packages/mcp/src/index.test.ts` (and the colocated `packages/mcp/src/scratchpad-handlers.test.ts` for the extracted module):
  - Tool list contains `fuzzy_search_scratchpad` and `refine_scratchpad`.
  - `fuzzy_search_scratchpad` calls into the same fuzzy core with the right arguments; output shape matches the inputSchema's documented output.
  - `refine_scratchpad` issues an HTTP fetch to `POST /api/scratchpad/refine` (mock the fetch) — does NOT import daemon modules (verified by `check:arch`).
  - `refine_scratchpad` 200-OK response → MCP output is `{ ok: true, workspaceId, sessionId, warning? }`.
  - `refine_scratchpad` 400 (`runtime_unavailable`, `repo_required`) → MCP output is `{ ok: false, error, detail }`.
  - `refine_scratchpad` 502 (`launch_failed`) → MCP output is `{ ok: false, error: "launch_failed", detail, workspaceId? }`.

**Unit — UI panel:**
- `apps/web/src/scratchpad-panel.test.tsx` (new):
  - Renders blocks; `open=false` → panel root has the `hidden` HTML attribute (panel stays mounted, internal state preserved across open/close).
  - Reopening after a manual scroll preserves `scrollTop` (state-preservation test — relies on the always-mounted policy).
  - Route change (`/` → `/settings`) does NOT unmount the panel (assert by spying on a `useEffect` cleanup that should NOT fire).
  - SSE listener remains attached after the panel is closed (assert by counting `addEventListener` invocations across open/close cycles — should be 1 across the panel's lifetime).
  - `cmd+s` while editing: pending debounce timer is cancelled, PUT fires immediately, on successful response the `data-saving="ok"` attribute is set then removed after ~800ms (assert both edges).
  - `cmd+s` save failure: `data-saving="err"` set, then removed; error surfaces in the existing error channel.
  - Auto-scroll-to-bottom fires on **first** open after load, but a subsequent close-then-reopen preserves `scrollTop` unless the user was at the bottom on close.
  - Auto-scroll does NOT fire when a search is active.
  - Line numbers render `1..N` matching `\n` count; long-line (no `\n`) renders exactly one gutter row.
  - Textarea scroll forwards `scrollTop` to the gutter (mock `onScroll`).
  - Searchbar with query `"foo"` filters the list and renders `<mark>` highlights using fuse's match indices.
  - `/` does NOT open the searchbar when a textarea is focused.
  - `Esc` precedence: searchbar open → clears search; else editing → cancels edit; else diff modal open → closes modal; else → closes drawer.

**Unit — Shell-level shortcut + drawer store:**
- `apps/web/src/scratchpad-drawer-store.test.ts` (new):
  - `toggle()` flips `open`; `setOpen(true)` is idempotent.
  - Subscribers receive notifications synchronously.
- `apps/web/src/main.test.tsx` or `apps/web/src/shell.test.tsx` (new — split `main.tsx` if needed for testability):
  - Dispatch `cmd+shift+s` `KeyboardEvent` while on `/` → drawer `open` flips.
  - Dispatch `cmd+shift+s` while on `/settings` → drawer `open` flips (Shell-level handler works from non-cockpit routes too).
  - Toggle open via shortcut sets `?scratchpad=1` query param; close removes it.
  - Mounting the app at URL `/?scratchpad=1` initializes the drawer open.
  - Mounting at `/settings?scratchpad=1` shows the settings view with the drawer open over it.
  - Visiting `/scratchpad` route → redirects to `/?scratchpad=1` (or last-route + param) and the drawer opens.

**Unit — settings citadel-actions:**
- `apps/web/src/settings-citadel-actions.test.tsx`:
  - Renders the seeded built-in action.
  - Edit + save updates the underlying state (mocked API).
  - Reset surfaces only on built-ins.

**E2E (Playwright) — new `e2e/scratchpad-editor.spec.ts`:**
- Open drawer via left-nav click; assert the nav stays visible.
- Close via header X; assert the cockpit underneath is still active (no route change).
- Toggle via `cmd+shift+s`; same assertion. Assert no Firefox/Chromium "save full page screenshot" or "save page" dialog fires (no `dialog` event raised).
- `cmd+s` while editing a block: visible check icon appears after the network response, then fades within ~1s. Mock-fail the response and assert the red error pulse path.
- Search: focus the panel (no input), press `/`, type a query; only matching blocks visible; `<mark>` highlights present. Press `Esc` once → searchbar closes; press `Esc` again → drawer closes.
- `<>` content: type into the composer `lookup <user_id>`, Cmd+Enter to submit; block flips to read-only on auto-save; DOM contains the visible text `<user_id>` (not stripped); reopen the block for edit; textarea value equals the original `lookup <user_id>`.
- Autolink: add a block `see <https://example.com>`; submit; rendered DOM has a clickable `<a href="https://example.com">`.
- Line numbers: add a multi-line block; gutter shows `1` through `N` matching `\n` count.
- Refine: click refine, target-repo line shows the active repo, edit prompt minimally, launch → cockpit navigates to a new workspace `refine-scratchpad-…`. If no `claude-code` runtime exists in the e2e setup, skip the navigation assertion and assert the inline `runtime_unavailable` error appears in the modal.

### Existing tests to update

- `apps/web/src/routes/scratchpad-markdown.test.ts` — keep all existing sanitization tests; add the new bug-regression tests.
- `apps/web/src/routes/scratchpad.tsx` tests (if any colocated) — if the file extracts a `ScratchpadPanel`, retarget tests to the new file.
- `packages/mcp/src/index.test.ts` — extend the tool-list assertion (line 12) to expect `fuzzy_search_scratchpad` and `refine_scratchpad`.
- `apps/daemon/src/scratchpad-routes.test.ts` — add fuzzy search endpoint coverage.

### Assertions to add/change/tighten

- Markdown renderer: assert input text fragments survive (positive presence), not just "no `<script>`" (negative absence). Tighten existing tests if any rely on `<word>` being stripped.
- Save-pulse: assert the DOM class is applied AND removed (no leaked stuck state).
- Drawer: assert no SSE refetch fires on close (mock `EventSource`; assert no additional listener calls between open and close).
- Refine: assert the launched workspace name starts with `refine-scratchpad-` and the prompt sent to `launchAgent` equals the template by default.

### Failure modes / edge cases / regression risks

- **Marked tokenizer disable breaks fenced HTML rendering** — fenced code blocks containing `<foo>` should still render. Covered by the new test.
- **DOMPurify still strips `<script>`** — covered by existing tests; we re-run them.
- **Auto-scroll fights the searchbar** — if a search is active, scroll-to-bottom should NOT fire on close→open (we'd scroll the user away from the match). Add a guard.
- **`cmd+s` collisions** — browsers bind `cmd+s` to "save page"; we must `preventDefault`. Test in Playwright that the browser dialog doesn't appear.
- **`cmd+shift+s` on Firefox** — Firefox binds `cmd+shift+s` to "save full page screenshot"; same `preventDefault` requirement. E2E coverage helps.
- **Refine in a worktree with no active repo** — the modal should show a repo picker rather than launching against a wrong repo. Cover with a unit test on the modal + an inline assertion.
- **fuse.js bundle size** — add `pnpm check:size` confirms; fuse.js gzipped is ~12KB. The `check:size` gate (800-line per-file) is unaffected.
- **Citadel Actions concurrent edits** — two windows editing the same action: daemon mutex serializes writes; `updatedAt` stale-write check returns `409` to the loser; UI shows a "this action was updated elsewhere — reload to see latest" message and keeps the user's draft so they can re-apply.
- **`in-progress` block detection in refine** — the agent prompt does the work, but if the prompt is overridden by the user, the safeguard is gone. That's by design (user is in control), but we add a soft warning in the modal: "your edits removed the `in-progress` safeguard."
- **Existing `/scratchpad` deep link** — must still work. Redirect-on-mount keeps the URL useable.

### Adversarial analysis

- **How could this fail in production?**
  - Marked HTML disable could regress markdown linking inside angle brackets like `<https://example.com>` (which is valid markdown autolink syntax). We must keep autolinks working — add a test.
  - Drawer state across workspace switches: if the user opens the drawer in workspace A, closes it, switches to B, reopens — the state (search query, scroll position) should reset. Add a coverage test.
  - Refine launches a workspace under the *wrong* repo (cockpit-active vs. user intent). Mitigation: the modal shows the target repo, lets the user override.

- **What user actions trigger unexpected behavior?**
  - User types `<` and then `>` quickly while auto-save fires mid-keystroke. The block flips read-only then back; we must not lose typing focus. Covered by existing tests for the editor; sanity-check with a Playwright test.
  - User binds `cmd+s` muscle memory to "browser save" — first encounter may surprise. Save-pulse confirmation mitigates.

- **What existing behavior could break?**
  - The `/scratchpad` route's history-sidebar restore flow stays intact (we move it into the drawer).
  - SSE listeners are now panel-lifetime-scoped (always attached, not gated on `open`) so closed-drawer state stays fresh — verify the count doesn't multiply across route changes.
  - Moving the keydown handler from `Cockpit` to `Shell` could shadow existing cockpit shortcuts. Verify by running existing cockpit shortcut tests + Playwright happy-path before merging.

- **Which tests credibly catch those failures?**
  - Markdown autolink test, drawer-reset-on-reopen E2E, refine-target-repo unit, SSE listener attach/detach unit.

- **What gaps remain?**
  - Visual polish (animation feel) is unit-untestable — manual browser check via `make deploy`.
  - Cross-platform shortcut behavior on Linux/Windows browsers — E2E covers Chromium; we'll note Firefox cmd+shift+s caveat in the PR description.
  - No feature flag (user mandated "one PR"). Mitigation: PR description identifies the markdown-renderer change as the targeted-revert candidate (one-file revert of `apps/web/src/routes/scratchpad-markdown.ts` if a regression slips through); other sub-features live in distinct files and can be reverted independently.

## Tests

TDD order — write each test, see it fail, then implement.

1. `apps/web/src/routes/scratchpad-markdown.test.ts` — add `<>` regression tests (Step 2 first because it's the smallest, lowest-risk, and most user-visible bug).
2. `packages/core/src/scratchpad-search.test.ts` — fuzzy core (Step 6 prereq).
3. `apps/daemon/src/citadel-actions.test.ts` — storage (Step 7 prereq).
4. `apps/daemon/src/scratchpad-routes.test.ts` — add search endpoint + add refine endpoint test or new file (Step 6 + 8).
5. `packages/mcp/src/index.test.ts` — extend (Step 6 + 8).
6. `apps/web/src/scratchpad-panel.test.tsx` — UI behaviors (Steps 3, 4, 5).
7. `apps/web/src/cockpit.test.tsx` — shortcut wiring (Step 5).
8. `apps/web/src/settings-citadel-actions.test.tsx` — settings panel (Step 7).
9. `e2e/scratchpad-editor.spec.ts` — full user flows (Step 10).

## Schema or contract generation

No DB schema changes. Contracts (Zod schemas) get a new `CitadelActionSchema` and helper types in `packages/contracts/src/index.ts` — picked up by `pnpm -r build` via TypeScript project references; no separate codegen step.

## Verification

- `make check` — full local gate (architecture, size, typecheck, lint, vitest, coverage, deps, build).
- `make e2e` — Playwright happy-path including the new `scratchpad-editor.spec.ts`.
- `make smoke` — daemon HTTP surface changed. **Extend the smoke fixtures** to cover the new endpoints:
  - `GET /api/scratchpad/blocks/search?q=test` → 200 with `{ matches: [...] }` shape.
  - `GET /api/citadel-actions` → 200 with seeded built-in.
  - `POST /api/scratchpad/refine` with no `repoId` against a runtime-less fixture → 400 `runtime_unavailable` (exercises the degradation branch without a real launch).
  - The smoke harness lives wherever existing smoke fixtures are (look under `apps/daemon/src/__smoke__/` or the `make smoke` target in the Makefile); add the three new probes there.
- `make deploy` followed by manual browser verification of every AC per CLAUDE.md.

`make performance` is **not** required — none of these changes touch the cockpit startup or hot-path rendering loops.
