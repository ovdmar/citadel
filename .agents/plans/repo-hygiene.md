Activate the /implement-task skill first.

# Plan: Repo Hygiene

## Acceptance Criteria

- [ ] Add `.vite/` and `.claude/scheduled_tasks.lock` to `.gitignore`

## Context and problem statement

The repository already ignores common generated outputs such as `node_modules/`, `dist/`, coverage, Playwright reports, logs, TypeScript build info, and emitted JS/declaration artifacts. Two local-runtime artifacts are still unignored:

- `.vite/`, which can be produced by Vite tooling and cache flows.
- `.claude/scheduled_tasks.lock`, which is a local Claude Code scheduler lock file.

These files are operator- and workspace-local artifacts. They should not appear as untracked changes in Citadel workspaces or accidentally enter commits.

## Spec alignment

Relevant specs:

- `specs/A-shared-definitions.md` for canonical terms: Repository, Workspace, Agent session.
- `specs/C-technical-stack.md` because this is repository tooling hygiene around Vite and local development artifacts.

The change aligns with the technical stack spec: Citadel uses Vite and local agent/runtime tooling, and the repository should keep generated local artifacts out of source control. No product behavior changes and no spec status updates are required.

Hard gate applicability:

- Spec gate: skipped for implementation-status changes. This is a chore that preserves existing technical-stack behavior.
- Regression test gate: skipped. No runtime behavior, bug fix, API contract, or user flow changes.
- Architecture-boundary gate: skipped. No package imports or application code changes.
- Schema-safety gate: skipped. No database files or schema DDL changes.
- File-size gate: applies and is satisfied. Only `.gitignore` changes; no non-generated source file approaches the 800-line limit.
- Provider-degradation gate: skipped. No provider-backed code paths change.
- Workspace-cleanup-safety gate: skipped. No workspace lifecycle cleanup code changes.
- Terminal-completeness gate: skipped. No terminal code changes.
- Lockfile-sensitivity gate: skipped. No dependency or lockfile changes.

## Implementation approach

Append the two missing ignore patterns to the existing `.gitignore`, grouped near the other generated/local artifacts. Use exact patterns:

- `.vite/`
- `.claude/scheduled_tasks.lock`

The `.vite/` pattern intentionally matches Vite cache directories named `.vite` anywhere under this repo's `.gitignore` scope, which matches the requested pattern and keeps package-local Vite caches out of git noise too. Verify with `git check-ignore` so the checks fail before the edit and pass after the edit.

## Alternatives considered

- Ignore all of `.claude/`: rejected because this is broader than the requested hygiene change and could hide future repo-relevant Claude configuration or documentation.
- Ignore only the repo-root Vite cache with `/.vite/`: rejected because the acceptance criterion names `.vite/`, and ignoring package-local Vite cache directories is also desirable generated-artifact hygiene in this monorepo.
- Leave the artifacts unignored and rely on operator discipline: rejected because these are local generated files and should not create recurring workspace noise.

## Implementation steps

### Git Ignore Hygiene

- Confirm `git check-ignore -q .vite/` fails before the edit.
- Confirm `git check-ignore -q .claude/scheduled_tasks.lock` fails before the edit.
- Add `.vite/` to `.gitignore`.
- Add `.claude/scheduled_tasks.lock` to `.gitignore`.
- Confirm `git check-ignore -q .vite/` passes after the edit.
- Confirm `git check-ignore -q .claude/scheduled_tasks.lock` passes after the edit.
- Confirm `git check-ignore -v .vite/ .claude/scheduled_tasks.lock` reports `.gitignore` as the matching source for both patterns.

### Migration strategy

No schema changes.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Not required | The change does not alter TypeScript, runtime logic, package contracts, hooks, components, or pure utilities. There is no unit-testable behavior. |
| E2E (Playwright) | Not required | The change does not touch the web cockpit, daemon-served HTTP contracts, or an operator user journey. |

### New tests to add

- None. No automated test files should be created for a `.gitignore`-only change.

### Existing tests to update

- None. Existing Vitest and Playwright tests do not assert repository ignore metadata.

### Assertions to add/change/tighten

- Add no code assertions.
- Use `git check-ignore -q .vite/ && git check-ignore -q .claude/scheduled_tasks.lock` as the targeted repository hygiene assertion.
- Use `git check-ignore -v .vite/ .claude/scheduled_tasks.lock` to confirm the matches come from the repo `.gitignore`, not a global ignore file or `.git/info/exclude`.

### Failure modes / edge cases / regression risks

- Pattern omitted or misspelled: `.vite/` or `.claude/scheduled_tasks.lock` continues showing up as untracked workspace noise. The two `git check-ignore -q` assertions catch this.
- Pattern is too broad: a useful `.claude/` file could be hidden from git. Exact lock-file matching avoids this.
- Pattern is placed in a confusing location: future maintainers may miss local tooling artifacts. Placing it with generated/local outputs keeps the file coherent.
- Path is ignored by a global excludes file rather than this repo: the `git check-ignore -v` source check catches this.

### Adversarial analysis

- **How could this fail in production?** It cannot affect production runtime directly. The realistic failure is repository hygiene: local cache or lock files remain visible or accidentally committed.
- **What user actions trigger unexpected behavior?** Running Vite tooling or Claude Code scheduled tasks in a Workspace can create the ignored paths.
- **What existing behavior could break?** Overly broad ignore patterns could hide intended repo files. Exact patterns prevent that.
- **Which tests credibly catch those failures?** `git check-ignore -q .vite/ && git check-ignore -q .claude/scheduled_tasks.lock` catches missing or misspelled ignore entries.
- **Which tests credibly catch source drift?** `git check-ignore -v .vite/ .claude/scheduled_tasks.lock` confirms the repo `.gitignore` owns the ignore behavior.
- **What gaps remain?** The check only covers these two requested paths. It does not audit every possible generated artifact in the Repository.

## Tests

TDD order:

- Run `git check-ignore -q .vite/` before editing and confirm it fails.
- Run `git check-ignore -q .claude/scheduled_tasks.lock` before editing and confirm it fails.
- Edit `.gitignore`.
- Run `git check-ignore -q .vite/` after editing and confirm it passes.
- Run `git check-ignore -q .claude/scheduled_tasks.lock` after editing and confirm it passes.
- Run `git check-ignore -v .vite/ .claude/scheduled_tasks.lock` after editing and confirm both matches come from `.gitignore`.

No Vitest or Playwright test files will be created or modified.

## Schema or contract generation

Not applicable. No API contracts, schemas, generated clients, or database schema artifacts change.

## Verification

- `git check-ignore -q .vite/ && git check-ignore -q .claude/scheduled_tasks.lock` - targeted verification that both requested artifacts are ignored.
- `git check-ignore -v .vite/ .claude/scheduled_tasks.lock` - targeted verification that both requested artifacts are ignored by the repository `.gitignore`.
- `make check` - comprehensive Citadel local gate required by the Citadel PR workflow before opening the PR.
