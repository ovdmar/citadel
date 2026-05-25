Activate the /implement-task skill first.

# Plan: Block-based scratchpad

## Acceptance Criteria

- [ ] AC1: Existing scratchpads auto-migrate on first read; one history entry recorded with source `migrate-to-blocks`.
- [ ] AC2: Parser is idempotent: parse → serialize → parse is stable (same UUIDs preserved).
- [ ] AC3: Parser is lenient: malformed input does not throw; recovers per the rules above.
- [ ] AC4: All four new MCP tools (`list_blocks`, `add_block`, `update_block`, `delete_block`) work via daemon HTTP and via MCP.
- [ ] AC5: `append_scratchpad` produces a new fenced block, never merges into a prior one.
- [ ] AC6: UI: clicking a block enters edit; blur / Cmd-Enter / debounce all save; empty edits prune the block (delete).
- [ ] AC7: UI: pinned composer at bottom, autoscroll, Cmd-Enter creates a new block.
- [ ] AC8: Block delete from UI calls `delete_block` and refreshes.
- [ ] AC9: Version history timeline still works and shows the migration entry. Restoring an older (pre-migration, blank-line-separated) version restores it verbatim — the next read after restore will re-migrate.
- [ ] AC10: Unit tests: parser (round-trip, lenient cases, idempotency), migration (idempotent, single history entry), block CRUD via daemon, MCP tool plumbing. All existing tests pass.

## Context and problem statement

The per-workspace `scratchpad.md` is the user's ideas-capture surface that orchestrator agents read and append to via MCP. Today it is flat markdown with blank-line separators acting as the de-facto block boundary — both in the UI (a single `<textarea>`) and in `appendScratchpad` (inserts `\n\n` before the chunk). Two problems:

1. A blank line *inside* an idea is impossible — it would split the idea in two from the agent's perspective.
2. There is no stable identity for an "idea" — UI can't address blocks for inline edit/delete and history diffs are noisier than they need to be.

The goal is a block-based representation while keeping the file a regular markdown file so external tooling (git, editors, grep) still works. Each block is fenced with symmetric HTML-comment markers carrying a UUID; the parser is lenient; existing scratchpads auto-migrate on first read.

Touch points (verified):

- `apps/daemon/src/scratchpad.ts` — file I/O + write/append (71 LOC).
- `apps/daemon/src/scratchpad-history.ts` — versioning with 60s coalesce window, source-keyed (149 LOC; no structural changes).
- `apps/daemon/src/scratchpad-routes.ts` — HTTP routes for read/put/history/restore (52 LOC; add 4 block routes).
- `apps/daemon/src/daemon-mcp-tool.ts` — daemon-side MCP dispatcher (around L200–L228 for scratchpad).
- `packages/mcp/src/index.ts` — MCP tool registry (~L53–55 names, ~L409–438 schemas, ~L688–712 dispatcher).
- `packages/contracts/src/scratchpad.ts` — `ScratchpadSnapshot`, `ScratchpadHistorySource` (1-line file).
- `apps/web/src/routes/scratchpad.tsx` — UI (411 LOC; substantial rewrite).
- `apps/daemon/src/scratchpad.test.ts` (197 LOC) and `apps/daemon/src/scratchpad-routes.test.ts` (417 LOC) — extend.

## Spec alignment

Spec mapping per `.agents/skills/extensions/review-pr.md`:

- `packages/mcp/**`, `apps/daemon/**` → `specs/B.7-operations-activity-mcp.md` (Operations · Activity · MCP).
- `apps/web/**`, `packages/ui/**` → `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md`.
- `packages/contracts/**` → `specs/A-shared-definitions.md` plus the touched domain spec (B.7 here).

Grep-checked: no spec currently mentions "scratchpad" by name (`grep -i scratchpad specs/` returned no hits). The scratchpad is part of the MCP surface and the cockpit but is not described in those specs today. Two options:

- **Option A (chosen):** Add a "Scratchpad" subsection to `specs/B.7-operations-activity-mcp.md` describing the file layout (block fences with UUIDs), the MCP tool surface (`read/write/append` + four block ops), the migration rule, and the explicit `append_scratchpad` behavior-change callout. Add a "Scratchpad" subsection (proper section, not a sidebar note) to `specs/B.2-ade-cockpit.md` describing the click-to-edit / composer / undo / markdown-rendered UX.
- Option B: Skip the spec update because scratchpad has historically been undocumented. Rejected — spec gap pre-existed but Citadel uses specs-first development, so the right move is to document it as we extend it. This is the FIRST implementation step.

No domain-glossary changes required — block, scratchpad, snapshot, history entry are not in `specs/A-shared-definitions.md` today; they remain local concepts of the scratchpad subsystem.

## Implementation approach

### Storage layer (daemon)

Add a small `scratchpad-blocks.ts` module alongside `scratchpad.ts` with:

- `type Block = { id: string; text: string }` (id is full UUID v4, text is inner content without trailing newline).
- `parseBlocks(content: string): { blocks: Block[]; needsRewrite: boolean }` — lenient, idempotent.
- `serializeBlocks(blocks: Block[]): string` — canonical output (one trailing newline per block, one blank line between blocks, no `# Scratchpad` header preserved — see "Header handling" below).
- `migrateIfNeeded(content: string): { migrated: boolean; content: string }` — pure function, returns the new content and whether any rewrite is needed (covers both the blank-line legacy migration and the "unfenced top-of-file content" promotion).

Block fence regex (anchored, multi-line). Parser accepts any 8-4-4-4-12 hex sequence; generator always emits v4 UUIDs (`crypto.randomUUID()`):

```
^<!-- block:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) -->\n
([\s\S]*?)
\n<!-- /block:\1 -->(?:\n|$)
```

Note the back-reference (`\1`) — open and close UUIDs must match. Mismatched close fences are treated as content (lenient). Relaxed UUID shape (accept-any-hex, generate-v4) avoids re-promoting operator-pasted blocks that happen to use v1/v3/v5 UUIDs.

**Code-fence awareness.** The parser tracks triple-backtick state while scanning for the next open fence: a `<!-- block:... -->` line that appears inside a ` ``` ` code block in the *currently-open block's content* is content, not a new fence. Without this, an agent documenting the scratchpad format inside a block would silently corrupt the parse. Implementation: while consuming content for an open block, count opening/closing ` ``` ` line markers; only consider an open-fence line as the start of the next block when the code-fence depth is zero.

