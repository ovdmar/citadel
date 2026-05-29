# [B.6] Providers, Hooks, And Config

**Status:** Draft

> Providers and hooks make Citadel extensible while keeping the default product useful.

## Providers

[~] 1. Providers normalize external systems into Citadel contracts.
[ ] 2. Built-in providers can ship in-tree while staying isolated and config-activated.
[ ] 3. GitHub provider uses gh for auth, health, PR, review, checks, and URLs where practical.
[ ] 4. Jira provider uses shell-backed tools such as acli/jtk for auth, health, issue state, and transitions where practical.
[ ] 5. Usage provider is provider/hook based.
[ ] 6. Provider health is visible per provider AND per interaction method.
[ ] 7. Provider degraded state explains missing/stale data.
[~] 8. Provider data includes refresh age. The GitHub provider additionally surfaces an active rate-limit cooldown via `versionControl.cooldownUntil` (ISO timestamp) so the cockpit can render an explicit "retrying at HH:MM" banner instead of an opaque "degraded".
[ ] 9. Citadel prefers existing external tool auth for the first production baseline.

## Provider Category Model (source of truth)

Citadel organises providers by **service category**, not by tool name. Each category has one active provider; each provider has one active interaction method. The UI in `apps/web/src/settings-providers.tsx` is the source-of-truth presentation of this model.

Categories (current):

- **Tickets** — issue tracking and transitions. Providers: `jira` (supported). Future: Linear, ClickUp.
- **Git server / PR / CI** — pull requests, reviews, status checks, CI runs. Providers: `github` (supported). Future: GitLab, Gitea, Bitbucket.

Each provider declares one or more interaction methods. Today's wired methods:

- Jira → `jtk` (shell-backed). Planned: `acli`, direct REST + API token.
- GitHub → `gh` (shell-backed). Planned: direct REST + API token.

Rules:

- User picks **category → provider → method**. The UI must surface unsupported methods as "Planned" without letting them be selected.
- Citadel must never ask the operator to type raw GitHub/Jira commands as "the provider" — that conflates transport with capability.
- Health is reported per method; the existing per-provider health record stays valid but should be read as "health for the active method".
- New providers/methods are added by extending `CATEGORIES` in `settings-providers.tsx` and (when wired) the corresponding `@citadel/providers` collector.

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
[ ] 2. Settings can manage providers, agents, repos, health checks, MCP, and UI preferences.
[ ] 3. Settings show missing external tools and unauthenticated providers.
[ ] 4. Settings show unhealthy provider/hook states.
[ ] 4a. GitHub provider settings show gh quota/cooldown state when available, including reset time and percent used; worktree deploys explain when automated GitHub polling is disabled.
[ ] 5. Settings can validate a repository configuration before it is used by workspace flows.
[ ] 6. Settings can export or reveal the config source for advanced users.
[ ] 7. Future API-backed providers can manage API keys through provider-specific settings.

## Settings IA (source of truth)

Settings is a single page with a left sidebar that splits configuration into discrete sections, not a giant scroll of forms. The router still exposes `/settings`; the route renders `apps/web/src/routes/settings.tsx`.

Sections:

- **Overview** — readiness counters (providers, agents, repos, MCP).
- **Providers** — see Provider Category Model above.
- **Agents** — built-in/platform agents (`claude-code`, `cursor-agent`, `pi`) plus custom agents; the built-in `shell` remains visible as Plain Terminal.
- **Repositories** — register repos, remove tracking, and deep-link to per-repo settings.
- **MCP** — local-first MCP toggle visibility plus a JSON client configuration example.
- **Advanced** — raw `StructuredConfig` editor for power users.

Hooks are edited from repository settings, because hook bindings are repo-specific. The structured-config form is intentionally retained as the escape hatch for fields the curated sections do not yet cover.

---

keywords: providers, hooks, config, settings, first run, github, jira, usage, secrets, health checks
