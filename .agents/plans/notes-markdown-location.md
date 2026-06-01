Activate the /implement-task skill first.

# Plan: Configurable markdown-notes location, exposed via MCP

## Acceptance Criteria

- [ ] The location of the markdown notes file (today: `<dataDir>/scratchpad.md`) is configurable via `CitadelConfigSchema` under a new `scratchpad.path` field.
- [ ] `scratchpad.path` is an absolute filesystem path. The schema rejects relative paths with a clear validation error that names the field. Leading `~/` is tilde-expanded via a zod preprocess step before the absoluteness check, so the field accepts `~/Documents/notes.md` and persists it as the expanded absolute form.
- [ ] When `scratchpad.path` is unset, the effective path defaults to `<dataDir>/scratchpad.md` (preserves current behavior for every existing install).
- [ ] Updating `scratchpad.path` via `PUT /api/config` takes effect on subsequent reads/writes without a daemon restart. Implementation rule: handlers must call `effectiveNotesPath(config)` inside each request body, never capture it in a registration-time closure.
- [ ] In worktree mode (`CITADEL_WORKTREE=1`), `scratchpad.path` is stripped from the raw config on **load** the same way `dataDir`/`databasePath` are stripped today. Explicit non-AC: a `PUT /api/config` from a worktree daemon may persist `scratchpad.path` to the worktree-scoped config file in memory and on disk; the next `loadConfig` drops it. This matches the existing dataDir/databasePath behavior and is documented in the spec.
- [ ] All daemon HTTP routes (`/api/scratchpad`, `/api/scratchpad/blocks`, `/api/scratchpad/history`, `/api/scratchpad/restore`) operate on the configured path.
- [ ] All MCP scratchpad tools (`read_scratchpad`, `write_scratchpad`, `append_scratchpad`, `list_blocks`, `add_block`, `update_block`, `delete_block`) operate on the configured path.
- [ ] `read_scratchpad` MCP response includes an additional `path` field giving the absolute notes-file path the daemon read from. Type-level: introduce a new `ReadScratchpadResult = ScratchpadSnapshot & { path: string }` in `packages/contracts/src/scratchpad.ts`; do NOT add `path` to the existing `ScratchpadSnapshot` type (avoids cascading fixture/test churn across non-boundary callers).
- [ ] `inspect_status` MCP response includes `scratchpad: { path: string }`. To guarantee MCP clients can rely on it across transports, `scratchpadPath` is a REQUIRED (non-optional) field on `McpToolContext`. Snapshot-fallback construction sites must populate it from `effectiveNotesPath(config)`; tsc enforces this.
- [ ] The `inspect_status` MCP tool description is updated to document the new `scratchpad.path` field. The `read_scratchpad` description is updated to document the new `path` field in its return shape.
- [ ] The cockpit Settings page exposes a "Notes location" editor (text input + Save) inside `apps/web/src/structured-config.tsx`. The input has `data-testid="notes-location-input"`. Helper text reads: "Absolute path. Leave empty to use the default under the data directory. `~/` is expanded to your home directory."
- [ ] The history file (`scratchpad-history.jsonl`) continues to live under `<dataDir>` — it is internal daemon state, not user-facing markdown — so changing the notes path never moves or duplicates history. No `scratchpad-history.jsonl` is ever created under `path.dirname(notesPath)`.
- [ ] First-read auto-migration safety: when `readScratchpad` runs against a configured path and detects content that triggers `migrateIfNeeded` (i.e., the file is non-empty and not already fenced), the daemon logs a single `console.warn` line naming the path and the source it would attribute (`migrate-to-blocks`). This is a visibility hook for users pointing at pre-existing markdown files outside Citadel's control. UI banner is **out of scope** for this PR — tracked in spec as future polish.
- [ ] Spec `B.7-operations-activity-mcp.md` is updated to document: (a) the configurable path field and its default, (b) the worktree-mode strip-on-load rule plus the documented non-AC about `PUT /api/config` not stripping, (c) the `path` field added to `read_scratchpad` and `inspect_status`, (d) the migration-on-first-read warning behavior, (e) the history-stays-in-dataDir decision with rationale.
- [ ] File-size gate (always-on): `apps/daemon/src/app.ts` line count does not increase. Today the gate already fails on main (`app.ts`=808, `contracts/src/index.ts`=803, `operations/src/index.ts`=813) — see "File-size constraint" in Implementation steps. Net-zero or net-negative on every file already at/over the 800-line threshold. Pre-flight: capture `wc -l apps/daemon/src/app.ts` before edits, re-check after, confirm not-greater.
- [ ] `make check` and `make smoke` pass. `make smoke` is required because the `/api/scratchpad` GET response shape and `/api/config` schema both change — Implementation step explicitly confirms `make smoke` exercises GET `/api/scratchpad` shape, extending the harness if not.