**Duplicate-UUID handling.** If `parseBlocks` encounters two open fences with the same UUID (file corruption, manual edit, or restore of a malformed snapshot), the second is parsed as an independent block but is reassigned a fresh UUID v4 in the returned `blocks` array, with `needsRewrite = true`. This prevents two blocks sharing an id from reaching the rest of the system. Tested.

**Header handling (chosen).** Drop the historical `# Scratchpad\n\n` stub on migration — every line becomes content of a block. Rationale: keeps the parser simpler (no preamble special-case), keeps the file a uniform sequence of blocks, and matches the locked spec ("File order = block order. No separate ordering metadata"). New empty scratchpads still get the `DEFAULT_STUB` on first `readScratchpad`, but the stub now contains zero block fences and `migrateIfNeeded` is a no-op on it (`# Scratchpad\n\n` migrates to a single block — see "Migration trigger" below — but only if `# Scratchpad\n\n` is the *only* content; we special-case that exact stub to avoid creating a useless block).

Actually, simpler rule: **the stub `# Scratchpad\n\n` is treated as empty for migration purposes**. If the file equals the stub byte-for-byte (or is empty / whitespace-only), no migration happens and the file is left alone. This keeps brand-new files from getting a spurious block.

**Parser rules (lenient):**

1. Walk the content top-to-bottom. At each position, attempt to match a block-open fence at a line start.
2. If matched, find the matching close fence (same UUID) on a subsequent line. Everything between the fences is the block text (with trailing `\n` trimmed once).
3. If the open fence has no matching close fence before EOF or the next open fence, consume everything up to the next open fence (or EOF) as the block text. Set `needsRewrite = true`.
4. Content **before** the first open fence (including the `# Scratchpad` stub, stray text, comments not in the block format) is collected. On any non-empty leftover, promote it to a fresh block at position 0 and set `needsRewrite = true`. Exception: if the leftover *exactly* equals `DEFAULT_STUB` (`# Scratchpad\n\n`) or is whitespace-only, drop it silently.
5. Content **between** valid blocks (whitespace, stray text) is preserved as inter-block whitespace on parse and normalized on serialize (always one blank line between blocks).
6. Empty blocks (text trimmed to "") parsed in are dropped on serialize (matches "Empty blocks are never persisted").

**Idempotency invariant (must hold):** for any block-fenced content `C` written by `serializeBlocks`, `parseBlocks(C).needsRewrite === false` AND `serializeBlocks(parseBlocks(C).blocks) === C`. This is a parser test.

### Migration (daemon)

`readScratchpad(dataDir)` becomes:

```ts
const stat = fs.statSync(filePath);
const mtimeBefore = stat.mtimeMs;
const raw = fs.readFileSync(filePath, "utf8");
const { migrated, content } = migrateIfNeeded(raw);
if (migrated) {
  // Multi-tab race guard: only write if the file hasn't changed since we read.
  // Another tab racing migration may have already written fresh fences with
  // different UUIDs — accept that and skip our duplicate write.
  const currentMtime = fs.statSync(filePath).mtimeMs;
  if (currentMtime === mtimeBefore) {
    writeScratchpad(dataDir, content, "migrate-to-blocks");
  }
}
// re-read for fresh updatedAt
return { content: fs.readFileSync(filePath, "utf8"), updatedAt: fs.statSync(filePath).mtime.toISOString() };
```

`migrateIfNeeded` logic:

1. If `raw` is empty, whitespace-only, or equals `DEFAULT_STUB` → no migration (return as-is).
2. If `raw` contains any `<!-- block:` marker → call `parseBlocks(raw)`; if `needsRewrite` is true, return the serialized result; else no migration.
3. Else (legacy, no fences): split on `/\n\s*\n/`, drop empty chunks, wrap each as a block with a fresh UUID v4 from `crypto.randomUUID()`, serialize, return as migrated.

This is the *only* place "migrate-to-blocks" is emitted as a history source. Re-running `migrateIfNeeded` on already-fenced content is a no-op (case 2 with `needsRewrite=false`).

**Note on AC1 under multi-tab races.** AC1 says "one history entry recorded with source `migrate-to-blocks`." The existing 60s same-source coalesce window in `scratchpad-history.ts:66` produces exactly one history entry per same-source burst, so AC1 is satisfied literally even under a race. The mtime guard above is defensive — it short-circuits redundant writes when another tab has already migrated. We do not promise that the migrating UUIDs are stable across a concurrent multi-tab first-read; we promise the FILE ends up fenced, and history shows one `migrate-to-blocks` entry.

**mtime precision caveat.** `mtimeMs` precision is filesystem-dependent (sub-second on Linux ext4 and most modern setups, but 1s on some macOS APFS configurations and FAT/network filesystems). On coarse-mtime filesystems the guard may compare equal across rapid concurrent writes; the 60s coalesce window then subsumes the duplicate write into a single history entry, so AC1 still holds. Document this in a code comment on the guard.

**History source addition.** Extend `ScratchpadHistorySource` in `packages/contracts/src/scratchpad.ts`:

```ts
export type ScratchpadHistorySource =
  | "ui"
  | "mcp:write_scratchpad"
  | "mcp:append_scratchpad"
  | "mcp:add_block"
  | "mcp:update_block"
  | "mcp:delete_block"
  | "ui:edit_block"
  | "ui:add_block"
  | "ui:delete_block"
  | "migrate-to-blocks"
  | "backfill"
  | `restore:${string}`;
```

`pillLabel` / `pillSlug` in `apps/web/src/routes/scratchpad-helpers.ts` must learn the new sources (label + CSS class). Pills for `migrate-to-blocks` get a distinct slug so the timeline entry is recognizable.

### Block CRUD (daemon)

Add to `apps/daemon/src/scratchpad.ts`:

```ts
listBlocks(dataDir): { blocks: BlockSummary[] }
// BlockSummary = { id, text, createdAt, updatedAt }

addBlock(dataDir, text, position, source, opts?): { block: Block; snapshot }
// position: 'end' | { afterId: string }; default 'end'

updateBlock(dataDir, id, text, source, opts?): { block: Block; snapshot } | { error }

deleteBlock(dataDir, id, source, opts?): { snapshot } | { error }
```

All four go through `writeScratchpad` for one history entry per call (60s coalesce still applies). They share an internal helper `withBlocks(dataDir, mutator, source, opts)` that:

