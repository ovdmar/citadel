# Review extension — Citadel

Repo-specific content the `/review` skill folds into its generic pipeline.

## Conventions

Convention sources to load in Phase 2 (these are repo-canonical, prefer them over inferring conventions from code):

- `docs/contributors/v2-engineering-standards.md`
- `docs/architecture/citadel-v2-architecture.md` — read when changes touch architectural boundaries (apps ↔ packages, daemon internals, core purity)

Agent 1 checks — flag clear, objective violations of these (skip anything `pnpm check` already enforces):

- **Core purity.** `packages/core` must not import from `fs`, `process`, `node:http`, `react`, `@citadel/db`, `@citadel/providers`, `@citadel/hooks`, `@citadel/terminal`, `@citadel/runtimes`, `@citadel/daemon`, `@citadel/mcp`, or any implementation package. Core is pure types and logic. (CI also enforces via `scripts/checks/architecture-boundaries.ts` — only flag if a violation slips past.)
- **Web ↔ daemon boundary.** `apps/web` must not import daemon internals. It calls the daemon via typed contracts only (`@citadel/contracts`).
- **CLI ↔ daemon boundary.** `apps/cli` interacts with the daemon over the API, not via direct daemon imports.
- **Provider degradation.** Provider-backed features must degrade clearly when provider health is unavailable. Flag new provider call sites without an unhealthy-fallback path.
- **Workspace cleanup safety.** Workspace cleanup must not delete dirty worktrees unless an explicit force policy is implemented and logged. Flag any new cleanup path that bypasses this.
- **Terminal completeness.** Terminal features are not complete until: raw input, control/meta sequences, paste, resize, long output, alternate screen (where supported), reconnect, and cross-session isolation are verified. Flag terminal PRs missing test coverage for these dimensions.
- **Lockfile sensitivity.** Treat changes to `pnpm-lock.yaml` as security-sensitive. Flag new dependencies whose package lifecycle scripts (`postinstall`, `preinstall`, `install`) weren't reviewed.
- **Package manager.** Use pnpm only. Flag any introduction of `package-lock.json` or `yarn.lock`.

## Spec mappings

Glob → spec mapping. Apply to every changed file in Phase 2 step 4 and Agent 2.

| Glob | Spec |
|------|------|
| `packages/contracts/**`, `packages/core/**`, `packages/db/**` | `specs/A-shared-definitions.md` plus the relevant `B.*` for the touched domain |
| `packages/operations/**`, `apps/daemon/src/operations/**` | `specs/B.1-repositories-workspaces.md`, `specs/B.7-operations-activity-mcp.md` |
| `apps/web/**`, `packages/ui/**` | `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md` |
| `packages/terminal/**`, `apps/daemon/src/agents/**` | `specs/B.3-agent-sessions-terminal.md` |
| `packages/providers/**` (git/github bits), `apps/daemon/src/git/**` | `specs/B.4-git-pr-ci-diff.md` |
| `apps/cli/**`, `packages/hooks/**` (apps/links/actions) | `specs/B.5-apps-links-actions.md` |
| `packages/providers/**`, `packages/hooks/**`, `packages/config/**` | `specs/B.6-providers-hooks-config.md` |
| `packages/mcp/**`, `apps/daemon/src/operations/**`, `apps/daemon/src/activity/**` | `specs/B.7-operations-activity-mcp.md` |
| Anything touching build, tsconfig, biome config, scripts/checks | `specs/C-technical-stack.md` |

If a change is cross-cutting (touches multiple domains), read every matching spec.

## Schema migration patterns

Citadel uses SQLite with a single inline schema declared in `packages/db/src/index.ts` (look for `CREATE TABLE IF NOT EXISTS` and the `schema_migrations` table). There is no separate `migrations/` directory — schema changes are diffs to that file plus a corresponding `schema_migrations` row.

Trigger Agent 4 (Schema migration safety) when the diff modifies:
- `packages/db/src/index.ts` schema-definition regions (`CREATE TABLE`, `CREATE INDEX`, `INSERT OR IGNORE INTO schema_migrations`, `ALTER TABLE`)
- Any new `.sql` file added under `packages/db/`

Always-blocking checks for citadel's pattern:

- **No `DROP TABLE` / `DROP COLUMN` without a follow-up migration row** documenting the rename or removal. Citadel is local-first — every existing install runs the schema on startup, so destructive DDL silently breaks running databases.
- **No type narrowing on existing columns** (e.g. `TEXT` → `INTEGER`) without an explicit data migration step recorded in `schema_migrations` and a clear fallback for old rows.
- **No removal of `FOREIGN KEY` constraints** without explicit operator-facing notes — referential integrity is a product guarantee.
- **`schema_migrations` version monotonicity** — new schema work must `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)` with a version strictly greater than the previous max. Flag any version reuse, gap, or missing `INSERT OR IGNORE`.
- **`PRAGMA foreign_keys = ON;` must remain set** at connection open. Flag any change that disables it.

Flag-for-attention (CONVENTION, not MIGRATION):

- Adding NOT NULL column to a previously-deployed table without a default — existing rows on operator machines will fail to satisfy the constraint.
- Adding a `UNIQUE` constraint to a column that may already contain duplicates in deployed databases.
- Large data backfills inside the same connection that runs the schema (no transaction discipline).

Skip-safe:

- Adding entirely new tables (`CREATE TABLE IF NOT EXISTS new_table`).
- Adding nullable columns with `ALTER TABLE ... ADD COLUMN ... NULL`.
- Changes to `CREATE INDEX IF NOT EXISTS` (indexes can be rebuilt safely).

## Linter coverage

Phase 6 filter 3 ("is it a linter's job?") should discard findings already covered by these commands:

- `pnpm check` runs: `check:arch` (architecture boundaries), `check:size` (file size limit, 800 lines for non-generated source), `typecheck` (TypeScript strict, project references), `lint` (Biome), `test` (Vitest unit), `coverage` (Vitest coverage — 90% target on core/backend/shared), `check:deps` (dependency policy), `build` (pnpm -r build).
- `pnpm e2e` runs: Playwright end-to-end tests.
- `pnpm smoke` / `pnpm performance` run local smoke + perf checks against a running daemon.

Specifically, do not flag:

- File length over 800 lines for non-generated sources — `check:size` catches it.
- Cross-package import boundary violations — `check:arch` catches them. (Still flag *new* boundaries the script doesn't yet know about, with a note to extend the script.)
- Biome lint or format violations.
- TypeScript type errors.
- Vitest test failures or coverage drops below 90% on guarded modules.
- Dependency policy violations.
- Build failures.

Cross-module quality findings (dead exports, orphaned files, contract drift between `@citadel/contracts` and consumers) are NOT covered by CI — keep those.

## Additional auditors

None for now. The seven canonical agents plus the conditional schema-migration agent cover Citadel's needs at this stage. Revisit once the daemon's MCP surface and provider abstractions stabilize.
