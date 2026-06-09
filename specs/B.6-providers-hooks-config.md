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
[ ] 10. Structured workspaces bind to at most one ticket provider. Mixed issue providers inside one structured workspace are out of scope for v1.
[ ] 11. Parent and child ticket planning content is read live from the issue provider. Citadel stores local execution bindings and prompt snapshots, not local-only work items.
[ ] 12. Provider facts used for gates include freshness timestamps and rate-limit/cooldown state. Unknown or stale PR/CI/conflict state cannot satisfy readiness.
[ ] 13. Durable provider facts include provider type, provider instance/account id, host/external URL, workspace binding id, source binding, stable external id when available, and external key/number so same issue keys or PR numbers from different providers/repos/hosts never collide.

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

## Auto-transitions

Issue-tracker providers may declare auto-transitions that fire on lifecycle events to keep tickets in sync with operator activity. The Jira provider supports this via `providers.jira.autoTransitions: Array<{ event, transition }>` in `CitadelConfig`.

- **Supported events:** `agent.started`, `workspace.issue_attached`, `workspace.archived`, `workspace.removed`. `workspace.created` is deliberately excluded (fires before any issue can be attached); `workspace.updated` is deliberately excluded (multi-fire — would burst the provider). Misconfiguration is rejected at config parse.
- **`transition` semantics:** names the **target status** the issue should end up in (e.g., `"In Progress"`, `"Done"`), not the underlying transition name. The runtime picks the available transition whose `toStatus` matches case-insensitively.
- **Idempotency:** before transitioning, the runtime reads the issue's current status. If it already equals the target status, the call is skipped and recorded as `provider.issue_transition.auto.skip` in the activity log.
- **Degradation:** auto-transition failures (provider unavailable, transition unresolved, etc.) log to `activity_events` (`provider.issue_transition.auto.unresolved` for resolution failures; `provider.issue_transition.auto` with `status: "degraded"` for transition failures) and **never block the originating operation**. The agent or workspace lifecycle the event came from still completes.
- **SSE event name:** successful auto-transitions re-emit a distinct SSE event `provider.issue_transition.auto` (not `provider.issue_transition`, which the manual transition route uses). Cockpit consumers listen for both; the operations layer must never subscribe to either to avoid feedback loops.

## Structured Ticket Bindings

[ ] 1. Structured discovery may run without a parent issue. Structured implementation cannot start until the workspace has a parent issue binding and the target checkout has exactly one child issue binding.
[ ] 2. Architect agents create/update external child tickets through provider tools. Citadel binds checkouts to those external tickets.
[ ] 3. Manager reads parent title/description/acceptance/status and child ticket title/description/acceptance/status live when preparing prompts or validating implementation gates.
[ ] 4. Ticket status transitions are best-effort manager/provider actions toward internal states such as `todo`, `in_progress`, `in_qa`, `in_review`, and `done`. Failed transitions record warnings/activity and never block code delivery.
[ ] 5. Prompt snapshots record whether provider content was unavailable or stale so downstream sessions know what context they actually received.
[ ] 6. Parent/child issue facts persist title/status/acceptance snapshots, fetched/stale timestamps, cooldown metadata, degraded reason, and source binding. Local issue bindings remain visible when the provider is unavailable.
[ ] 7. PR/check/conflict facts persist checkout-scoped PR/head/base/mergeability/check state before manager gates consume them. Last-known facts remain visible but stale/degraded facts cannot satisfy readiness.
[ ] 8. Issue transition attempts are durable history with requested internal state, current external status, selected transition, resulting status, success/failure, degraded reason, manager action id, and timestamp.

## Runtime Capability Discovery

[ ] 1. Runtime adapters expose model list, default model, supported effort values, fast mode support, context/max-context modes, freshness, and degradation reason.
[ ] 2. Runtime config supports adapter-specific argv mappings for model, effort/reasoning, fast mode, and context mode.
[ ] 3. If live probing is unavailable, static fallback capabilities/defaults are used with freshness warnings.

## Provider Setup

[ ] 1. First-run config shows available provider types.
[ ] 2. Provider setup shows required external tools.
[ ] 3. Provider setup validates binary availability.
[ ] 4. Provider setup validates auth/health.
[ ] 5. Provider setup records enabled/disabled state.
[ ] 6. Provider setup explains which product surfaces the provider powers.

## Hooks