1. Reads current content (post-migration).
2. Parses to blocks.
3. Runs the mutator on the blocks array.
4. Serializes and calls `writeScratchpad` with the given source.

**Block timestamps (best-effort, documented).** `createdAt`/`updatedAt` per block are *derived* from the version history. Because the existing 60s same-source coalesce window (`scratchpad-history.ts:66`) replaces the prior entry's content in place, intermediate states between coalesced writes are lost. Consequence: per-block timestamps are approximate within a coalesce window — they are monotonic and bracket the real edit time but may be aliased to the surrounding burst's first/last write.

Algorithm:

- `createdAt` = `firstWriteTs` of the oldest history entry whose content contains the block's UUID.
- `updatedAt` = `ts` of the newest history entry whose content extracted-for-that-UUID *differs* from the next-older entry's extracted content for the same UUID. (Compare the inner text of the block, not the whole file.) If no such "change boundary" exists, `updatedAt = createdAt`.
- If neither (block predates history / migration), both fall back to the file's `mtime`.

Implementation: a `computeBlockTimestamps(history, blocks)` helper in `scratchpad-blocks.ts`; tested in isolation. Tests assert monotonicity (`createdAt <= updatedAt <= now`) and that the timestamps stay within the coalesce-window bracket, NOT that they equal the exact wall-clock edit time. The contract docstring on `list_blocks` notes the best-effort nature.

This intentionally trades precision for "no sidecar files, no per-block history chain" — consistent with the "regular markdown file" guarantee.

**Edge cases:**

- `addBlock` with `position: { afterId }` and `afterId` not found → `{ error: "block_not_found" }`. Daemon HTTP responds 404.
- `updateBlock` with id not found → `{ error: "block_not_found" }`.
- `deleteBlock` with id not found → `{ error: "block_not_found" }`.
- `updateBlock` with empty/whitespace-only text → treated as a delete (matches AC6 "empty edits prune the block").
- `addBlock` with empty/whitespace-only text → `{ error: "text_required" }` (matches "Empty blocks are never persisted").

### Daemon HTTP routes

