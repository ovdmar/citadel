# Audit-test-coverage extension — Citadel

## Acceptance criteria sources

Priority order:

1. **Plan file.** Look for the `## Acceptance Criteria` section in `.agents/plans/<feature-name>.md` (the plan associated with the current branch).
2. **PR description.** `gh pr view --json body` if a PR exists for the branch.
3. **GitHub issue.** If the branch name or recent commits reference `#NN`, fetch with `gh issue view <number>` and look for an acceptance-criteria block.
4. **Ask the user.** If none of the above yield AC, ask once.

## Spec layout

Same glob → spec mapping as `.agents/skills/extensions/review-pr.md` under "Spec mappings". The audit reads relevant specs to understand intended behavior before evaluating test adequacy.

## Test layout

Citadel test layout (used by the auditor to locate existing tests for changed modules):

| Layer | Glob | Notes |
|-------|------|-------|
| Unit (Vitest) | `packages/*/src/**/*.test.ts`, `apps/*/src/**/*.test.ts` | Colocated with source. |
| E2E (Playwright) | `e2e/**/*.spec.ts` | Tests against the running cockpit + daemon. |

For a changed source file at `packages/<pkg>/src/<path>.ts`, the corresponding unit test is `packages/<pkg>/src/<path>.test.ts` (sibling, same directory). For E2E, map by user-visible feature, not by source path.

## Test layers

Override the default four-layer template:

| Layer | Evaluate |
|-------|----------|
| Unit (Vitest) | Pure logic, components, hooks, contract types, cross-package interactions. Target: 90% line coverage on `packages/core` and other coverage-guarded packages. |
| E2E (Playwright) | Full user flows through the cockpit. Required for: changes touching `apps/web` user journeys, changes to daemon HTTP contracts that the web app consumes, terminal interactions visible to operators. |

No separate Integration layer — Vitest exercises cross-package code paths via real imports (no mocking between Citadel packages); the daemon's external HTTP surface is exercised end-to-end via Playwright.

For changes touching `packages/terminal` or `apps/daemon/src/agents`, the audit must check coverage of the terminal-completeness dimensions: raw input, control/meta sequences, paste, resize, long output, alternate screen (where supported), reconnect, cross-session isolation. Treat missing coverage on any of these as HIGH severity.

For changes touching `packages/db/src/index.ts` schema regions, the audit must check whether tests exercise: the new schema applied to a fresh database, the new schema applied to a database with pre-existing data from a prior version, and `PRAGMA foreign_keys = ON` behavior.