[~] 1. Hooks are the extension path for repo-specific behavior, configured either in citadel config (`config.hooks`) or as executable files tracked in the repo under `.citadel/hooks/<name>` for deploy-style hooks, or under `.citadel/hooks/<event>/<name>.{sh,agent,prompt}` for structured event hooks.
[ ] 2. Setup hooks are configured per repo.
[~] 3. Teardown hooks can be configured per repo (`repo.teardownHookIds`) and/or shipped as an executable `.citadel/hooks/teardown`; when both are present, the file hook runs first, then the configured hooks (this is dual execution, not dual-discovery-with-fallback as deploy uses).
[~] 4. App/link discovery hooks are configured per repo; `.citadel/hooks/deploy` lists and redeploys apps, while optional `.citadel/hooks/undeploy` stops a named app or all apps.
[ ] 5. Action hooks are configured per repo.
[ ] 6. Hooks receive structured workspace/repo/provider context — payload shape is event-specific and validated before dispatch.
[ ] 7. Hooks return structured JSON.
[ ] 8. Hook output is validated before it appears in the UI.
[ ] 9. Hook execution has explicit cwd/env policy, timeout, output bounds, and logs. For `.agent` / `.prompt` hooks, the unit of execution is an agent session launch — the framework awaits session creation (including initial prompt delivery) but does not block on subsequent session output.
[ ] 10. Hook diagnostics show configured hooks, last run, validation status, sample output shape, and errors.
[ ] 11. Hooks may be implemented as agent prompts (`.agent` or `.prompt` files). Agent hooks spawn a fresh isolated agent session in the workspace with the file body as the seed prompt; the session runs to completion independently and logs its own activity. Agent-prompt hooks are not allowed under `agent.started/` to prevent infinite session-spawn loops.

## Config And Settings

[ ] 1. Citadel has a first-run config/init surface.
[ ] 2. Settings can manage providers, agents, repos, health checks, MCP, and UI preferences.
[ ] 3. Settings show missing external tools and unauthenticated providers.
[ ] 4. Settings show unhealthy provider/hook states.
[ ] 4a. GitHub provider settings show gh quota/cooldown state when available, including reset time and percent used; worktree deploys explain when automated GitHub polling is disabled.
[ ] 5. Settings can validate a repository configuration before it is used by workspace flows. *Diagnosis is delivered via `make doctor` and `GET /api/doctor` (see Verification below); gating of workspace flows on a failing doctor report is a deferred follow-up.*
[ ] 6. Settings can export or reveal the config source for advanced users.
[ ] 7. Future API-backed providers can manage API keys through provider-specific settings.
[ ] 8. Agent settings include one global base system prompt that applies across all agent runtimes. It is used alone for freestyle sessions and prepended to specialized role prompts.

## Verification

[ ] 1. Citadel ships a programmatic "is everything configured?" check reachable from the shell (`make doctor`) and from the cockpit (Settings → Diagnostics).
[ ] 2. The doctor report is a versioned, machine-readable JSON contract (`DoctorReport.version: 1`) defined in `@citadel/contracts`. Forward-compat clients render an explicit "report version unknown" banner on mismatch.
[ ] 3. The doctor classifies each check as `ok` / `warn` / `fail` / `skipped` and surfaces a top-line summary `ok` / `degraded` / `failing` (precedence: any fail → failing; else any warn → degraded; else ok; skipped does not contribute).
[ ] 4. Check kinds: `binary`, `config`, `service`, `daemon`, `database`, `repo-hooks`, `provider`, `agent-runtime`, `terminal`.
[ ] 5. The binary check distinguishes required (missing → fail) from recommended (missing → warn).
[ ] 6. The provider check distinguishes **unconfigured** (binary missing, provider disabled, or auth absent → `warn` with hint "provider unconfigured — features X disabled") from **configured-but-unreachable** (`fail`) and **healthy** (`ok`).
[ ] 7. The per-repo check warns when a registered repo has no hooks bound *and* no executable `.citadel/hooks/deploy` file, with a hint pointing at the cockpit's "Scaffold with AI" affordance on `/settings/repos/<id>`.
[ ] 8. The daemon-reachability probe retries (5 × 1s) before declaring failure, so an async `systemctl restart` does not surface as a false positive during install/upgrade flows.
[ ] 9. The doctor surfaces an inverse TLS warning: when `bindHost` is non-loopback (anything other than `127.0.0.1` / `::1` / `localhost`) AND `config.tls` is absent, the operator is warned. Loopback + TLS (the normal mkcert pattern) does *not* warn.
[ ] 10. The doctor reports the daemon's protocol (`http` / `https`) and the resolved bind URL.
[ ] 11. Agent runtime checks warn for each missing configured agent runtime command. The report fails only when zero configured agent runtimes are executable.
[ ] 12. The terminal profile command is required. A missing terminal command is a `fail` because terminal tabs and shell-first agent launches depend on it.

## Settings IA (source of truth)

Settings is a single page with a left sidebar that splits configuration into discrete sections, not a giant scroll of forms. The router still exposes `/settings`; the route renders `apps/web/src/routes/settings.tsx`.

Sections:

- **Overview** — readiness counters (providers, agents, terminal, repos, MCP).
- **Providers** — see Provider Category Model above.
- **Agents** — one global base system prompt, runtime health/capabilities, and the five predefined role/action templates. Custom agent CRUD is not exposed in v1.
- **Terminal** — the singular terminal profile from `config.terminal`; plain shell is configured here, not as an agent runtime.
- **Repositories** — register repos, remove tracking, and deep-link to per-repo settings.
- **MCP** — local-first MCP toggle visibility plus a JSON client configuration example.
- **Advanced** — raw `StructuredConfig` editor for power users.

Hooks are edited from repository settings, because hook bindings are repo-specific. The structured-config form is intentionally retained as the escape hatch for fields the curated sections do not yet cover.

---

keywords: providers, hooks, config, settings, first run, github, jira, usage, secrets, health checks