Add to `scratchpad-routes.ts`:

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/api/scratchpad/blocks` | — | `{ blocks: BlockSummary[] }` |
| `POST` | `/api/scratchpad/blocks` | `{ text, position? }` | `{ block, snapshot }` |
| `PUT` | `/api/scratchpad/blocks/:id` | `{ text }` | `{ block, snapshot }` |
| `DELETE` | `/api/scratchpad/blocks/:id` | — | `{ snapshot }` |

All four use source `ui:add_block` / `ui:edit_block` / `ui:edit_block` (PUT-deletes-on-empty) / `ui:delete_block`. (PUT with empty text → emit `ui:delete_block` source so history pill reads correctly.) Emit `scratchpad.updated` + `scratchpad.history.updated` after each successful write.

Validation guards on POST/PUT: `typeof text === "string"`; `Buffer.byteLength(text, "utf8") <= SCRATCHPAD_MAX_BYTES` (cap is per-file, not per-block — the daemon enforces the total via `writeScratchpad`'s `assertSize`). 4xx mappings: 400 for malformed body, 404 for missing block id, 413 for file-too-large.

### MCP surface

**File-size split (FIRST step in this section).** `packages/mcp/src/index.ts` is at **789 / 800** LOC. Adding four new schemas + dispatcher branches will overflow `scripts/checks/file-size.ts`. Extract scratchpad tooling into a new file before adding to it:

- Create `packages/mcp/src/scratchpad-tools.ts` exporting:
  - `export const SCRATCHPAD_TOOL_NAMES = ["read_scratchpad", "write_scratchpad", "append_scratchpad", "list_blocks", "add_block", "update_block", "delete_block"] as const;`
  - `export type ScratchpadToolName = (typeof SCRATCHPAD_TOOL_NAMES)[number];` (derived — no type-vs-value drift).
  - `export const SCRATCHPAD_TOOL_DEFINITIONS: McpToolDefinition[]` — the seven schema entries.
  - `McpToolDefinition` is imported from `index.ts` via `import type { McpToolDefinition } from './index.js'` to avoid runtime circular imports (type-only edge is safe; TypeScript erases it).
- `packages/mcp/src/index.ts`:
  - `import type { ScratchpadToolName } from './scratchpad-tools.js'` (type-only) and `import { SCRATCHPAD_TOOL_DEFINITIONS } from './scratchpad-tools.js'` (value).
  - Remove the three existing scratchpad entries from the `McpToolName` literal union; add `| ScratchpadToolName` at the end of the union.
  - Remove the three existing scratchpad entries from the master registry; concatenate `SCRATCHPAD_TOOL_DEFINITIONS` into it.
  - Net change to `index.ts`: removal of three existing scratchpad entries (~33 LOC) + addition of imports/spreads (~5 LOC). Post-change: ≤761 LOC, with the four new tool entries living in the new file (~80 LOC there).
- The snapshot-path dispatcher (~L688–712) gets four added `case` labels — strings, no schemas. Net ≤ +5 LOC. Stays well under 800.

After the extraction:

- Names: extend the `McpToolName` union with `list_blocks`, `add_block`, `update_block`, `delete_block` (in `scratchpad-tools.ts`).
- Schemas: four new entries in `SCRATCHPAD_TOOL_DEFINITIONS`. `add_block` `inputSchema.properties.position` is `oneOf: [{ const: "end" }, { type: "object", required: ["afterId"], properties: { afterId: { type: "string" } }, additionalProperties: false }]`, default `"end"`.
- Dispatcher (snapshot path): all four return `"scratchpad_tool_requires_daemon"` (same as `read_scratchpad`) — they need fs access.

**`append_scratchpad` description update.** The current description (`packages/mcp/src/index.ts:430`) says "Inserts a blank-line separator before the new chunk." Replace with: "Creates a new block (UUID-fenced) at the end of the scratchpad with the given content. Each call produces exactly one block — to add multiple related lines in a single block, pass them together in one call with embedded newlines." This is an explicit contract change for external MCP consumers; the changelog/release note in step A must call it out.

Add to `apps/daemon/src/daemon-mcp-tool.ts`: four `if (call.name === ...)` branches mirroring the existing `read/write/append` blocks. Each emits `scratchpad.updated` + `scratchpad.history.updated` on success, uses sources `mcp:add_block` / `mcp:update_block` / `mcp:delete_block`, and `mcp:update_block` with empty text routes to `deleteBlock` with source `mcp:delete_block`.

### `append_scratchpad` change (breaking for external MCP consumers)

`appendScratchpad` no longer inserts `\n\n`. New behavior: serialize a new block (fresh UUID, given text as inner content) and append to the file. Implementation: route through `addBlock(dataDir, text, "end", "mcp:append_scratchpad", opts)`. The MCP description in `packages/mcp/src/scratchpad-tools.ts` must be updated to say "creates a new block" instead of "inserts a blank-line separator" — see "MCP surface" above for the exact wording.

The contract-shape (`{ content, updatedAt }`) is unchanged. The existing tests `apps/daemon/src/scratchpad.test.ts:55–62` ("appends with a clean newline boundary") AND `apps/daemon/src/scratchpad.test.ts:64–69` ("appends to an empty file without leading separator") both assert the legacy byte-shape and MUST be rewritten to assert block-fenced output. L64–69 specifically: drop the `result.content === "note\n"` assertion; instead assert (a) the file contains exactly one `<!-- block:` open fence and matching close, (b) parsing yields one block whose inner text is `note`.

**External-agent contract change.** Because `append_scratchpad` is an MCP tool exposed to external agents (Claude Code subagents, scheduled agents, user automations), the change is observable to clients outside this repo. Action items in Step A (Spec update):

- Spec subsection in `B.7` must explicitly document the new "one call = one block" semantics.
- Append a release note / changelog entry callout to the PR description so operators upgrading see the behavior change. (Citadel does not have a formal CHANGELOG file; the PR body's "Behavior change" section is the canonical surface — see `.agents/skills/extensions/create-pr.md` for the PR template if it declares a behavior-change field.)

### UI (apps/web)

Rewrite `apps/web/src/routes/scratchpad.tsx`. The history sidebar and diff modal stay; the central editor changes from a single textarea to a stack of focusable blocks + pinned composer.

**Data model in component state:**

```ts
type UiBlock = { id: string; text: string; draft: string; isEditing: boolean };
```

`text` is the saved server value; `draft` is the in-flight edit; `isEditing` controls focus mode. On load, fetch `/api/scratchpad/blocks` and seed state. SSE `scratchpad.updated` refetches blocks, preserving local edits (matches existing coordinator pattern — don't clobber un-saved drafts).

**Markdown rendering (locked design).** The brief specifies "markdown-rendered when not focused." Adding two small deps to `apps/web`:

- `marked` (~25 KB min) — popular, zero-dep, fast markdown→HTML.
- `dompurify` (~22 KB min) — sanitizes the resulting HTML. Required because block content can be written by MCP-side agents whose output we treat as untrusted.

Wiring: `marked.parse(blockText, { breaks: true })` → `DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['img'] })` → set as `dangerouslySetInnerHTML`. (No `mangle` / `headerIds` — both were removed from marked core in v8+/v9+ and are no-ops in v14.)

DOMPurify default `html` profile strips `<script>`, `<iframe>`, `on*=` handlers, etc. **Image policy for v1: images are stripped (`FORBID_TAGS: ['img']`).** Rationale: block text can be produced by external MCP agents (untrusted). Allowed `<img src=...>` becomes a tracking-pixel/SSRF probe (leaks cockpit operator IP + Referer on render). Markdown image syntax `![alt](path)` simply produces no output. Re-evaluate in a follow-up if there's a real need for trusted images. Inline code, fenced code, headings, lists, bold/italic, links (autolinks rendered as anchors with `rel="noopener noreferrer"`) all render.

Lockfile-sensitivity gate APPLIES (new deps): see "Migration strategy" section below for dep-add justification + lifecycle-script review.

**Block component (memoized, one per id):**

- Not focused: rendered as sanitized markdown HTML via the pipeline above, inside a `.scratchpad-block-rendered` container with CSS reset rules (`max-width`, `word-wrap`, scoped typography). Cursor: `text` (signals editability on hover).
- Focused: `<textarea>` with auto-grow (set rows by line count, capped). On focus, copy `text → draft` and set `isEditing = true`.
- Save triggers: blur, Cmd/Ctrl-Enter, ~1s debounce after last keystroke. All three call the same `saveBlock(id, draft)` which either updates (non-empty) or deletes (empty/whitespace).
- Esc: revert `draft = text`, `isEditing = false`, no network call.
- Delete affordance: `lucide-react` `Trash2` icon button visible on hover. Click → optimistic delete + undo toast (~5s window). Toast uses an existing pattern if any, else a minimal local component.

**Pinned composer:**

- Sticky-positioned `<textarea>` at the bottom of `.scratchpad-body`. Cmd/Ctrl-Enter or blur with non-empty content → `POST /api/scratchpad/blocks` with `position: "end"`, clears the composer, refetches blocks, scrolls to bottom.
- Focused on mount; refocused after each successful add.

**Autoscroll:** on initial load, on every new block append (locally or via SSE), scroll the block list to the bottom. Use a `useEffect` keyed on the blocks length and the SSE refresh ticker.

**Concurrency / SSE:** on `scratchpad.updated`, refetch `/api/scratchpad/blocks` and **merge** into local state: keep `draft`/`isEditing` for blocks the user is currently editing; replace others. Drop local blocks the server no longer returns (someone deleted via MCP). Add server blocks not yet in local state (someone added via MCP). This is last-write-wins per AC; the merge is to avoid clobbering an active edit.

**SSE payload kept minimal in v1.** The `scratchpad.updated` event continues to carry only `{ updatedAt }` and the UI does a full `GET /api/scratchpad/blocks` on receipt. Considered: adding `{ blockId, op }` to the payload so the UI could patch state without refetch. Rejected for v1 because (a) the file is capped at 1 MB and the typical block count is small, so refetch cost is bounded; (b) it requires a contracts change and per-route plumbing; (c) the refetch keeps the snapshot strictly server-authoritative, eliminating client-side drift. Optimization deferred.

**Save coordination:** the existing `createSaveCoordinator` is tightly coupled to the single-textarea model and is not reusable. Either generalize it to take a key (block id) or replace its usage in this route with a small per-block saver. Recommendation: per-block saver (clearer for v1) and leave `scratchpad-helpers.ts` `createSaveCoordinator` untouched for now (no other consumer).

### Concurrency

Last-write-wins, as today. The block-level routes go through `writeScratchpad` so the existing 60s coalesce window keyed by `source` still applies — rapid successive `ui:edit_block` writes inside 60s coalesce into one history entry, which is exactly what we want. Different sources still split.

### Edge cases and contracts

- **File-size cap (`SCRATCHPAD_MAX_BYTES = 1_000_000`)** — block writes assert through `writeScratchpad`; the cap is on the serialized file, not per block. Adding a block that would push past the cap returns 413; we surface this to the UI as an inline error on the composer.
- **Restore of a pre-migration version (AC9):** restoring writes the *exact* old content verbatim with source `restore:<id>`. The next `readScratchpad` runs `migrateIfNeeded` again and re-migrates (records a new `migrate-to-blocks` entry). This is intentional and documented.
- **Concurrent restore + write race:** unchanged from today — last write wins.
- **Migration emits exactly one history entry (AC1):** verified by test. `migrateIfNeeded` is called once per `readScratchpad`; calling `readScratchpad` twice on the same already-migrated file is a no-op.
- **UUID collision in the file:** if the same UUID appears twice as an open fence, the parser parses both blocks but reassigns the second a fresh v4 UUID and sets `needsRewrite = true` (see "Duplicate-UUID handling" in the Storage section). On the next write, the file is normalized — both blocks survive with distinct ids.

## Alternatives considered

1. **Per-block files in a `.scratchpad-blocks/` directory.** Rejected — kills the "file stays a regular markdown file so external tooling keeps working" guarantee. Also forces a directory mtime convention and a write-coordination problem we don't currently have.
2. **Front-matter or YAML index at top of file** mapping `block-id → line-range`. Rejected — fragile under manual edits (editor reformats, indices stale, brittle parser).
3. **JSON sidecar (`scratchpad.blocks.json`) with the source of truth in JSON and `scratchpad.md` regenerated.** Rejected — same external-tooling problem. Two sources of truth invite drift.
4. **`<details>`-tag fenced blocks** (renders as collapsible on GitHub). Rejected — renderers expand/collapse content; UUID-bearing comment is invisible and stable. HTML comments are spec-safe in markdown and don't render.
5. **Storing block IDs as the first line of each block as a normal heading** (`### blk-abc123`). Rejected — pollutes user-visible content with machine identifiers.
6. **Skipping markdown rendering for v1** (render block text as preformatted `<pre>`). Initially considered to avoid adding deps, but rejected on round-1 review: the locked design explicitly says "markdown-rendered when not focused" and rendering raw markup is a UX regression vs. the user expectation. Adopting `marked` + `dompurify` (~50 KB combined) is the chosen path. See "Markdown rendering" in the UI section.
7. **Heavier markdown stacks** like `react-markdown` + `remark` plugins. Rejected — larger dep tree, more configuration surface, and we don't need plugin extensibility for v1.