## Context and problem statement

Today the daemon stores the per-install markdown scratchpad at a hardcoded location: `<dataDir>/scratchpad.md` (see `apps/daemon/src/scratchpad.ts:18,31`). `dataDir` is itself configurable (env `CITADEL_DATA_DIR` or `~/.local/share/citadel`), but the filename and directory inside `dataDir` are not — users cannot, for example, point their notes at `~/Documents/citadel-notes.md` (a synced location) without aliasing the entire data directory.

Two needs:

1. **Configurable location.** Users running multiple Citadel installs against the same notes file, or syncing notes through iCloud/Dropbox/Syncthing, need a per-install override of the notes path.
2. **MCP discoverability.** Orchestrator agents acting on the scratchpad through MCP currently have no way to learn *where* the underlying file lives — useful when the agent wants to cite the path in a PR description, open it in an editor via a separate tool, or detect that two MCP clients are pointed at the same file.

This change is purely additive: the default behavior for every existing install is preserved (`<dataDir>/scratchpad.md`), the schema field has a computed default, and the on-disk format of the notes file does not change.

## Spec alignment

- `specs/B.7-operations-activity-mcp.md` defines the scratchpad surface. **Update needed (FIRST step):** add a "Configurable location" subsection under "Scratchpad" documenting (a) the new `scratchpad.path` config field with its default, (b) the worktree-mode strip-on-load rule plus the documented non-AC about `PUT /api/config`, (c) the `path` field added to `read_scratchpad` and `inspect_status`, (d) the on-first-read migration warning behavior, (e) the history-stays-in-dataDir decision. No AC line in B.7 is contradicted — the existing AC text only references "the per-workspace `scratchpad.md` file" generically.
- `specs/B.6-providers-hooks-config.md` covers config surface conventions. No spec change required — the new field follows the existing pattern (zod schema in `packages/config`, exposed via `/api/config`, editable through the structured-config form). The "MCP" section in Settings already exists; the new field will live alongside it.
- `specs/A-shared-definitions.md` defines canonical naming. We will keep the code-level identifier `scratchpad.path` (matches all existing `scratchpad*` code) but use the user-visible label "Notes location" in the cockpit UI to match the user's terminology.

## Implementation approach

Single coherent edit across config + daemon + MCP + UI:

