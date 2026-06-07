Activate the /implement-task skill first.

# Plan: PR Merge Admin Bypass

## Acceptance Criteria
- [ ] "since i made my repo public, i enabled need a review to merge so people cannot merge stuff to my repo without me knowing."
- [ ] "however since i'm solo, no one can review my prs so i have to bypass and merge PRs - but citadel doesn't support this in the merge button - we need to add support for it."
- [ ] "Run /do-tech-plan and then /implement-task on that plan to implement this please."
- [ ] Normal PR merges continue to omit GitHub's `--admin` flag.
- [ ] When the operator explicitly selects admin bypass in the merge menu, Citadel runs the merge with GitHub's `--admin` flag.
- [ ] Invalid `admin` request values are rejected by the daemon merge endpoint instead of being silently accepted or coerced.
- [ ] `pr.merge` hooks receive the admin-bypass flag so hook-backed merge flows can honor the same operator intent.
- [ ] The UI admin-bypass control is unchecked by default and must be explicitly selected for each merge.
- [ ] The UI resets admin bypass after every merge attempt and whenever the menu closes/reopens or the workspace/PR context changes.

## Context and problem statement
Citadel already exposes a Merge action in the inspector PR card. The web UI calls `POST /api/workspaces/:workspaceId/pr-merge`, the daemon validates a merge strategy and delegates to `@citadel/providers.mergePr`, and the provider runs `gh pr merge <number> --<strategy>` without `--delete-branch`.

For a public GitHub repository with required reviews enabled, a solo owner/admin may need to intentionally bypass unmet repository requirements. The local `gh pr merge --help` confirms the supported flag is `--admin`, described as using administrator privileges to merge a pull request that does not meet requirements. Citadel needs to expose that option explicitly without weakening its existing normal merge path.

## Spec alignment
Applicable specs:
- `specs/A-shared-definitions.md` for Provider, Operation, and Action terminology.
- `specs/B.4-git-pr-ci-diff.md` for PR merge behavior.
- `specs/B.2-ade-cockpit.md` for cockpit operator action behavior.
- `specs/B.8-ui-performance-quality.md` for UI quality and test expectations.

Spec update required first:
- Update `specs/B.4-git-pr-ci-diff.md` PR Identity item 13 to state that the Merge action can explicitly pass GitHub's admin bypass flag for unmet repository requirements, while still respecting allowed merge strategies and never deleting the head branch by default.

No DB schema changes. This does change the PR merge request contract in `@citadel/contracts`.

## Implementation approach
Add an optional `admin` boolean to the PR merge contract. Keep the default `false` so existing callers keep the same behavior. Reject non-boolean `admin` values. Thread the parsed field through the daemon route, PR merge hook payload, provider helper, and web merge dropdown.

In the UI, add a `role="menuitemcheckbox"` control inside the existing merge strategy menu labeled "Admin bypass" with clear text that it bypasses unmet repository requirements. The normal strategy buttons still execute normal merges by default; when the operator checks the bypass option, the request body includes `admin: true` and the provider adds `--admin` to the `gh pr merge` invocation.

Because `packages/providers/src/index.ts` is already at 799 lines, first extract the shared GitHub CLI runner state into an internal provider module, then move the merge helper into a small provider module and re-export it from the package entry. This avoids violating the 800-line source file limit, preserves the existing `@citadel/providers` import path, and avoids a circular import between the package entry and the extracted merge helper.

## Alternatives considered
Only retry failed merges with `--admin` after a normal merge fails. Rejected because it turns bypassing repository rules into a hidden fallback. The operator should make the bypass explicit before Citadel invokes admin privileges.

A separate "Bypass and merge" button outside the dropdown. Rejected because the PR card is intentionally constrained to a single action slot, and merge strategy selection already lives in the dropdown.

## Implementation steps

### Spec Update
- Update `specs/B.4-git-pr-ci-diff.md` PR Identity item 13 to include explicit admin bypass support for unmet repository requirements.