## Implementation steps

### A. Spec update (FIRST — per Citadel specs-first rule)

- Add a "Scratchpad" subsection to `specs/B.7-operations-activity-mcp.md` covering: file format (block fences with UUID v4 generated, any 8-4-4-4-12 hex accepted on parse), the seven MCP tools (`read_scratchpad`, `write_scratchpad`, `append_scratchpad`, `list_blocks`, `add_block`, `update_block`, `delete_block`) with one-line behavior summaries, the migration rule, and the explicit behavior-change callout for `append_scratchpad` (was "blank-line separator," now "one call = one new block").
- Add a "Scratchpad" subsection (full, not a sidebar note) to `specs/B.2-ade-cockpit.md` describing the block-based UX: click-to-edit, blur/Cmd-Enter/debounce save, Esc cancels, pinned composer at bottom, autoscroll on add, hover-visible delete with undo toast, no reorder in v1, markdown-rendered when not focused (using `marked` + `dompurify`).

### B. Contracts & MCP definitions

- Extend `ScratchpadHistorySource` union in `packages/contracts/src/scratchpad.ts` with the 6 new block-source variants (3 `mcp:*_block` + 3 `ui:*_block`) plus `migrate-to-blocks` (7 total new entries).
- Add `ScratchpadBlock` and `ScratchpadBlockSummary` types in `packages/contracts/src/scratchpad.ts`. Re-export from `packages/contracts/src/index.ts`.
- Create `packages/mcp/src/scratchpad-tools.ts` containing `SCRATCHPAD_TOOL_NAMES` (the existing three + four new names) and `SCRATCHPAD_TOOL_DEFINITIONS` (schema entries for all seven). This is the file-size-cap mitigation per the "MCP surface" section.
- In `packages/mcp/src/index.ts`: remove the three existing scratchpad entries from the union and the master registry; import and spread `SCRATCHPAD_TOOL_NAMES` into the `McpToolName` union; concatenate `SCRATCHPAD_TOOL_DEFINITIONS` into the master registry. Add four new `case` labels to the snapshot-path dispatcher (~L688–712 region) routing to `scratchpad_tool_requires_daemon`. Net change: ≤ -28 LOC (file ends ≤761).

### C. Daemon storage layer

- Create `apps/daemon/src/scratchpad-blocks.ts` exporting: `Block`, `parseBlocks`, `serializeBlocks`, `migrateIfNeeded`, `computeBlockTimestamps`.
- Update `apps/daemon/src/scratchpad.ts`:
  - `readScratchpad` runs `migrateIfNeeded` before returning; if it migrates, calls `writeScratchpad(..., "migrate-to-blocks")` first — guarded by the mtime-unchanged check described in the "Migration" section to avoid stomping a concurrent migration.
  - `writeScratchpad` does NOT do any internal parse/normalize. It writes the bytes it is given. Rationale: keeping `writeScratchpad` byte-faithful (a) makes restore-from-history truly verbatim (AC9), (b) eliminates a hidden code path that could mutate caller intent, (c) keeps the single source-of-rewrite truth in `migrateIfNeeded` (called from `readScratchpad`). Any caller that ends up writing non-canonical fenced content will see it normalized on the next read — which is exactly the lenient-parser contract. Block-CRUD operations (`addBlock`/`updateBlock`/`deleteBlock`) always pass canonically-serialized content into `writeScratchpad`, so the on-disk file is canonical the moment they run.
  - `appendScratchpad` becomes a thin wrapper: `addBlock(dataDir, chunk, "end", source, opts)`.
  - Add `listBlocks`, `addBlock`, `updateBlock`, `deleteBlock` exports.

### D. Daemon HTTP routes

