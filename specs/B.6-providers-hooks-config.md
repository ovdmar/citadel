# [B.6] Providers, Hooks, And Config

**Status:** Draft

> Providers and hooks make Citadel extensible while keeping the default product useful.

## Providers

[~] 1. Providers normalize external systems into Citadel contracts.
[ ] 2. Built-in providers can ship in-tree while staying isolated and config-activated.
[ ] 3. GitHub provider uses gh for auth, health, PR, review, checks, and URLs where practical.
[ ] 4. Jira provider uses shell-backed tools such as acli/jtk for auth, health, issue state, and transitions where practical.
[ ] 5. Usage provider is provider/hook based.
[ ] 6. Provider health is visible.
[ ] 7. Provider degraded state explains missing/stale data.
[ ] 8. Provider data includes refresh age.
[ ] 9. Citadel prefers existing external tool auth for the first production baseline.

## Provider Setup

[ ] 1. First-run config shows available provider types.
[ ] 2. Provider setup shows required external tools.
[ ] 3. Provider setup validates binary availability.
[ ] 4. Provider setup validates auth/health.
[ ] 5. Provider setup records enabled/disabled state.
[ ] 6. Provider setup explains which product surfaces the provider powers.

## Hooks

[~] 1. Hooks are the extension path for repo-specific behavior.
[ ] 2. Setup hooks are configured per repo.
[ ] 3. Teardown hooks are configured per repo.
[ ] 4. App/link discovery hooks are configured per repo.
[ ] 5. Action hooks are configured per repo.
[ ] 6. Hooks receive structured workspace/repo/provider context.
[ ] 7. Hooks return structured JSON.
[ ] 8. Hook output is validated before it appears in the UI.
[ ] 9. Hook execution has explicit cwd/env policy, timeout, output bounds, and logs.
[ ] 10. Hook diagnostics show configured hooks, last run, validation status, sample output shape, and errors.

## Config And Settings

[ ] 1. Citadel has a first-run config/init surface.
[ ] 2. Settings can manage providers, runtimes, repos, hooks, health checks, and UI preferences.
[ ] 3. Settings show missing external tools and unauthenticated providers.
[ ] 4. Settings show unhealthy provider/hook states.
[ ] 5. Settings can validate a repository configuration before it is used by workspace flows.
[ ] 6. Settings can export or reveal the config source for advanced users.
[ ] 7. Future API-backed providers can manage API keys through provider-specific settings.

---

keywords: providers, hooks, config, settings, first run, github, jira, usage, secrets, health checks