### Contract and Provider
- Update `packages/contracts/src/pr-routes.ts` so `PrMergeRequestSchema` accepts optional `admin` with default `false`.
- Confirm the contract rejects non-boolean `admin` values and preserves default `admin: false`.
- Extract the shared GitHub CLI runner and `setGithubCommand` state from `packages/providers/src/index.ts` into a separate internal module.
- Extract `mergePr` from `packages/providers/src/index.ts` into a new small provider module that imports the internal runner directly; re-export public functions from `packages/providers/src/index.ts`.
- Update `mergePr` to append `--admin` only when `input.admin === true`.
- Preserve the existing no-`--delete-branch` behavior.
- File-size gate: keep all edited non-generated files under 800 lines; the extraction should reduce `packages/providers/src/index.ts`.

### Daemon Route
- Update `apps/daemon/src/pr-routes.ts` to parse `admin`, include it in `pr.merge` hook payloads, and pass it to `mergePr`.
- Keep route status behavior unchanged: 200 on direct merge success, 202 when hooks handle the merge, 409 on merge failure/no PR.
- Provider degradation: existing GitHub CLI health and gh cooldown behavior remains the availability gate; if admin privilege is unavailable, `gh` failure still returns a structured merge failure rather than silently retrying.

### Web UI
- Update `apps/web/src/pr-card-actions.tsx` to add a compact `role="menuitemcheckbox"` control in the merge menu for "Admin bypass".
- Include `aria-checked`, stop propagation on the toggle, and keep keyboard/click behavior compatible with the existing menu.
- Send `{ strategy, admin: true }` only when the checkbox is checked; omit or send `false` for normal merges.
- Reset admin bypass to `false` on menu close/reopen, workspace or PR-number change, and after every merge attempt settles, including failed attempts.
- Close menu state consistently after successful merge.
- Keep disabled-state reasons and the existing provider-health/mergeability gates unchanged.

### Hook Templates
- Update PR merge hook coverage so a `pr.merge` template using `{{admin}}` renders the operator-selected flag for hook-backed merge flows.

### E2E Smoke
- Extend the PR E2E smoke so the deployed daemon rejects an invalid `admin` payload with `400 invalid_merge_request`, proving the deployed route is validating the new field instead of silently stripping unknown keys.
- Optionally also assert `{ strategy: "squash", admin: true }` reaches the existing `no_pr` response for an existing workspace with no PR, but do not rely on that as the only schema proof.

### Migration Strategy
No DB schema changes. No `schema_migrations` entry is required.

## QA/Test Strategy

### Unit (Vitest)
Tests must be updated.

New/updated tests:
- `packages/contracts/src/index.test.ts`: assert `PrMergeRequestSchema.parse({ strategy: "squash" })` returns `admin: false`, `PrMergeRequestSchema.parse({ strategy: "squash", admin: true })` returns `admin: true`, and invalid non-boolean admin values fail.
- `packages/providers/src/pr-merge.test.ts`: add a focused provider test for the extracted merge module that asserts normal merges do not pass `--admin`, admin merges do pass `--admin`, and neither path passes `--delete-branch`.
- `apps/daemon/src/pr-routes.test.ts`: assert `POST /api/workspaces/:id/pr-merge` passes `admin: true` through to the `gh` invocation, and `pr.merge` hook payloads include the admin flag.
- `packages/operations/src/hooks-runner.test.ts`: assert a `pr.merge` template can render `{{admin}}` from the merge hook payload.
- `apps/web/src/pr-card-actions.test.ts`: assert the merge menu renders a bypass checkbox and that checking it causes a merge strategy click to send an admin merge request payload.
- `apps/web/src/pr-card-actions.test.ts`: assert admin bypass resets to unchecked after close/reopen, after workspace/PR context changes, and after a failed merge attempt so a later normal merge omits `admin: true`.