- Add 4 routes in `apps/daemon/src/scratchpad-routes.ts`: GET / POST / PUT / DELETE under `/api/scratchpad/blocks[/:id]`.
- All emit `scratchpad.updated` + `scratchpad.history.updated` on success.
- Map daemon errors (`block_not_found`, `text_required`, `scratchpad_too_large`) to 404 / 400 / 413.

### E. Daemon MCP tool dispatcher

- Add four `if (call.name === ...)` branches in `apps/daemon/src/daemon-mcp-tool.ts` after the existing `append_scratchpad` block. Each returns `{ block, content, updatedAt }` (success) or `{ error }`.

### F. Web UI rewrite

- Rewrite the central editor portion of `apps/web/src/routes/scratchpad.tsx`. Keep the history sidebar and diff modal.
- New components (file-local to the route, no new files unless size requires): `BlockListView`, `BlockItem`, `ComposerBar`. Hover-visible delete + undo toast.
- Update `apps/web/src/routes/scratchpad-helpers.ts` `pillLabel` / `pillSlug` to handle the new history sources (`migrate-to-blocks`, the four `mcp:*_block`, the three `ui:*_block`).
- Keep file under the 800-LOC cap (`check:size`). Likely needs a small extraction even before counting toast logic; budget 600–700 LOC across `.tsx` + helpers.

### G. Dependency additions (lockfile-sensitivity gate)

Two new web-only deps:

- `marked@^14` — pinned to a current major (16 KB min+gz). Lifecycle scripts reviewed: none (`postinstall`/`preinstall`/`install` absent in package.json). Used for markdown→HTML.
- `dompurify@^3` — pinned to a current major (22 KB min+gz). Lifecycle scripts reviewed: none. Used to sanitize the marked output before injecting into the DOM.

Added to `apps/web/package.json` `dependencies`. Plain dependencies — no `optionalDependencies`, no `peerDependencies`. `pnpm-lock.yaml` updates accordingly. No `package-lock.json` / `yarn.lock` introduced. Both are MIT-licensed.

Why these two, why now: justified by the locked design ("markdown-rendered when not focused"). Combined ~50 KB hits the cockpit bundle; acceptable for a feature the user will hit on every cockpit visit. We do not pull in `@types/dompurify` (DOMPurify v3 ships its own types).

### H. Migration strategy

**No database schema changes.** This is a file-format migration, not a DDL change.

- The new `migrateIfNeeded` runs on read. It's the only entry point that promotes legacy content to block-fenced content. It records exactly one history entry with source `migrate-to-blocks` per migration.
- **Operator data implications:** every existing Citadel install with a non-trivial `scratchpad.md` will migrate exactly once on the first daemon read after upgrade. Migration is content-preserving (each blank-line-separated chunk → one fenced block with the same inner text). The history file grows by one entry. No data loss possible — the pre-migration content is in the history's `migrate-to-blocks` predecessor entry (the prior `ui` or `mcp:*` entry) and can be restored.
- **Reversibility:** restoring a pre-migration version writes verbatim old content; the *next* read re-migrates. There is no "downgrade" path that strips block fences — out of scope, and v1 ships forward-only.
- **`PRAGMA foreign_keys = ON;` preservation:** N/A (no DB changes).

### I. Tests (TDD order — before implementation in each step)

