# Implement-task extension — Citadel

## Plan intake

Plans live in `.agents/plans/` as `<feature-name>.md`. A plan file is recognized by starting with the exact line:

```
Activate the /implement-task skill first.
```

If the prompt attaches or references a file under `.agents/plans/`, treat it as the plan. Otherwise, look for the most recently modified `.md` file in `.agents/plans/` whose first line matches the handoff signal.

## Branch naming

Pattern: `fb-<short-description>`. Examples: `fb-terminal-shortcuts`, `fb-deploy-hooks`, `fb-navbar-collapsible-groups`. Use kebab-case, no ticket prefix.

For follow-ups on a rejected or revised branch, append `-v2`, `-v3`, etc.

## Targeted check commands

| Scope | Local commands |
|-------|----------------|
| Any non-generated source file changed | `pnpm typecheck` (project references) + `pnpm lint` (biome) |
| Test files changed or production code under test | `pnpm test` (full vitest run — fast enough for Citadel) OR `pnpm vitest run <path>` for a single file |
| Coverage-guarded packages changed (`packages/core`, `packages/contracts`, anything with explicit threshold) | `pnpm coverage` |
| Architecture-boundary-relevant changes (any new cross-package import, new file in `packages/core`, new import in `apps/web` or `apps/cli`) | `pnpm check:arch` |
| File created/grown near 800 lines | `pnpm check:size` |
| Dependency change (`package.json`, `pnpm-lock.yaml`) | `pnpm check:deps` + `pnpm install --frozen-lockfile` |
| Daemon HTTP surface changed (`apps/daemon/src` routes, `@citadel/contracts`) | `pnpm smoke` (requires running daemon: `pnpm dev:daemon` in another shell) |
| `apps/web` UI changed | `pnpm build` (Vite production build) |
| `apps/cli` changed | `pnpm build` |
| E2E surface changed (anything in `apps/web` user journeys or daemon HTTP contracts the web consumes) | `pnpm e2e` (Playwright) |
| Comprehensive pre-PR gate | `make check` (runs arch, size, typecheck, lint, test, coverage, deps, build) |

For Task N+2, default to `make check` if change scope is uncertain — it's the comprehensive gate and is required to pass before opening the PR anyway.

## Per-language hygiene rules

Apply these actively during the TDD cycle. Drawn from `docs/contributors/v2-engineering-standards.md` and recurring patterns in this codebase.

- **No fs/process/HTTP/React/db/provider/hook/terminal/runtime/daemon/MCP imports in `packages/core`.** Core is pure logic.
- **`apps/web` calls daemon via contracts only.** No direct imports from `@citadel/daemon`.
- **`apps/cli` calls daemon via API.** No direct imports from `@citadel/daemon`.
- **TypeScript strict + project references stay green.** No `any`. Use specific types, generics, or `unknown` + type guards.
- **Biome for format and lint.** No alternate formatters. Run `pnpm format` to auto-fix; don't add custom Prettier configs.
- **800-line cap on non-generated source files.** If a file approaches the limit, split — never condense to bypass.
- **pnpm only.** Never introduce `package-lock.json` or `yarn.lock`.
- **Provider degradation must be explicit.** Any new code path calling `@citadel/providers` needs an unhealthy/unavailable fallback that surfaces operator-facing state clearly — never a silent retry or empty response.
- **Workspace cleanup never deletes dirty worktrees** without an explicit force policy that is implemented AND logged.
- **Terminal completeness.** New terminal features (anything in `packages/terminal` or `apps/daemon/src/agents`) need test coverage for: raw input, control/meta sequences, paste, resize, long output, alternate screen (where supported), reconnect, cross-session isolation.
- **Sqlite schema changes are append-only in spirit.** Modifications to `packages/db/src/index.ts` schema regions must go through the inline-DDL migration pattern: add a new `schema_migrations` row, preserve `PRAGMA foreign_keys = ON;`, and consider operator data in already-deployed databases.
- **Coverage threshold 90% on core/backend/shared.** Don't drop below — extend tests or document the explicit lower threshold in the campaign log with rationale.
- **Lockfile changes are security-sensitive.** Review `preinstall`/`install`/`postinstall` scripts of any new dependency before approving.

## Schema regeneration

Citadel has no separate schema-generation step (no OpenAPI / typed client codegen). The `@citadel/contracts` package IS the schema — when contracts change, consumers update via TypeScript's project references the next `pnpm typecheck` cycle.

Skip this section unless we add a codegen step later.

## E2E targeted run

Citadel runs Playwright via `pnpm e2e` or `make e2e`. There's no built-in single-spec invocation in the make targets, but Playwright supports it directly:

```bash
pnpm exec playwright test e2e/operator-cockpit.spec.ts
pnpm exec playwright test --grep "deploy hook"
```

**When local E2E is required:**
- The diff touches `apps/web` user journeys.
- The diff changes the daemon's HTTP contracts that the web app consumes.
- A previous PR run of `pnpm e2e` failed and the fix is in-flight.

**When local E2E is optional:**
- Any other change — CI runs the full E2E suite on every PR.

## Check failure → fix table

Diagnostic shortcuts for common Citadel CI failures.

| Error pattern | Cause | Fix |
|---|---|---|
| `error TS2304: Cannot find name 'X'` | Missing import or stale project-reference build | Add import, or `pnpm typecheck` to rebuild references |
| `error TS2345 ... is not assignable to parameter of type` | Type mismatch — often after contract change | Re-check `@citadel/contracts` shape; update consumers |
| `error TS2307: Cannot find module '@citadel/X'` | New package not built or not in `pnpm-workspace.yaml` | `pnpm install`, then `pnpm build` from repo root |
| `Architecture boundary violation: <package> imports <forbidden>` | `check:arch` script flagged a forbidden cross-package import | Remove the import; refactor through `@citadel/contracts` if crossing app/daemon boundary |
| `File size limit exceeded: <file> has N lines (max 800)` | `check:size` triggered | Split the file into sub-modules; never condense |
| `Dependency policy violation: <package>` | `check:deps` flagged disallowed dependency | Replace the dependency or update the policy in `scripts/checks/dependency-policy.ts` with justification |
| `lint/noExplicitAny` | Biome caught an `any` | Replace with specific type, generic, or `unknown` + type guard |
| `Coverage below threshold: <package> at NN% (target 90%)` | Vitest coverage dropped below the guarded threshold | Extend tests in the affected package; do NOT lower the threshold without explicit documentation in `docs/campaigns/` |
| `vitest: ENOENT node:sqlite` | Test runner's vite bundling tried to bundle a Node built-in | Confirm `packages/db/src/index.ts` uses `createRequire`-based sqlite loading (the established pattern); do not static-import `node:sqlite` |
| Playwright: `chromium not installed` | First-time setup | `pnpm exec playwright install --with-deps chromium` |
| Playwright: `daemon not reachable` | Daemon isn't running for the E2E run | `pnpm dev:daemon` in another shell, or use the deploy mode (`make deploy` then `make e2e`) |

## Postponement

Deferral marker: `// TODO(implement-task): <description>` placed at the exact code location where work remains.

Citadel does not use an external ticket tracker for individual deferred work. For significant deferred items, append a bullet to the relevant campaign log under `docs/campaigns/` with: branch name, file:line, description, why deferred.