Assertions to tighten:
- Keep the existing provider assertion that `--delete-branch` is never present.
- Add a daemon assertion that invalid `admin` payloads are rejected with `invalid_merge_request` rather than silently coerced.
- Add a web assertion that the bypass option is unchecked by default and uses `role="menuitemcheckbox"`/`aria-checked`.
- Add a web assertion that closing/reopening the menu or completing/failing a merge attempt clears the bypass state before the next strategy click.

Failure modes covered:
- User checks bypass, but Citadel omits `--admin`.
- User performs a normal merge, but Citadel unexpectedly passes `--admin`.
- Web and daemon contract drift on the new field.
- Custom PR merge hooks do not receive enough context to perform their own admin merge.
- A future provider edit accidentally adds `--delete-branch`.

Remaining gaps:
- Local tests cannot prove the caller's GitHub account has admin permission on a real repository. A live GitHub failure remains surfaced as a structured `gh` merge failure.

### E2E (Playwright)
Tests must be updated.

Update `e2e/pr-display.spec.ts` or add a nearby PR merge smoke spec:
- Create/register a local git fixture and workspace.
- POST `{ strategy: "squash", admin: "true" }` to `/api/workspaces/:id/pr-merge`.
- Assert the response is `400 invalid_merge_request`, proving the deployed daemon route validates the new field rather than silently stripping unknown payload.
- Optionally POST `{ strategy: "squash", admin: true }` and assert the response reaches existing PR-state validation, but this is secondary to the invalid-value assertion.

Full PR merge UI E2E is not required because the harness cannot fabricate a live GitHub PR with required-review state. Vitest covers the UI interaction and provider command formation.

### Adversarial Thinking
How this could fail in production:
- GitHub rejects `--admin` because the operator lacks privileges; Citadel should surface the `gh` failure detail.
- The UI could make bypass too easy to trigger accidentally; the checkbox makes the admin path explicit and unchecked by default.
- The UI could accidentally carry a checked admin bypass into a later merge; reset-on-close, reset-on-context-change, and reset-after-settle tests cover this.
- The daemon could accept the field but not pass it to hooks or providers; route tests cover both paths.
- Zod could strip unsupported payload keys and make weak route tests pass before the feature exists; invalid-value E2E coverage prevents that false positive.
- Provider helper extraction could accidentally import from `index.ts` and create a circular import; an internal GitHub runner module avoids that.
- Provider extraction could break existing imports from `@citadel/providers`; typecheck and provider tests cover the package export.
- File growth could violate Citadel's size gate; extraction addresses the known 799-line provider file.

Automated tests that catch these:
- Contract schema tests catch API shape drift.
- Provider command tests catch missing/extra `--admin` and accidental `--delete-branch`.
- Daemon route tests catch route parsing and pass-through regressions.
- Hook runner tests catch template visibility for hook-backed merge flows.
- Web component tests catch UI payload regressions and admin-bypass state leakage.
- E2E smoke catches deployed route registration/schema regressions.

## Tests
- Update `packages/contracts/src/index.test.ts`.
- Add `packages/providers/src/pr-merge.test.ts`.
- Update `apps/daemon/src/pr-routes.test.ts`.
- Update `packages/operations/src/hooks-runner.test.ts`.
- Update `apps/web/src/pr-card-actions.test.ts`.
- Update `e2e/pr-display.spec.ts` or add a PR merge smoke spec.

## Schema or contract generation
No generated schema artifacts. `@citadel/contracts` is the schema package; `pnpm typecheck` validates consumers.

## Verification
- `pnpm vitest run packages/contracts/src/index.test.ts packages/providers/src/index.test.ts packages/providers/src/pr-merge.test.ts apps/daemon/src/pr-routes.test.ts packages/operations/src/hooks-runner.test.ts apps/web/src/pr-card-actions.test.ts`
- `pnpm exec playwright test e2e/pr-display.spec.ts`
- `pnpm check:arch`
- `pnpm check:size`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm coverage`
- `pnpm build`
- `make check`
- `pnpm e2e`
