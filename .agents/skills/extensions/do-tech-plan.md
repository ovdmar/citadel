# Do-tech-plan extension — Citadel

Repo-specific content the `/do-tech-plan` skill folds into its generic flow.

## Ticketing

Citadel does not use Jira or an external tracker for individual tasks. Requirements come from:
- The user's prompt directly.
- GitHub issues, when the prompt references one (`#NN` or a GitHub issue URL). Fetch via `gh issue view <number>` if referenced; otherwise skip ticket loading.
- Higher-level direction in `docs/campaigns/citadel-v2-goal.md`.

No automatic ticket detection — treat the prompt as the requirements source unless a `#NN` reference is present.

## Spec layout

Use the same glob → spec mapping documented in `.agents/skills/extensions/review-pr.md` under "Spec mappings". The plan must cite every spec it touches and propose spec updates as the first implementation step when behavior diverges or new behavior is added.

If the change is purely infrastructural (build, tsconfig, biome, scripts/checks, CI), reference `specs/C-technical-stack.md`.

## Domain glossary

Citadel has no dedicated glossary file. Use the term definitions in `specs/A-shared-definitions.md` as the canonical naming source. Match the language in there (Repository, Workspace, Agent session, Operation, Activity event, Provider, Hook) in plan text, code identifiers, and API fields.

## Branch naming

Pattern: `fb-<short-description>`. Examples from the repo: `fb-terminal-shortcuts`, `fb-deploy-hooks`, `fb-navbar-collapsible-groups`. Use kebab-case, no ticket prefix.

For follow-up iterations on a rejected or revised branch, append `-v2`, `-v3`, etc. — e.g., `fb-theme-unitary` → `fb-theme-unitary-v2`.

## Schema migration planning

Citadel uses SQLite with inline DDL in `packages/db/src/index.ts` plus a `schema_migrations` version table. There is no separate `migrations/` directory.

When a plan involves schema changes, the Migration strategy subsection must include:

1. **Operation list.** Every schema operation the implementation will perform (CREATE TABLE / CREATE INDEX / ALTER TABLE / DROP / data backfill).
2. **Classification per operation:**
   - **Additive** (CREATE TABLE for new table, ADD COLUMN nullable, CREATE INDEX) — safe; ships in one step.
   - **Destructive** (DROP TABLE, DROP COLUMN, type narrowing, FK removal) — must follow an expand-contract sequence across multiple deploys.
   - **Rename** — staged with a state-only step first (compat read of both names), then the actual rename.
3. **`schema_migrations` row.** Every change must `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)` with a version strictly greater than the previous max. The plan must declare the new version number and the name.
4. **`PRAGMA foreign_keys = ON;` preservation.** The plan must confirm the change does not disable FKs.
5. **Operator data implications.** Citadel is local-first — every existing install runs the new schema on startup. The plan must state what happens to a database that already has data when the new schema runs.

## Test layers

Override the default four-layer template. Citadel uses two layers:

| Layer | Evaluate |
|-------|----------|
| Unit (Vitest) | Pure logic, components, hooks, contract types — colocated `packages/*/src/*.test.ts`. Target: 90% line coverage for core/backend/shared per `docs/contributors/v2-engineering-standards.md`. |
| E2E (Playwright) | Full user flows through the cockpit — `e2e/*.spec.ts`. Required for changes touching `apps/web` user journeys or daemon-served HTTP contracts the web app consumes. |

No separate "integration" layer — Vitest covers cross-package interactions when packages import each other; the daemon is exercised via E2E.

## Plan output

Directory: `.agents/plans/`. Filename: `<feature-name>.md` matching the planned branch name without the `fb-` prefix (e.g., branch `fb-terminal-shortcuts` → plan `.agents/plans/terminal-shortcuts.md`).

Handoff opening line:
```
Activate the /implement-task skill first.
```

## Verification commands

- `make check` — runs `check:arch`, `check:size`, `typecheck`, `lint` (biome), `test` (vitest), `coverage` (vitest --coverage), `check:deps`, `build`. This is the comprehensive local gate.
- `make e2e` — Playwright happy-path tests.
- `make smoke` — local API smoke against a running daemon (use when daemon-side changes affect operator-visible APIs).
- `make performance` — local performance smoke against running app (use when changes might affect startup or hot paths).

The plan's Verification section must list every command that must pass before opening the PR. For changes touching the daemon's HTTP surface, include `make smoke`. For changes touching startup or rendering hot paths, include `make performance`.