See "Tests" and "QA/Test Strategy" sections below for the explicit file/case list.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Parser, migration, block CRUD, MCP plumbing, contracts. Pure logic + daemon HTTP fully exercisable via supertest. The bulk of coverage lives here. Target ≥90% on `scratchpad-blocks.ts` (matches Citadel's standard for backend modules). |
| E2E (Playwright) | **Required** | Block-based UX is a substantial user-facing rewrite — click-to-edit, composer add, hover delete, Cmd-Enter, migration banner (none) but at least a happy-path through the cockpit. Without an E2E we can't catch regressions in the textarea→stack flip or in the composer focus behavior. |

### New tests to add

**`apps/daemon/src/scratchpad-blocks.test.ts` (new file)** — parser & migration core:

- `parseBlocks: round-trip on canonical input is identity` — fence two blocks, parse → serialize → equal input.
- `parseBlocks: idempotent — parse, serialize, parse again returns same blocks (same UUIDs, same text)`.
- `parseBlocks: matches the relaxed fence regex (any 8-4-4-4-12 hex)` — feed both a v4 and a v1 UUID; both must parse as blocks. Feed a malformed (wrong-length) UUID; must NOT parse as a block.
- `parseBlocks: unmatched open fence consumes to next open fence or EOF, sets needsRewrite=true`.
- `parseBlocks: unmatched open fence followed by close fence with different UUID is treated as open-only`.
- `parseBlocks: unfenced content at top is promoted on rewrite (needsRewrite=true), content preserved`.
- `parseBlocks: DEFAULT_STUB (# Scratchpad\n\n) at top yields zero blocks and needsRewrite=false`.
- `parseBlocks: empty blocks are dropped on serialize`.
- `parseBlocks: blank lines inside a block are preserved`.
- `parseBlocks: lenient — never throws on garbage input (fuzz a few malformed inputs)`.
- `parseBlocks: a <!-- block:UUID --> line inside a triple-backtick code fence is treated as content, not a new block (CONCERN 3)`.
- `parseBlocks: two blocks with duplicate UUIDs in the file produce two blocks with distinct UUIDs, needsRewrite=true (CONCERN 4)`.
- `parseBlocks: accepts non-v4 UUIDs (any 8-4-4-4-12 hex) as valid fences` (SUGGESTION 3).
- `serializeBlocks: emits canonical form (one blank line between blocks, one trailing newline per block, trailing newline at file end)`.
- `migrateIfNeeded: empty / whitespace-only / DEFAULT_STUB → no migration`.
- `migrateIfNeeded: already fenced → no migration (needsRewrite=false case)`.
- `migrateIfNeeded: already fenced but with trailing junk → migrates (rewrites canonically)`.
- `migrateIfNeeded: legacy blank-line-separated → fenced with fresh v4 UUIDs, content preserved`.
- `migrateIfNeeded: idempotent — running twice on the same input yields the same blocks (UUIDs preserved after first migration)`.
- `computeBlockTimestamps: returns history-derived createdAt/updatedAt; falls back to mtime when block predates history`.
- `computeBlockTimestamps: monotonicity invariant — for every block, createdAt <= updatedAt`.
- `computeBlockTimestamps: under coalesced history, timestamps stay within the bracket of the surrounding coalesce window (NOT exact wall-clock)` — documents the best-effort semantics.

**`apps/daemon/src/scratchpad.test.ts` (extend)** — file I/O integration:

- `readScratchpad on legacy file auto-migrates and records exactly one history entry with source 'migrate-to-blocks'`.
- `readScratchpad called twice on legacy file records only one migration entry (idempotent)`.
- `readScratchpad on empty / stub file does NOT record a migration entry`.
- `readScratchpad with mtime changed between read and write skips the migration write (multi-tab race guard)`.
- `writeScratchpad is byte-faithful — bytes passed in == bytes on disk` (regression test for BLOCKER 2 — no internal normalization).
- `unfenced top-of-file content is promoted on next readScratchpad (the migration path), not on writeScratchpad` (content rewritten with a fresh UUID via migration, not via write).
- `appendScratchpad produces a new fenced block, never merges into a prior one` (AC5) — replaces the existing assertion at L55–62 AND L64–69 (`"appends to an empty file without leading separator"` no longer holds; rewrite to assert one fenced block whose inner text is `note`).
- `addBlock with position 'end' appends a new block at end of file`.
- `addBlock with position { afterId } inserts after the given block`.
- `addBlock with afterId not found returns { error: 'block_not_found' }`.
- `addBlock with empty text returns { error: 'text_required' }`.
- `updateBlock with non-empty text overwrites the block's text, preserves UUID`.
- `updateBlock with empty text deletes the block (source: ui:delete_block / mcp:delete_block as passed)`.
- `updateBlock with unknown id returns { error: 'block_not_found' }`.
- `deleteBlock removes the block, preserves all others' UUIDs`.
- `deleteBlock unknown id returns { error: 'block_not_found' }`.
- `block CRUD writes flow through the 60s coalesce window keyed by source` (one entry for two ui:edit_block writes 30s apart).
- `listBlocks returns blocks with derived createdAt/updatedAt timestamps`.

**`apps/daemon/src/scratchpad-routes.test.ts` (extend)** — HTTP endpoints:

- `GET /api/scratchpad/blocks` returns the block list.
- `POST /api/scratchpad/blocks { text }` adds at end, returns 200 with `{ block, snapshot }`.
- `POST /api/scratchpad/blocks { text, position: { afterId } }` inserts after.
- `POST /api/scratchpad/blocks { text: '' }` → 400 `text_required`.
- `POST /api/scratchpad/blocks { text }` exceeding size cap → 413.
- `PUT /api/scratchpad/blocks/:id { text }` updates, returns 200.
- `PUT /api/scratchpad/blocks/:id { text: '' }` deletes, returns 200 (snapshot only).
- `PUT /api/scratchpad/blocks/:unknown_id` → 404 `block_not_found`.
- `DELETE /api/scratchpad/blocks/:id` returns 200.
- `DELETE /api/scratchpad/blocks/:unknown_id` → 404.
- All 4 routes emit `scratchpad.updated` and `scratchpad.history.updated` on success.

**`packages/mcp/src/index.test.ts` (verified to exist; extend)** — MCP plumbing:

- The four new tool names appear in the tool registry with correct schemas.
- The snapshot-path dispatcher returns `scratchpad_tool_requires_daemon` for all four.
- `append_scratchpad`'s description is the new one-call-one-block wording.
- Scratchpad tool definitions are sourced from `scratchpad-tools.ts` (import path test): the consolidated registry contains every name in `SCRATCHPAD_TOOL_NAMES` exactly once.

**`apps/daemon/src/daemon-mcp-tool.test.ts` (verified to exist; extend)** — daemon-side MCP:

- `list_blocks` returns `{ blocks }`.
- `add_block` with valid text adds at end (source `mcp:add_block`).
- `add_block` with `position.afterId` not found → `{ error: 'block_not_found' }`.
- `update_block` with empty text deletes (source `mcp:delete_block`).
- `delete_block` with unknown id → `{ error: 'block_not_found' }`.
- `append_scratchpad` (existing tool) now creates a fresh fenced block (source `mcp:append_scratchpad`).

**`apps/web/src/routes/scratchpad-markdown.test.ts` (new file, Vitest)** — markdown render pipeline:

- `renders bold/italic/headings/lists/code correctly`.
- `strips <script> tags via DOMPurify`.
- `strips onerror= and other inline event handlers`.
- `renders links as anchors with rel="noopener noreferrer"`.
- `<img>` tags are stripped entirely (v1 policy: `FORBID_TAGS: ['img']`); markdown `![alt](path)` produces no rendered output.

**E2E `e2e/scratchpad-blocks.spec.ts` (new file):**

- `migrates a legacy scratchpad on first open and surfaces the migrate-to-blocks history entry`.
- `clicking an existing block enters edit mode; Cmd-Enter saves and exits; the change is persisted on reload`.
- `editing a block to empty deletes it`.
- `pinned composer at bottom: typing + Cmd-Enter creates a new block at the end`.
- `composer blur with non-empty content also creates a block`.
- `hover delete button removes a block; undo toast restores it within the toast window`.

### Existing tests to update

- `apps/daemon/src/scratchpad.test.ts:55–62` — `"appends with a clean newline boundary"`: REPLACE. New assertion: the file contains two `<!-- block:` fences after two appends; not the `first line\n\nsecond line\n` shape.
- `apps/daemon/src/scratchpad.test.ts:64–69` — `"appends to an empty file without leading separator"`: REWRITE. Replace the `toBe("note\n")` assertion with a parse-and-check: one block, inner text `"note"`. (CONCERN 6 from review.)
- `apps/daemon/src/scratchpad.test.ts:34–41` — `"creates the data dir and seeds a stub on first read"`: keep, but the snapshot.content assertion remains `toContain("Scratchpad")` (stub unchanged; migration is no-op on stub).
- `apps/daemon/src/scratchpad-routes.test.ts` — any test asserting blank-line concatenation under PUT `/api/scratchpad` must be re-examined; PUT body is opaque content (user-supplied), so most tests are fine. Audit during implementation.
- Any test asserting on the `pillLabel` / `pillSlug` mapping for history sources must be extended.

### Assertions to add/change/tighten

- Tighten: `parseBlocks` accepts any 8-4-4-4-12 hex UUID; only malformed (wrong length, non-hex) inputs are rejected as fences. Generator emits v4.
- Add: idempotency assertion — `serialize(parse(input)) === input` for canonical input.
- Add: history-entry-count assertion — after a single `readScratchpad` on legacy content, `readHistory(dir)` has exactly one entry with `source === 'migrate-to-blocks'`. After a second read, count is unchanged.
- Add: HTTP DELETE 404 vs 200 path explicit assertions.
- Add: SSE emit count assertion on each block mutation (existing routes already test `scratchpad.updated` emit; mirror).

### Failure modes / edge cases / regression risks

- **Multibyte content in block text** (emoji, RTL) — fence regex is byte-blind; we use string ops, so `Buffer.byteLength` for the size cap and `string.split` for newlines. Add a parser test with a multi-byte block.
- **Trailing newline drift on serialize** — easy to accidentally end up with growing trailing whitespace each round-trip. Idempotency tests catch this.
- **Concurrent MCP append + UI edit** within 60s — coalesce window keyed by source; different sources don't coalesce, so two history entries will appear. Verify no content loss.
- **Restore of a fenced version replaces with the snapshot, then read re-validates** — restoring a fenced snapshot writes verbatim (writeScratchpad is byte-faithful per BLOCKER 2 fix); next `readScratchpad` calls `migrateIfNeeded` which is a no-op on already-canonical fenced content. Test.
- **Multi-tab race on first migration** — both tabs call `readScratchpad`, both observe legacy content, both run `migrateIfNeeded` with different fresh UUIDs. The mtime-unchanged guard in `readScratchpad` (see "Migration" section) means whichever tab races second sees a changed mtime and skips its own write. Net: one tab's UUIDs win, the file is fenced, history shows one `migrate-to-blocks` entry. AC1 holds.
- **Restoring a pre-migration version then immediately reading** — produces a fresh `migrate-to-blocks` entry (AC9). Verify by integration test.
- **MCP `list_blocks` payload size** — if a user has hundreds of blocks, the payload could be large. The file cap is 1MB so this is bounded; no pagination needed for v1.
- **Block text with `<!-- block:UUID -->` inside a code fence** — handled by code-fence-aware parser (CONCERN 3 mitigation). Test asserts a `` ``` ``-wrapped fence-looking line is content, not a new block.
- **Block text with `<!-- block:UUID -->` at line start OUTSIDE a code fence** — still splits the block. Documented limitation in the spec subsection.
- **Duplicate UUIDs from a malformed restore** — parser dedupes (CONCERN 4 mitigation). Test asserts two open fences with the same UUID produce two blocks with distinct UUIDs and `needsRewrite=true`.
- **`# Scratchpad` heading user-written, not the stub** — i.e. someone writes `# My title\n\nstuff` as the first line. Under the legacy migration path it becomes two blocks: `# My title` and `stuff`. Acceptable and matches existing semantics.
- **`marked` markdown rendering edge cases** — DOMPurify strips raw HTML. Test the renderer pipeline with: a `<script>` tag in block text (must be stripped); an `onerror=` attribute (must be stripped); a normal `[link](https://...)` (must render as an anchor); an inline image `![alt](path)` (must render as nothing per the v1 `FORBID_TAGS: ['img']` policy); an `<img src="http://attacker.example/probe">` literal (must be stripped — no network request).

### Adversarial analysis

- **How could this fail in production?** Parser ambiguities (fence-look-alike inside a block); migration writing twice and racing with a concurrent MCP write within the first 60s of upgrade; UI losing a draft because SSE refetch clobbered it.
- **What user actions trigger unexpected behavior?** Pasting markdown with `<!-- block:UUID -->` literally in it; editing the file on disk while the UI is open; rapid append-append-edit cycles from the UI.
- **What existing behavior could break?** The `appendScratchpad` contract change. In-repo: grep verified only `apps/daemon/src/daemon-mcp-tool.ts` and tests call into it. External (out of repo): MCP-side agent automations relying on `\n\n` separator are now broken — they get one block per call instead of concatenated text. Documented in the spec update and the PR body's behavior-change callout.
- **Which tests credibly catch those failures?** Parser idempotency + fuzz; migration-single-entry assertion; SSE merge test in the UI; the `appendScratchpad` test rewrite.
- **What gaps remain?** No E2E for two concurrent migration races (multi-tab) — accept and document. No fuzz testing of unicode normalization in fence lines.

### Scope calibration

This is a substantial change but largely additive: new parser module, new tools, UI rewrite. Two layers (Unit + E2E) cover the surface. No DB, no provider changes — Vitest catches the bulk and Playwright catches the user-facing path.

## Tests

Order (TDD per Citadel standards):

1. Create `apps/daemon/src/scratchpad-blocks.test.ts` with parser + migration + timestamp tests **first**.
2. Implement `apps/daemon/src/scratchpad-blocks.ts` to make them pass.
3. Extend `apps/daemon/src/scratchpad.test.ts` with block-CRUD + byte-faithful-write + mtime-guard tests; implement in `scratchpad.ts`.
4. Extend `apps/daemon/src/scratchpad-routes.test.ts`; implement in `scratchpad-routes.ts`.
5. Extract scratchpad tool defs to `packages/mcp/src/scratchpad-tools.ts`; extend `packages/mcp/src/index.test.ts`; implement scratchpad-tools.
6. Extend `apps/daemon/src/daemon-mcp-tool.test.ts`; implement four new branches in `daemon-mcp-tool.ts`.
7. Create `apps/web/src/routes/scratchpad-markdown.test.ts`; implement the marked+dompurify pipeline.
8. UI tests come via E2E; write `e2e/scratchpad-blocks.spec.ts`, then implement the route component.

## Schema or contract generation

No schema/contract generation step. The `@citadel/contracts` package is consumed via plain TypeScript imports — no codegen.

`pnpm -r build` is the only artifact step (compile contracts + downstream packages).

## Verification

Before opening the PR, all of:

- `make check` — passes (typecheck, biome, vitest unit + coverage, deps, build, file-size check — note: `packages/mcp/src/index.ts` post-extraction must be ≤761 LOC). Coverage on `apps/daemon/src/scratchpad-blocks.ts` must hit ≥90%.
- `make e2e` — passes, including the new `scratchpad-blocks.spec.ts`.
- `make smoke` — required because this changes the daemon's HTTP surface (`/api/scratchpad/blocks*`).
- `make performance` — not required; this is not a startup or hot-path change.