1. **Config schema.** Add `scratchpad: z.object({ path: z.preprocess(expandTilde, z.string().refine(path.isAbsolute, "scratchpad.path must be an absolute path (e.g. /Users/you/notes.md). `~/` is expanded to your home directory.")).optional() }).default({})` to `CitadelConfigSchema` in `packages/config/src/index.ts`. The `expandTilde` preprocess turns `~/X` into `path.join(os.homedir(), "X")` before the absoluteness check, so the stored value on disk is always already absolute. Strip `scratchpad.path` in worktree mode on **load** the same way `dataDir`/`databasePath` are stripped today (lines 266-269 in `packages/config/src/index.ts`); do NOT strip in `saveConfig` / `mergeConfigPatch` — match existing dataDir/databasePath behavior. Add `defaultNotesPath(dataDir)` and `effectiveNotesPath(config)` helpers exported from `@citadel/config`.
2. **Path resolver.** Replace `scratchpadPath(dataDir)` with `scratchpadPath(notesPath)` (or call sites pass `notesPath` directly). Update every call site (`apps/daemon/src/scratchpad.ts`, `apps/daemon/src/app.ts`, `apps/daemon/src/scratchpad-routes.ts`).
3. **Module signature change.** `readScratchpad`, `writeScratchpad`, `appendScratchpad`, `addBlock`, `updateBlock`, `deleteBlock`, `listBlocks` currently take `dataDir` as first arg. Change them to take an explicit options object `{ notesPath, dataDir }` — `notesPath` for the markdown file, `dataDir` for history. Replace the existing `ensureDataDir(dataDir)` calls that gate the **notes write** with `ensureNotesParent(notesPath)` (mkdir the immediate parent of the notes file, recursive). Keep `ensureDataDir(dataDir)` for the **history write**. Internal helpers continue to return the existing `ScratchpadSnapshot` shape; do NOT add `path` to it.
4. **MCP surface — contract types.** In `packages/contracts/src/scratchpad.ts`, introduce a new type `ReadScratchpadResult = ScratchpadSnapshot & { path: string }`. Use it only at boundaries (HTTP GET response on `/api/scratchpad`, MCP `read_scratchpad` daemon-dispatched result). Block-mutation MCP tools (add/update/delete) continue to return the existing `ScratchpadSnapshot` shape internally; the route layer enriches with `path` only when surfacing through `read_scratchpad`/`GET /api/scratchpad`. **Trade-off note:** keeps internal helpers narrow; tsc churn limited to the two boundary code paths.
5. **MCP surface — inspect_status.** Add `scratchpadPath: string` to `McpToolContext` as a **required** (non-optional) field in `packages/mcp/src/index.ts`. Every existing call site of `callMcpTool(...)` must populate it; tsc enforces this. The only daemon call site today is `apps/daemon/src/daemon-mcp-tool.ts:~386`; the test suite in `packages/mcp/src/index.test.ts` constructs `McpToolContext` fixtures that also need the field. Add `scratchpad: { path: context.scratchpadPath }` to the `inspect_status` snapshot. Update the `inspect_status` tool description in `mcpToolDefinitions()` to document this new field.
6. **MCP surface — read_scratchpad descriptor.** Update the `read_scratchpad` tool description in `packages/mcp/src/scratchpad-tools.ts` to note the `path` field in the returned object.
7. **MCP surface — daemon dispatch.** In `apps/daemon/src/daemon-mcp-tool.ts`, the `read_scratchpad` daemon dispatch returns `ReadScratchpadResult` (snapshot + `path`). Populate `scratchpadPath` on the `McpToolContext` constructed there from `effectiveNotesPath(config)`.
8. **HTTP `/api/scratchpad`.** Include `path` in the GET response so the cockpit can show "Editing <path>". Returns `ReadScratchpadResult`. PUT and block routes continue to return the existing `ScratchpadSnapshot` shape (no `path`).
9. **Routes wiring.** In `apps/daemon/src/scratchpad-routes.ts`, every handler resolves `const notesPath = effectiveNotesPath(config)` **inside the handler body**. No registration-time capture into a closure. Document this with a one-line comment at the top of the file.
10. **app.ts startup.** Replace `scratchpadPath(config.dataDir)` at line 719 with `effectiveNotesPath(config)`. **File-size constraint:** `app.ts` is at 809 lines today (already over the 800-line gate). Net change must be zero or negative. The replacement is one identifier swap (same line count). Do NOT add new imports that grow `app.ts`; the new `effectiveNotesPath` import replaces or augments the existing `@citadel/config` import line. If any line would be added, extract the existing 12-line `backfillIfEmpty` try/catch (lines 718-729) into a new helper in `apps/daemon/src/scratchpad.ts` (`backfillScratchpadOnStartup(config)`) called as a one-liner from `app.ts`, **net-reducing** `app.ts`.
11. **Cockpit UI.** Add a "Notes" or "Notes location" row inside `apps/web/src/structured-config.tsx` (existing structured-config form) — labeled text input (`data-testid="notes-location-input"`), helper text "Absolute path. Leave empty to use the default under the data directory. `~/` is expanded to your home directory.", persisting via `PUT /api/config`. Empty input sends `scratchpad: { path: undefined }`.
12. **Optional polish (still in this PR):** show the resolved path in the scratchpad route header (`apps/web/src/routes/scratchpad.tsx`) — pulls from the GET `/api/scratchpad` response's new `path` field. One-line subtitle.
13. **Spec update.** Update `specs/B.7-operations-activity-mcp.md` first, before code, per repo convention.

