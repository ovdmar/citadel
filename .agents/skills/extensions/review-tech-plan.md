# Review-tech-plan extension — Citadel

## Additional hard gates

Append these to the two universal gates (Spec gate, Regression test gate) when reviewing a plan for Citadel.

### Architecture-boundary gate
**APPLIES** when the plan touches:
- `packages/core/**` (any new imports)
- `apps/web/**` (any new imports of `@citadel/daemon` or implementation packages)
- `apps/cli/**` (any new imports of `@citadel/daemon`)
- A new package or cross-package import not previously present

The plan must confirm the change does not violate the boundaries enforced by `scripts/checks/architecture-boundaries.ts`:
- Core must not import `fs`, `process`, `node:http`, `react`, `@citadel/db`, `@citadel/providers`, `@citadel/hooks`, `@citadel/terminal`, `@citadel/runtimes`, `@citadel/daemon`, `@citadel/mcp`.
- Web must call the daemon via `@citadel/contracts` only — never import daemon internals.
- CLI talks to the daemon via API — never via direct imports.

**SKIP** for pure refactors that move code within an existing boundary, pure docs/comment changes, or changes inside a single package.

### Schema-safety gate
**APPLIES** when the plan modifies `packages/db/src/index.ts` schema regions (`CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`, `DROP`) or adds `.sql` under `packages/db/`.

The plan's Migration strategy subsection must:
- Classify every operation as additive / destructive / rename per the inline-DDL pattern in the do-tech-plan extension.
- Declare the next monotonic `schema_migrations` version.
- Confirm `PRAGMA foreign_keys = ON;` is preserved.
- State the impact on already-deployed operator databases (Citadel is local-first — every install runs the new schema on startup, including dropped columns and type changes).

**SKIP** for changes outside `packages/db/`.

### File-size gate
**APPLIES** always.

The plan must not propose creating non-generated source files over 800 lines (the limit enforced by `scripts/checks/file-size.ts`). If the change would push an existing file over the limit, the plan must include a split/extraction step.

**SKIP** never — this gate always applies, but a plan that doesn't touch any file near the limit can address it with a one-line statement: "No file approaches the 800-line limit."

### Provider-degradation gate
**APPLIES** when the plan adds or modifies a provider-backed feature (any code path that calls `@citadel/providers`).

The plan must specify how the feature behaves when provider health is unavailable (down, rate-limited, misconfigured). "Degrade clearly" is required per `docs/contributors/v2-engineering-standards.md`.

**SKIP** for changes that don't touch provider-backed code paths.

### Workspace-cleanup-safety gate
**APPLIES** when the plan touches workspace lifecycle code (creation, deletion, cleanup, worktree management — typically in `packages/operations`, `apps/daemon/src/operations/`).

The plan must not propose any change that deletes dirty worktrees without an explicit force policy. Per `docs/contributors/v2-engineering-standards.md`: workspace cleanup must not delete dirty worktrees unless an explicit force policy is implemented and logged.

**SKIP** for changes that don't touch workspace lifecycle.

### Terminal-completeness gate
**APPLIES** when the plan touches terminal code (`packages/terminal`, `apps/daemon/src/agents/`, anything dealing with PTY/xterm).

The plan must include test coverage for: raw input, control/meta sequences, paste, resize, long output, alternate screen (where supported), reconnect, and cross-session isolation. Per the engineering standards, terminal work is not complete without verifying these dimensions.

**SKIP** for non-terminal changes.

### Lockfile-sensitivity gate
**APPLIES** when the plan adds, removes, or upgrades dependencies (any change to `package.json` dependencies, dev-dependencies, or pnpm-lock.yaml).

The plan must:
- Justify each new dependency.
- Confirm package lifecycle scripts (`preinstall`, `install`, `postinstall`) of new dependencies were reviewed.
- Not introduce `package-lock.json` or `yarn.lock` (pnpm only).

**SKIP** for changes that don't touch dependencies.