The daemon never *moves* the notes file when the user changes the path. If the new path points at an existing non-Citadel markdown file, the first read triggers `migrateIfNeeded` which rewrites it to fenced-block form — a `console.warn` line is emitted naming the path so the migration is not silent (pre-migration content is preserved in `<dataDir>/scratchpad-history.jsonl` under source `migrate-to-blocks`, but the user may not see that JSONL if they're using the install via a synced folder). If the new path doesn't exist, the daemon creates it with `DEFAULT_STUB` on first read.

## Alternatives considered

- **Add a `notes/` subdirectory under `dataDir` and only allow renaming the file within it.** Rejected: defeats the primary use case (sync to user-controlled cloud folder), and offers no real safety improvement since `dataDir` itself is already user-controlled via env.
- **Move history alongside the notes file when the path changes.** Rejected: would either silently relocate the history JSONL (surprising and racy) or duplicate it. History is daemon internal state — keeping it pinned to `dataDir` is the simpler, less astonishing rule and matches the database, runtime logs, and other internal state already kept there.
- **Add `path` to `ScratchpadSnapshot` directly (as optional).** Rejected after review: a sometimes-present field on a heavily-shared type forces every consumer to widen, weakens MCP client guarantees, and cascades fixture changes across non-boundary tests. Use a separate `ReadScratchpadResult` boundary type.
- **Require `scratchpadPath` only when the daemon serves MCP, leave it optional on `McpToolContext`.** Rejected: a sometimes-present `inspect_status.scratchpad` field violates the AC ("agents can discover the current notes location without a separate call"). Make it required, force every construction site to supply it; tsc enforces. Snapshot-fallback contexts can populate from `path.join(config.dataDir, SCRATCHPAD_FILENAME)` or `effectiveNotesPath(config)` since the snapshot path already has access to the loaded config.
- **Auto-strip `scratchpad.path` on `PUT /api/config` in worktree mode.** Rejected: introduces asymmetry with `dataDir`/`databasePath` (which today are NOT auto-stripped on `PUT`). The strip-on-load defense is sufficient — a redeploy purges any leaked value — and the worktree daemon's config file is scoped under `<dataDir>/worktrees/<name>/citadel.config.json` so it cannot pollute the prod install's file anyway.
- **Make the path per-workspace.** Rejected as out of scope: spec B.7 documents the scratchpad as a per-install shared ideas-capture surface, not per-workspace.
- **Expose only via `/api/config`, skip MCP path exposure.** Rejected: the explicit MCP goal in the topic is "exposed via MCP." An agent that can only read `/api/config` (not all MCP transports can) cannot discover the path.

## Implementation steps

### 1. Spec first (mandatory FIRST step per repo convention)

- Update `specs/B.7-operations-activity-mcp.md`: add a "Configurable location" subsection under "Scratchpad" documenting the `scratchpad.path` config field (with default), the worktree-mode strip-on-load rule and the documented non-AC about `PUT /api/config`, the new `path` fields on `read_scratchpad` and `inspect_status`, the on-first-read migration warning, and the history-stays-in-dataDir decision.

### 2. Config schema & loader

- `packages/config/src/index.ts`: add a `scratchpad` zod object to `CitadelConfigSchema` with a `path` field that uses `z.preprocess(expandTilde, z.string().refine(path.isAbsolute, "<friendly error>")).optional()`. `expandTilde(value)` returns `path.join(os.homedir(), value.slice(2))` for `~/X` and returns `value` unchanged otherwise (incl. non-strings, which subsequent zod parsing rejects). Add `SCRATCHPAD_DEFAULT_FILENAME = "scratchpad.md"` constant. Add `defaultNotesPath(dataDir)` returning `path.join(dataDir, SCRATCHPAD_DEFAULT_FILENAME)` and `effectiveNotesPath(config)` returning `config.scratchpad?.path ?? defaultNotesPath(config.dataDir)`.
- Extend the worktree-mode strip block (lines 266-269) to also discard `scratchpad.path` from the raw config — nested under `scratchpad`, so strip via `const { scratchpad: rawScratchpad, ...rest } = raw ?? {}` and `const cleanedScratchpad = rawScratchpad ? (({ path: _ignored, ...rest }) => rest)(rawScratchpad) : undefined`. Preserve `scratchpad` if it has other fields. Do NOT add a corresponding strip in `saveConfig` or `mergeConfigPatch` (asymmetry is intentional and matches existing dataDir/databasePath behavior).
- Update the public `CitadelConfig` type re-exports.

### 3. Daemon scratchpad module

- `apps/daemon/src/scratchpad.ts`: replace `scratchpadPath(dataDir: string)` with `scratchpadPath(notesPath: string)` (returns `notesPath` — the function becomes near-trivial, retained for consistency with `SCRATCHPAD_FILENAME` exports and any test imports). Keep `SCRATCHPAD_FILENAME` exported.
- Change `readScratchpad`, `writeScratchpad`, `appendScratchpad`, `addBlock`, `updateBlock`, `deleteBlock`, `listBlocks` to take `{ notesPath, dataDir }` as first arg. Inside:
  - The **notes file** mkdir uses `ensureNotesParent(notesPath)` (mkdir the immediate parent of the notes file, recursive). Add a private helper `ensureNotesParent(notesPath)` that calls `fs.mkdirSync(path.dirname(notesPath), { recursive: true })`.
  - The **history file** mkdir continues to use `ensureDataDir(dataDir)`.
- Add `backfillScratchpadOnStartup(config: CitadelConfig)` exported helper that wraps the existing 12-line backfill block — keeps `app.ts` net-neutral or shrinking.
- Internal return types stay `ScratchpadSnapshot` (no `path`).

### 4. Routes & app wiring

- `apps/daemon/src/scratchpad-routes.ts`: every handler computes `const notesPath = effectiveNotesPath(config)` inside the body. No registration-time capture. Add a single comment at top of file: `// Resolve effectiveNotesPath inside each handler — config is mutated in place by PUT /api/config`.
  - `GET /api/scratchpad` now returns `{ ...snapshot, path: notesPath }` (type: `ReadScratchpadResult`).
  - All other routes (PUT, block CRUD, history, restore) return the existing snapshot shape (no `path`).
- `apps/daemon/src/app.ts`: replace `scratchpadPath(config.dataDir)` at line 719 with `effectiveNotesPath(config)`; OR collapse the 12-line backfill block to `backfillScratchpadOnStartup(config)` (preferred — net-reduces `app.ts` by ~10 lines, gives us headroom on the 800-line gate).

### 5. MCP surface

- `packages/contracts/src/scratchpad.ts`: add `export type ReadScratchpadResult = ScratchpadSnapshot & { path: string }`. Do NOT add `path` to `ScratchpadSnapshot`.
- `packages/mcp/src/scratchpad-tools.ts`: update the `read_scratchpad` description to note the `path` field in the returned object.
- `packages/mcp/src/index.ts`:
  - Add `scratchpadPath: string` to `McpToolContext` as **required**.
  - In `inspect_status` case (~line 580): add `scratchpad: { path: context.scratchpadPath }` to the returned snapshot.
  - Update the `inspect_status` tool **description** in `mcpToolDefinitions()` to mention the new `scratchpad.path` field.
- `apps/daemon/src/daemon-mcp-tool.ts`: populate `scratchpadPath: effectiveNotesPath(config)` when constructing the `McpToolContext` passed to `callMcpTool` (line ~386). For the `read_scratchpad` daemon dispatch (line ~215), enrich the snapshot with `path: effectiveNotesPath(config)` before returning.

### 6. Cockpit UI

- `apps/web/src/structured-config.tsx`: extend `ConfigResponse` to include `scratchpad?: { path?: string }`. Add a "Notes location" form row (labeled `<input type="text" data-testid="notes-location-input" />`, helper text "Absolute path. Leave empty to use the default under the data directory. `~/` is expanded to your home directory.") that round-trips through `PUT /api/config`. Empty input sends `scratchpad: { path: undefined }`.
- Optional polish (still in this PR): show the resolved path in the scratchpad route header (`apps/web/src/routes/scratchpad.tsx`) — one-line subtitle pulled from `GET /api/scratchpad`'s `path` field.

### 7. Migration strategy

**No database schema changes.** This is a config-schema and contract-shape change only.

| Change | Classification | Notes |
|---|---|---|
| Introduce `ReadScratchpadResult = ScratchpadSnapshot & { path: string }` | Additive | New type; existing `ScratchpadSnapshot` unchanged. |
| Add `scratchpad.path?: string` to `CitadelConfigSchema` (with `~` preprocess) | Additive | Zod default `{}`; absent stored value falls back to default at read time. |
| Add `scratchpad: { path: string }` to `inspect_status` MCP response | Additive | Always present (required `scratchpadPath` on `McpToolContext`). |
| Add `path` field to `read_scratchpad` MCP daemon response | Additive | Snapshot fallback still returns `{ error: "scratchpad_tool_requires_daemon" }` (unchanged); the `path`-bearing shape exists only on the daemon dispatch path. |
| Strip `scratchpad.path` from raw config on **load** under `CITADEL_WORKTREE=1` | Stateful — in-memory only | Matches existing dataDir/databasePath behavior. `PUT /api/config` may persist it; next `loadConfig` drops it. Documented as a non-AC. |
| Make `scratchpadPath` required on `McpToolContext` | Source-breaking | tsc enforces. All construction sites must add the field (one daemon site + one test fixture file). |

**`schema_migrations` row.** N/A — no DDL in `packages/db/src/index.ts` changes.

**`PRAGMA foreign_keys = ON;` preservation.** Unaffected.

**Operator data implications.** Existing installs upgrade transparently: a config file without `scratchpad.path` parses to default `{}`, and `effectiveNotesPath` returns the historical `<dataDir>/scratchpad.md`. No data move, no rewrite. Users who *opt in* by setting a path get a brand-new (empty) file at the new location on first read (with `DEFAULT_STUB`) — unless they point at a pre-existing markdown file, in which case the on-first-read fenced-block migration runs and a `console.warn` line names the file. History remains under `<dataDir>` regardless.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Config schema parse/validate (incl. tilde-expand and rejection messages), worktree-mode strip-on-load, `effectiveNotesPath` helper, route GET shape (`ReadScratchpadResult`), MCP `inspect_status` snapshot shape, daemon `read_scratchpad` dispatch path-enrichment, daemon module path resolution + parent-mkdir + history-stays-in-dataDir, `backfillScratchpadOnStartup` helper. |
| E2E (Playwright) | Required | Cockpit Settings: edit "Notes location" → save → reload → field round-trips and the scratchpad route reads/writes at the new path. Covers the user-visible flow end-to-end. |

### New tests to add

**Unit (Vitest)**

- `packages/config/src/index.test.ts`:
  - "accepts an absolute `scratchpad.path` and round-trips through save/load" — assert `loadConfig` returns the field unchanged when present.
  - "tilde-expands `~/X` to `<homedir>/X` before storage" — assert the persisted, loaded value is fully expanded (not literal `~`).
  - "rejects a relative `scratchpad.path` with a zod validation error" — assert the error path is `["scratchpad", "path"]` AND the message contains the friendly hint about absolute paths and `~/`.
  - "defaults `scratchpad.path` to undefined (so effective path = dataDir/scratchpad.md)" — assert `config.scratchpad.path` is undefined when absent.
  - "in worktree mode (`CITADEL_WORKTREE=1`), strips `scratchpad.path` from the raw config file" — write a config with both `dataDir` and `scratchpad.path` overrides, set the env, assert loaded config drops both AND the original file on disk still contains the stripped key (we strip in-memory only).
  - "in prod mode, honors a persisted `scratchpad.path`" — write a config with `scratchpad.path`, no worktree env, assert loaded config returns it.
  - "`effectiveNotesPath` returns the override when set, else `<dataDir>/scratchpad.md`".
  - "preserves other `scratchpad.*` fields under worktree strip" — write `{ scratchpad: { path: "/x", otherFutureField: 1 } }`, assert load returns `{ scratchpad: { otherFutureField: 1 } }` so future schema growth isn't accidentally clobbered.

- `apps/daemon/src/scratchpad.test.ts`:
  - "writes to the configured `notesPath`, not `<dataDir>/scratchpad.md`, when both are set" — point `notesPath` at a tmp file outside dataDir, write, assert the file exists at `notesPath` and not at the legacy path.
  - "creates the notes file with `DEFAULT_STUB` on first read at a custom path" — analogous to the existing first-read test but with a custom path.
  - "writes history to `<dataDir>/scratchpad-history.jsonl` even when notes live elsewhere" — assert history present at `<dataDir>/scratchpad-history.jsonl` AND assert no `scratchpad-history.jsonl` exists at `path.dirname(notesPath)`.
  - "creates the notes parent directory if missing" — point `notesPath` at `<tmp>/nested/dir/notes.md`, call `readScratchpad`, assert the parent dir was created and the stub file exists.
  - "leaves the notes file alone if it is already fenced-block format" — write a fenced file at custom path, read once, assert zero history entries with source `migrate-to-blocks`.
  - "logs a console.warn naming the path when migrating a pre-existing non-fenced file at a custom path" — use `vi.spyOn(console, 'warn')`, write `alpha\n\nbeta\n` at custom path, read, assert warn called with the path.
  - "`backfillScratchpadOnStartup` operates on `effectiveNotesPath(config)`, not the hardcoded dataDir-based path" — set `config.scratchpad.path` to a tmp file with pre-existing content, call helper, assert backfill ran against that file.

- `apps/daemon/src/scratchpad-routes.test.ts`:
  - "GET `/api/scratchpad` includes `path` field" — assert path equals the effective notes path and is absolute.
  - "honors a `scratchpad.path` set via `PUT /api/config` mid-session, without restart" — POST a config patch setting the path, then call GET `/api/scratchpad`, assert the new path is used (proves handlers re-resolve per-request, not at registration).
  - "PUT `/api/scratchpad` (and block routes) do NOT include `path` in their response" — preserves narrow internal type.

- `packages/mcp/src/index.test.ts`:
  - "`inspect_status` includes `scratchpad: { path }` from the required `McpToolContext.scratchpadPath` field" — construct fixture with `scratchpadPath: "/x/y/scratchpad.md"`, call `callMcpTool({ name: 'inspect_status' }, ctx)`, assert `result.scratchpad.path === "/x/y/scratchpad.md"`.
  - "`mcpToolDefinitions()` `inspect_status` description mentions `scratchpad.path`" — string-search the description for the field reference.
  - "`mcpToolDefinitions()` `read_scratchpad` description mentions `path` in the return shape" — string-search.

- `apps/daemon/src/daemon-mcp-tool.test.ts` (if it exists, else extend the nearest equivalent):
  - "`read_scratchpad` MCP dispatch returns `{ content, updatedAt, path }`" — assert all three fields and that `path` equals `effectiveNotesPath(config)`.

**E2E (Playwright)**

- `e2e/notes-location.spec.ts` (new file):
  - User goes to Settings → structured config → Notes section. Selector: `[data-testid="notes-location-input"]`.
  - Enters an absolute path under a Playwright tmp dir, clicks Save.
  - Reload the page → field still shows the path.
  - Navigates to the scratchpad route, types content, saves.
  - Re-loads the cockpit at the scratchpad route, asserts the content persists (proves the path is honored at the daemon's read path).
  - Clears the field → Save → confirms the cockpit falls back to the default path (scratchpad now reflects the prior default-path content, not the custom-path content).

### Existing tests to update

- `apps/daemon/src/scratchpad.test.ts` and `apps/daemon/src/scratchpad-routes.test.ts`: every call to `readScratchpad`/`writeScratchpad`/etc. — update to pass the new `{ notesPath, dataDir }` signature; default `notesPath` in tests to `path.join(dataDir, 'scratchpad.md')` so behavior matches today.
- `apps/daemon/src/scratchpad-blocks.test.ts`: same migration.
- `apps/daemon/src/scratchpad-routes-blocks.test.ts`: same migration.
- `packages/mcp/src/index.test.ts`: extend the `McpToolContext` fixtures to set `scratchpadPath` (required by the new type); existing assertions stay green.
- `apps/web/src/structured-config.tsx` consumers: no other tests assert the field set, but typecheck will surface every spot the response shape is destructured.
- Any `toEqual`/`toMatchObject` against a full `loadConfig()` result picks up the new `scratchpad: {}` default key (because `.default({})` makes the field always present). Use partial matching (`toMatchObject`) or update the expected object.

### Assertions to add/change/tighten

- Schema validation: assert exact zod error path `["scratchpad", "path"]` AND that the error message includes both "absolute" and "~/" so the wording remains user-friendly.
- Tilde-expand: assert that a config saved with `scratchpad.path = "~/notes.md"` loads back as `path.join(os.homedir(), "notes.md")` (no literal `~` in storage).
- Worktree-strip test: assert in-memory `scratchpad.path === undefined` AND that the original config file on disk still contains the stripped key.
- `GET /api/scratchpad` shape test: assert `typeof body.path === "string"` and `path.isAbsolute(body.path) === true`.
- MCP `inspect_status` shape: assert `result.scratchpad.path === ctx.scratchpadPath` (required field always present).
- History stays in dataDir negative: assert no `scratchpad-history.jsonl` exists at `path.dirname(notesPath)`.
- E2E save+reload: assert the input element's `value` after reload equals the saved string AND the resolved path appears in `/api/scratchpad`'s response.

### Failure modes / edge cases / regression risks

- **User points the path at a file outside their write-permissions** (e.g., `/etc/citadel-notes.md`). On first write the daemon fs error bubbles to a 500. Tracked, not fixed in this PR — out of scope. Add a test that the daemon surfaces a clear error rather than silently swallowing it.
- **User points the path at a path whose parent does not exist.** `ensureNotesParent` mkdir's the immediate parent recursively. Covered by the "creates the notes parent directory if missing" test.
- **Two daemons (e.g., worktree + prod) pointing at the same notes file.** Documented in spec; no file locking in this PR. Last-write-wins; 60s coalesce + history JSONL provide partial recovery.
- **Path field omitted from `read_scratchpad` returned by the snapshot fallback.** Snapshot fallback returns `{ error: "scratchpad_tool_requires_daemon" }` — consumers route through the daemon. No regression.
- **First-read migration on the new path.** The migration is byte-content driven, not path-driven. Configuring a custom path pointing at an already-fenced file does not re-trigger migration. Covered by "leaves the notes file alone if it is already fenced-block format" test. A pre-existing non-fenced file at a custom path IS migrated — `console.warn` line emitted, history recorded under `<dataDir>`. Documented in spec.
- **`backfillIfEmpty` runs on startup against the effective notes path.** Covered by `backfillScratchpadOnStartup` test.
- **`PUT /api/config` from a worktree daemon persisting `scratchpad.path`.** Strip-on-load drops it on next start; documented non-AC. No regression vs existing dataDir behavior.
- **`~` paths.** Tilde-expand preprocess handles `~/X`. Bare `~` (no slash) is rejected as relative by `path.isAbsolute` — acceptable; user is told how to write it correctly.

### Adversarial analysis

- **How could this fail in production?** A user sets `scratchpad.path` to a stale path from a deleted directory; daemon throws ENOENT when the path's grandparent is also missing. `ensureNotesParent` is `recursive: true`, so this auto-creates intermediate dirs — generally OK, but if the path crosses an unmountable filesystem boundary the mkdir errors. Surface as a clear 500; future-improvement.
- **What user actions trigger unexpected behavior?** Toggling the path off (empty string) then on again; switching default → custom → default. Each transition must reset the effective path correctly. Round-trip tested in E2E.
- **What existing behavior could break?** Anything that imports `scratchpadPath` directly. Grep shows three consumers (`scratchpad.ts`, `scratchpad-routes.ts`, `app.ts`); all three are covered. The required `scratchpadPath` on `McpToolContext` forces tsc to surface every construction site. The new `ReadScratchpadResult` type avoids cascading churn on `ScratchpadSnapshot` consumers.
- **Which tests credibly catch those failures?** Schema tests, per-route GET tests (path field present), daemon module tests (writes go to the right file, history stays put, parent mkdir works), MCP tests (inspect_status carries the path), E2E (full round-trip).
- **What gaps remain?** No automated coverage of cross-daemon concurrent writes (out of scope — documented). No coverage of pathological filesystems (read-only mount, network-dropped sync folder mid-write) — these failures will surface as clear 500s. No UI banner for first-read migration on a user's pre-existing file — only a console.warn; tracked as future polish in the spec.

## Tests

Per TDD: write tests first within each implementation unit, then make them pass.

New test files:
- `e2e/notes-location.spec.ts`

Modified test files:
- `packages/config/src/index.test.ts`
- `apps/daemon/src/scratchpad.test.ts`
- `apps/daemon/src/scratchpad-routes.test.ts`
- `apps/daemon/src/scratchpad-blocks.test.ts`
- `apps/daemon/src/scratchpad-routes-blocks.test.ts`
- `packages/mcp/src/index.test.ts`
- `apps/daemon/src/daemon-mcp-tool.test.ts` (if present; else extend nearest)

## Schema or contract generation

No generated artifacts. The contract change is a hand-edited type in `packages/contracts/src/scratchpad.ts` (new `ReadScratchpadResult` type; `ScratchpadSnapshot` unchanged). After editing, `pnpm typecheck` surfaces every consumer that needs updating (boundary callers only).

## Verification

Before opening the PR, the following must pass:

- `make check` — full local gate: `check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage`, `check:deps`, `build`.
  - **Pre-flight on `check:size`:** the gate already fails on main (`app.ts`=808, `contracts/src/index.ts`=803, `operations/src/index.ts`=813). This plan does NOT add to these files except `app.ts` via the `backfillScratchpadOnStartup` extraction, which net-reduces it. Capture `wc -l apps/daemon/src/app.ts` before edits, re-check after, confirm not-greater. Do not "fix" the other two pre-existing failures in this PR.
- `make e2e` — Playwright tests, including the new `e2e/notes-location.spec.ts`.
- `make smoke` — daemon HTTP smoke. Required because we change `/api/scratchpad`'s GET shape and `/api/config`'s schema.
  - **Pre-flight on smoke:** locate the smoke harness (`packages/smoke` or `scripts/smoke.*` per repo layout); confirm it exercises `GET /api/scratchpad`. If absent, add a one-line assertion checking the response has `content`, `updatedAt`, and `path` fields.

`make performance` is NOT required — this change adds a path lookup on each scratchpad request, which is negligible.
