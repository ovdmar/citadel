Activate the /implement-task skill first.

# Plan: Agents System — runtimes, configs, MCP launchers, handoff

## Acceptance Criteria

Sourced from scratchpad block `00000012-0012-4012-8012-000000000012`, scope confirmed with the user as "D — everything including plan handoff".

- [ ] A new "Agents" entry appears in the cockpit's left navigation, positioned immediately above the existing "History" entry.
- [ ] The Agents view lists four predefined agents (`implementation`, `prototype`, `pm`, `architect`) and any user-defined custom agents.
- [ ] Each agent definition exposes three editable fields: system prompt (multiline), runtime (selector populated from `list_runtimes`), and model (selector populated from the chosen runtime's model list).
- [ ] Predefined agents cannot be deleted but ARE editable; each has a "Reset to citadel defaults" affordance that overwrites only that one definition with its seeded value.
- [ ] Custom agents support full CRUD (create, read, edit, delete) and are persisted across daemon restarts.
- [ ] Six new MCP tools are registered and callable by remote agents: `launch_implementation_agent`, `launch_prototype_agent`, `launch_pm_agent`, `launch_architect_agent`, `list_custom_agents`, `launch_custom_agent`. Each `launch_*` tool accepts an optional `workspace` field; when omitted, a new workspace is created (matching the existing `launch_agent` behavior).
- [ ] When a `launch_*_agent` tool fires, the named agent's system prompt is prepended to the user-supplied prompt before the prompt is submitted to the runtime — uniformly across all runtimes (no runtime-specific `--system-prompt` flags).
- [ ] Per-runtime adapters expose a `listModels()` function returning the model identifiers the runtime can launch with; the cockpit's model selector calls this via a `/api/runtimes/:id/models` daemon endpoint. The claude-code adapter scrapes the interactive `/models` TUI via the existing `tmux-pty.ts` capture pattern when no flag is available. If a probe fails, the adapter returns a hardcoded conservative fallback list AND the API response includes a `probeError` field so the UI can surface it.
- [ ] A new global setting "Default agent runtime" is persisted (used as the default when an agent is created without an explicit runtime). The setting is exposed as a single row in existing Settings — no rich UI for this knob.
- [ ] An MCP `register_plan({workspaceId, path, summary?})` tool stores a plan registration record (workspaceId, absolute path inside the workspace, optional summary, registeredAt). Registrations persist across daemon restarts.
- [ ] An MCP `launch_handoff_agent({workspaceId, planId?, predefinedKind?, customAgentId?, additionalPrompt?})` tool reads the registered plan (or, if `planId` is omitted, the newest registered plan for that workspace; or, if no registration exists, the newest `*.md` under `<workspacePath>/.agents/plans/`), prepends the plan's content to the agent's system prompt, and launches the named agent in the SAME workspace. Exactly one of `predefinedKind` (enum: `implementation`|`prototype`|`pm`|`architect`) or `customAgentId` MUST be supplied — typos cannot silently fall through to a 404'd custom-agent lookup.
- [ ] Predefined agent system prompts are seeded with citadel-authored text that cites the semantics of the corresponding skills (architect → planning, implementation → TDD execution, pm → scoping, prototype → fast UI iteration) but does NOT embed the full skill text.
- [ ] All four predefined agents survive a "delete attempt" path with a clear error (`predefined_agent_cannot_be_deleted`).
- [ ] All persistence respects the user-level scope: `~/.citadel/agents/<id>.json` for definitions, `~/.citadel/agents.config.json` for global settings (default runtime). Plan registrations live in the daemon's SQLite DB (worktree-relative `.citadel/data/`, matching existing daemon convention) because they are workspace-scoped, not user-global. **Cross-daemon coordination:** the systemd long-term daemon and any worktree `make deploy` daemons share the same `~/.citadel/agents/` directory. The storage layer therefore (a) re-reads from disk on every API call (no in-memory cache that can desync), (b) writes one file per definition (no shared-file races), and (c) computes a content hash before writing during seed() — only writes the seed if the file is missing or its content has drifted from a known-good citadel default (idempotent-by-content).
- [ ] "Reset to citadel defaults" uses the citadel-authored seed values, NOT the user's current `defaultRuntime` setting (so reset is deterministic regardless of user config).

## Context and problem statement

Citadel today supports launching agents in workspaces via a single MCP tool, `launch_agent`, which takes a free-form `prompt` plus a `runtimeId`. There is no concept of a **reusable agent definition** — every caller assembles its own prompt and runtime choice from scratch, and the predefined SDLC personas (the implementation/architect/pm/prototype roles that mirror the existing `.agents/skills` family) live only as ad-hoc human conventions.

This plan adds a first-class **Agent definition** (system prompt + runtime + model) that is:

1. **Configurable** via a new "Agents" cockpit nav entry and editor.
2. **Reusable** via six new MCP launchers (four predefined + two custom).
3. **Composable** via a plan-handoff mechanism: an agent that produces a plan can register it; another agent can be launched in the same workspace and primed with that plan's content.

The change touches four layers — contracts, MCP surface, daemon HTTP/state, and the web cockpit — but is additive only: the existing `launch_agent` MCP tool is untouched and the new launchers compose on top of it.

The motivating product trajectory: tonight's user is launching 10 parallel agents on 10 scratchpad topics. The pattern is repeatable but currently requires a human to know the right system prompt and runtime per topic. Predefined named agents close that gap; plan-handoff closes the next gap (architect → implementation) by automating the most common SDLC chain inside the cockpit.

## Spec alignment

Per the review-pr extension's spec mappings, this change is **cross-cutting**:

| Touched area | Spec |
|---|---|
| `packages/contracts/**` (new schemas) | `specs/A-shared-definitions.md` |
| `packages/mcp/**`, `apps/daemon/src/operations/**` (new MCP tools) | `specs/B.7-operations-activity-mcp.md` |
| `apps/web/**`, `packages/ui/**` (new nav entry + editor) | `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md` |
| `apps/daemon/src/agents/**` (composing on top of `operations.launchAgent`) | `specs/B.3-agent-sessions-terminal.md` |
| `packages/db/**` (plan_registrations table) | `specs/A-shared-definitions.md` |
| `packages/runtimes/**` (new `models/` adapter directory) | `specs/B.6-providers-hooks-config.md` |

**Reviewed each spec for required updates:**

- `specs/A-shared-definitions.md` — needs a new "Agent definition" entry in the glossary and the schema list (alongside the existing Repository/Workspace/Agent session entries). Defines the difference between an "Agent definition" (a reusable template) and an "Agent session" (a running instance — already defined).
- `specs/B.7-operations-activity-mcp.md` — needs an "Agent launchers" subsection enumerating the six new MCP tools, their inputs/outputs, and the snapshot-vs-daemon dispatch path. Also documents `register_plan` and `launch_handoff_agent`.
- `specs/B.2-ade-cockpit.md` — needs an "Agents nav" subsection placing the entry above History and describing the master/detail editor layout.
- `specs/B.6-providers-hooks-config.md` — needs a "Runtime model discovery" subsection documenting `listModels()` adapters and the claude-code TUI scrape.
- `specs/B.3-agent-sessions-terminal.md` — needs a note clarifying that the new launchers compose on top of `operations.launchAgent` (system prompt is prepended to the user prompt; runtime invocation is unchanged).

**Step 1 of the implementation MUST be updating these specs before any code.**

## Implementation approach

The chosen approach treats agent definitions as **user-global config** distinct from daemon runtime state. Definitions live in `~/.citadel/agents/<id>.json` (one file per definition); the daemon reads them on every API call (cheap; cached for the request lifetime). Plan registrations, by contrast, are **workspace-scoped state** and live in the daemon's SQLite DB.

Six layers, in dependency order:

1. **Contracts.** Add `AgentDefinitionSchema`, `AgentDefinitionStorageSchema` (the on-disk form with `kind: "predefined" | "custom"` and a `definitionId`), `LaunchPredefinedAgentInputSchema` (used by all four `launch_*_agent` tools — same shape), `LaunchCustomAgentInputSchema`, `RegisterPlanInputSchema`, `LaunchHandoffAgentInputSchema`, `PlanRegistrationSchema`, `RuntimeModelDescriptorSchema`.
2. **DB.** Add a `plan_registrations` table (additive migration version 8) keyed by `(workspaceId, id)` with `path`, `summary`, `registeredAt`, `registeredBySessionId`.
3. **Runtimes.** Add `packages/runtimes/src/models/` mirroring the `usage/` adapter pattern. `runtimeModelListers` record with adapters for `claude-code`, `codex`, `cursor-agent`, `pi`. The `claude-code` adapter uses the existing `tmux-pty.ts` capture utilities to scrape `/models`. Each adapter returns `{ models, probeError? }` so the caller can surface partial failure.
4. **Daemon.**
   - Add a small `agentDefinitions` service in `apps/daemon/src/agent-definitions/` that reads/writes `~/.citadel/agents/` and seeds predefined definitions on first read.
   - Add HTTP routes: `GET/POST/PATCH/DELETE /api/agents`, `POST /api/agents/:id/reset` (predefined only), `GET /api/runtimes/:id/models`, `GET/PUT /api/agents/config` (for default runtime).
   - In `daemon-mcp-tool.ts`, dispatch the six new launch tools and the two plan tools. Each launch tool:
     1. Loads the named agent definition from disk (predefined launchers use a fixed id; `launch_custom_agent` takes an `agentId`).
     2. Composes `effectivePrompt = agent.systemPrompt + "\n\n---\n\n" + userPrompt`.
     3. Resolves the workspace: if `workspace` provided, look it up; if absent, create a new one (delegating to the existing `operations.launchAgent` create-workspace path).
     4. Calls `operations.launchAgent({ runtimeId: agent.runtime, prompt: effectivePrompt, ... })`.
   - `register_plan` inserts a row; `launch_handoff_agent` resolves the plan (registered first, filename fallback second) and then routes through the same launch path with the plan body prepended.
5. **MCP layer.** In `packages/mcp/src/index.ts`, register the eight new tool definitions and add snapshot dispatch:
   - `list_custom_agents` is read-only and CAN execute in the snapshot path (it reads `~/.citadel/agents/` directly).
   - The seven mutating tools follow the existing pattern of returning `{ error: "mutating_tool_requires_daemon" }` in the snapshot path; the daemon implements them in `daemon-mcp-tool.ts`.
6. **Web cockpit.**
   - Add a nav `<Link to="/agents">` immediately above the History link in `apps/web/src/navigator.tsx`.
   - Add `apps/web/src/routes/agents.tsx` (a new file — TanStack Router auto-mounts) with a master/detail layout mirroring `settings-scheduled-agents.tsx`: left rail lists all definitions; right pane is the editor.
   - Add a `RuntimeModelSelector` component that calls `/api/runtimes/:id/models` and shows a probe-failure banner when present.
   - Add a "Default agent runtime" row in the existing Settings panel (in `apps/web/src/settings-runtimes.tsx` or its sibling — the row reads/writes `/api/agents/config`).

Test strategy is two-layered per the citadel extension: Vitest for everything that can be unit-tested (schemas, the agent-definitions service, the MCP dispatcher, the model-list adapters with mocked tmux IO); a small Playwright happy-path for the new nav entry and editor save.

## Alternatives considered

1. **Per-repo storage (`<repo>/.citadel/agents/`).** Lets teams share agent definitions via git, parallel to how hooks work. **Rejected**: the user explicitly chose global at decision time; predefined agents would also need a global fallback when no repo-level file exists, doubling the lookup path. Revisit if multi-user team use emerges.

2. **Runtime-specific system-prompt flags (e.g. `claude-code --append-system-prompt`).** Best fidelity for claude-code (the system prompt would not appear in the chat history). **Rejected**: only one of the four runtimes supports such a flag today; the resulting two-code-path divergence ("flag" vs "prepend") is more maintenance than it's worth for v1. Reconsidered later if user feedback shows the system prompt appearing in the transcript is a UX issue.

3. **Hardcoded model list per runtime in code.** Simpler than CLI probing; no flakiness. **Rejected**: user picked probe-based discovery explicitly so the model list stays current as runtimes ship new models. The hardcoded list still appears in the adapter as the fallback when probing fails — best of both as a degraded mode.

4. **Filename convention only for handoff (no DB).** Smallest surface; no schema migration; the daemon just scans `<workspacePath>/plans/` and picks the newest. **Rejected**: user picked both ("register MCP + filename fallback"). Registration gives the producing agent explicit control over which plan is the current one when multiple exist.

5. **Implement only the schema + 4 predefined launchers in this PR; defer the nav UI, custom agents, and handoff to follow-ups (slice A from the grilling).** Genuinely safer in a 10-parallel-agent environment. **Rejected by the user.** Carrying this as a follow-up signal: if implementation discovers a sharp file-overlap conflict with another in-flight branch, fall back to slice A and land the rest as follow-ups.

6. **Collapse the six predefined launchers into one `launch_predefined_agent({ kind })` tool.** Smaller MCP surface. **Rejected**: user's AC explicitly enumerates the six tool names — that's the contract callers were told they'd see, and renaming them later is more breaking than fewer tools is helpful.

## Implementation steps

### 1. Specs update (FIRST — before any code)

- Add an "Agent definition" entry to `specs/A-shared-definitions.md` (after the existing "Agent session" entry). Distinguish: an Agent definition is a reusable template (system prompt + runtime + model); an Agent session is a running instance.
- Add an "Agent launchers" subsection to `specs/B.7-operations-activity-mcp.md` enumerating the six new MCP tools, their inputs/outputs, and the snapshot vs daemon dispatch path. Add a separate "Plan handoff" subsection covering `register_plan` and `launch_handoff_agent`, including the registration-first / filename-fallback resolution order.
- Add an "Agents nav" subsection to `specs/B.2-ade-cockpit.md` placing the entry above History and describing the master/detail editor layout, the predefined vs custom distinction, and the "reset to defaults" affordance.
- Add a "Runtime model discovery" subsection to `specs/B.6-providers-hooks-config.md` covering `listModels()` adapters, the claude-code TUI scrape, and the `probeError` fallback path.
- Add one paragraph to `specs/B.3-agent-sessions-terminal.md` clarifying that new launchers compose on top of `operations.launchAgent`: the system prompt is prepended to the user prompt at launch time, runtime invocation is otherwise unchanged.

### 2. Contracts

In `packages/contracts/src/index.ts`, just before `DiffFileSchema` (line ~694):

- `AgentDefinitionKindSchema = z.enum(["predefined", "custom"])`
- `AgentDefinitionIdSchema = IdSchema` (reuse the existing constraint)
- `AgentDefinitionSchema` — `{ id, kind, name, systemPrompt, runtime, model?, createdAt, updatedAt }`. `model` is optional because users may not have picked one yet.
- `CreateAgentDefinitionInputSchema` — `{ name, systemPrompt, runtime, model? }` (kind is always "custom" on create; "predefined" definitions are seeded by the daemon, not user-created).
- `UpdateAgentDefinitionInputSchema` — partial of the same fields plus the id; rejects changes to `kind`.
- `LaunchPredefinedAgentInputSchema` — `{ prompt, workspaceId? OR (repoId? AND repoName?), namespaceId?, displayName?, branchName?, workspaceName? }`. Used identically by all four `launch_*_agent` tools — they only differ by the hardcoded definition id they load.
- `LaunchCustomAgentInputSchema` — same as above plus required `agentId`.
- `RegisterPlanInputSchema` — `{ workspaceId, path, summary? }`.
- `PlanRegistrationSchema` — `{ id, workspaceId, path, summary?, registeredAt, registeredBySessionId? }`.
- `LaunchHandoffAgentInputSchema` — `{ workspaceId, planId?, predefinedKind?: "implementation" | "prototype" | "pm" | "architect", customAgentId?: AgentDefinitionId, additionalPrompt? }`. Validated via `.refine(...)` so that exactly one of `predefinedKind` or `customAgentId` is supplied — a typo cannot silently fall through to a non-existent custom agent.
- `RuntimeModelDescriptorSchema` — `{ id, displayName?, isDefault? }`.
- `RuntimeModelsResponseSchema` — `{ models: RuntimeModelDescriptor[], probeError?: string }`.
- `AgentsConfigSchema` — `{ defaultRuntime: string }`.

Export every schema and its inferred type. Add a small set of `.parse()`-based round-trip tests in `packages/contracts/src/index.test.ts`.

### 3. Database (migration version 8)

In `packages/db/src/migrate.ts`:

**Migration strategy:**

| Operation | Classification | Reversibility | Notes |
|---|---|---|---|
| `CREATE TABLE IF NOT EXISTS plan_registrations (...)` | **Additive** | Yes (drop table) | New table; safe on every existing install. |
| `CREATE INDEX IF NOT EXISTS idx_plan_registrations_workspace ON plan_registrations(workspace_id)` | **Additive** | Yes | Indexes are rebuildable. |
| `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (8, 'plan-registrations', datetime('now'))` | **Migration record** | N/A | Version 8 (current max is 7 per `packages/db/src/migrate.ts:195-201`). |

Schema:
```sql
CREATE TABLE IF NOT EXISTS plan_registrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,                  -- stored as fs.realpathSync(input) at registration time
  summary TEXT,
  registered_at TEXT NOT NULL,
  registered_by_session_id TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_registrations_workspace ON plan_registrations(workspace_id);
```

`PRAGMA foreign_keys = ON` is preserved (not touched). Local-first impact: every existing install gets the new table on next startup; existing data is untouched (no row writes during migration).

**Migration version drift mitigation (parallel branches).** Several other in-flight branches tonight may also introduce a v8. The implementer MUST rebase on `main` immediately before merge; if `main` now contains a v8, bump THIS PR's migration to the next available version (v9 or higher) and update the assertion in `packages/db/src/index.test.ts` (`schema_migrations` version list). `INSERT OR IGNORE` already prevents row collisions, but the schema work itself may diverge silently if two v8s exist on different branches.

Add store methods in `packages/db/src/index.ts`:
- `insertPlanRegistration(row)`, `listPlanRegistrationsForWorkspace(workspaceId)`, `deletePlanRegistration(id)`.

### 4. Runtime model adapters

Add `packages/runtimes/src/models/` directory mirroring `usage/`:

- `models/index.ts` — exports `runtimeModelListers: Record<string, RuntimeModelLister>` (claude-code, codex, cursor-agent, pi) and a `hasRuntimeModelLister(id)` helper. `RuntimeModelLister = (input: { command: string; args?: string[] }) => Promise<{ models: RuntimeModelDescriptor[]; probeError?: string }>`.
- `models/claude-code.ts` — uses the existing `tmux-pty.ts` capture pattern to spawn the runtime, send `/models`, capture the pane, parse the list. Falls back to `["claude-sonnet-4-6", "claude-opus-4-7", "claude-haiku-4-5"]` with a `probeError` on any failure. **Cleanup hardening:** the tmux session MUST be killed in a `try { ... } finally { killSession() }` regardless of parse success/failure/timeout, per the existing ttyd cleanup-storm lessons. The probe wraps in a hard 5s timeout; on timeout the finally block still runs. **Fixture-first parser:** before writing the parser, capture a real `/models` output by running `tmux-pty.ts` once interactively and check the captured bytes into `packages/runtimes/src/models/fixtures/claude-code-models.txt`; the parser test asserts on that fixture, not a guessed format.
- `models/codex.ts` — codex CLI does not expose model selection (per `mcp__citadel__list_runtimes` capabilities); return the hardcoded list `["gpt-5.5"]` (or whatever the current codex default is) with no `probeError`.
- `models/cursor-agent.ts`, `models/pi.ts` — minimal fallbacks; each runtime currently shows `supportsModelSelection: false`. Return a single "default" entry so the UI never shows an empty list.

Unit tests mock the tmux IO surface (the test harness can already do this — see existing `packages/runtimes/src/usage/*.test.ts`).

### 5. Daemon — agent-definitions service

Add `apps/daemon/src/agent-definitions/` directory:

- `agent-definitions/storage.ts` — reads/writes `~/.citadel/agents/` (uses `os.homedir()` + `path.join`); creates the directory on first call; seeds the four predefined definitions if absent. Exposes:
  - `list(): AgentDefinition[]` (predefined + custom). Re-reads from disk on EVERY call — no in-memory cache, so cross-daemon edits propagate immediately.
  - `get(id): AgentDefinition | undefined`
  - `create(input): AgentDefinition` (custom only; predefined ids reserved)
  - `update(id, patch): AgentDefinition` (works for both kinds; rejects `kind` changes)
  - `remove(id): void` (throws on predefined)
  - `resetToDefaults(id): AgentDefinition` (predefined only; uses citadel-authored seed, NOT user defaultRuntime)
  - `readConfig(): AgentsConfig`, `writeConfig(patch): AgentsConfig`

**Cross-daemon coordination:** the systemd long-term daemon at `:4010` AND any worktree `make deploy` daemon (4110–4209) share this directory. Mitigations:
1. Every `list()` re-reads from disk (no stale cache).
2. Writes are file-per-id; atomic via `fs.writeFile(<file>, content)` (no shared write target).
3. `seed()` computes a content hash for each missing predefined file BEFORE writing; if the file is missing it writes the seed; if the file exists it leaves it alone (idempotent). This avoids two daemons racing to seed the same dir at first run.
4. **Boot-safe.** If `~/.citadel/agents/` is unreadable (EACCES, ENOENT on a parent, broken symlink, file-where-dir-should-be), the storage layer logs loudly and the daemon STILL boots; subsequent calls to `list()/get()/create()` return a structured error that the HTTP layer maps to 503. The daemon MUST NOT crashloop on a broken storage state (otherwise systemd's `Restart=always` will spin endlessly).
- `agent-definitions/seed.ts` — the four citadel-authored predefined system prompts. Each is ~10–20 lines, cites its skill semantics, and explicitly does NOT embed the skill text:
  - `implementation` — references TDD execution semantics from `/implement-task`.
  - `architect` — references planning semantics from `/do-tech-plan`.
  - `pm` — references scoping/requirements gathering.
  - `prototype` — references fast UI iteration (no tests, no migrations, single-shot prompts).

Why per-file (vs single JSON file): atomic writes per definition are simpler; "reset to defaults" overwrites a single file deterministically; concurrent editor sessions don't race on a shared file.

### 6. Daemon — HTTP routes (NEW FILE — extracted, NOT appended to `app.ts`)

**File-size gate:** `apps/daemon/src/app.ts` is currently 804 lines (verified) — already at the 800-LoC limit. Adding seven new routes inline would push it well over. The established pattern in the daemon for new endpoint families is a sibling `*-routes.ts` module — verified by inspection: `agent-session-routes.ts`, `namespace-routes.ts`, `scheduled-agent-routes.ts`, `scratchpad-routes.ts`, `runtime-usage-routes.ts`, `terminal-routes.ts`, `workspace-diff-routes.ts`, `mcp-routes.ts`, `extra-routes.ts` all follow this shape.

Create `apps/daemon/src/agents-routes.ts` exporting `registerAgentsRoutes({ app, asyncRoute, agentDefinitions, runtimeModelListers, store })`. In `app.ts`, add ONE call to `registerAgentsRoutes(...)` near the existing route-registration block (around line 706) — a single-line addition that won't push `app.ts` over the limit.

Endpoints in `agents-routes.ts`:

- `GET /api/agents` → returns `{ definitions: AgentDefinition[], config: AgentsConfig }`. Returns `503 { error: "agent_storage_unavailable" }` if the storage layer reports a boot-failure state.
- `POST /api/agents` → body `CreateAgentDefinitionInputSchema`; returns created definition.
- `PATCH /api/agents/:id` → body `UpdateAgentDefinitionInputSchema`; returns updated definition.
- `DELETE /api/agents/:id` → 409 `{ error: "predefined_agent_cannot_be_deleted" }` if predefined; else removes.
- `POST /api/agents/:id/reset` → 400 if not predefined; else overwrites with seed.
- `GET /api/agents/config` / `PUT /api/agents/config` → reads/writes `~/.citadel/agents.config.json`.
- `GET /api/runtimes/:id/models` → calls `runtimeModelListers[id]` and returns `RuntimeModelsResponseSchema`. **Cache policy:** results cached per `(runtimeId)` for **1 hour TTL**, NOT daemon-lifetime (claude-code/codex CLI upgrades happen out-of-band and a stale cache produces "unknown model" errors at launch time). `?refresh=1` forces a re-probe. UI also surfaces a small explicit "Refresh models" affordance next to the selector.

All endpoints invalidate `["state"]` on the client side via standard react-query patterns when called from the cockpit.

**Boot safety.** `registerAgentsRoutes` MUST NOT throw at registration time even if `~/.citadel/agents/` is unreadable. Storage failures surface as 503 responses, never as daemon crash. Regression test: load the daemon's HTTP app in vitest with the home dir pointed at a read-only directory and assert the app boots and `GET /api/agents` returns 503.

### 7. Daemon — MCP dispatch

Extend `apps/daemon/src/daemon-mcp-tool.ts` `callDaemonMcpTool` switch with EIGHT new cases (`list_custom_agents` runs ONLY in the daemon path — see §8 below for why).

**Pre-step: verify and unify the launch seam.** The plan currently mentions two downstream operations entry points (`operations.startAgentSession` for an existing-workspace launch, `operations.launchAgent` for a create-and-launch). Before implementing the launchers, read `packages/operations/src/index.ts` (and the corresponding daemon-side caller) to verify that BOTH entry points thread a `prompt` argument through to the same tmux submit path. If they diverge (e.g. one expects the caller to submit the prompt via a separate `submitPrompt` call), introduce a single helper in `packages/operations/src/index.ts` named `composeAndLaunchAgent({ store, deps, workspaceId?, runtimeId, prompt })` that normalizes the two paths so BOTH MCP launchers go through one seam. Tests on the seam are the canary against "system prompt silently dropped".

- `launch_implementation_agent` / `launch_prototype_agent` / `launch_pm_agent` / `launch_architect_agent` — each calls a shared helper `launchPredefinedAgent(deps, definitionId, input)` that:
  1. Loads the definition via `agentDefinitions.get(definitionId)`. Returns `{ error: "agent_storage_unavailable" }` if storage is in a boot-failure state.
  2. Resolves the runtime + model (uses agent's `model` if set; else lets `operations.launchAgent` use its default; if agent has no `runtime`, fall back to `agentsConfig.defaultRuntime`).
  3. Composes `effectivePrompt = "## System\n" + definition.systemPrompt + "\n\n## User prompt\n" + input.prompt`.
  4. Routes through the unified `composeAndLaunchAgent` seam (see pre-step) — no per-path branching in the launcher itself.
  5. Returns `{ workspaceId, sessionId, branchName, workspacePath, operationId }` (same shape as `launch_agent`).
- `list_custom_agents` — returns `{ agents: AgentDefinition[] }` filtered to `kind === "custom"`. Daemon-only (see §8).
- `launch_custom_agent` — same as predefined helper but takes `input.agentId` and reads the matching custom definition; 404 if not found OR if the id is predefined (caller should use `launch_*_agent` for those).
- `register_plan` — security-hardened path validation:
  1. `inputPath = path.resolve(workspacePath, input.path)` — produce an absolute path.
  2. `realPath = await fs.promises.realpath(inputPath)` — resolves symlinks. Wrap in try/catch — ENOENT or EACCES becomes `{ error: "plan_path_unreadable" }`.
  3. `workspaceReal = await fs.promises.realpath(workspacePath)`.
  4. Reject (`{ error: "plan_path_escapes_workspace" }`) if `!realPath.startsWith(workspaceReal + path.sep)` — note `path.sep`, NOT just the prefix string, to avoid `/work/ws` matching `/work/ws-evil/...`.
  5. Stat the file: reject if not a regular file (`stat.isFile()`) or larger than **1 MiB** (`stat.size > 1_048_576`) — `{ error: "plan_file_too_large" }`.
  6. INSERT the row, storing `realPath` (not the original input) in the `path` column so a post-registration symlink swap can't change the target.
  Returns `{ planId, registeredAt }`.
- `launch_handoff_agent` — input validated via `LaunchHandoffAgentInputSchema` (one-of: `predefinedKind` OR `customAgentId`). Resolves the plan:
  1. If `input.planId` set: load by id; reject if its `workspaceId` doesn't match `input.workspaceId`.
  2. Else: pick the newest `plan_registrations` row for the workspace.
  3. Else: scan `<workspacePath>/.agents/plans/*.md` and pick newest by mtime. (**Note:** `.agents/plans/`, NOT `plans/` — verified against the citadel repo convention: this very plan file lives at `.agents/plans/agents-system.md`.)
  4. Else: return `{ error: "no_plan_found" }`.
  Re-validates the stored `path` via realpath + workspace-prefix check AT READ TIME (defense-in-depth against post-registration symlink swap). Reads the plan file (still enforcing the 1 MiB cap), prepends content to the agent's system prompt under a `## Plan to implement` header, and routes through the same `composeAndLaunchAgent` seam.

### 8. MCP layer (snapshot path)

In `packages/mcp/src/index.ts`:

- Add the eight tool names to the `McpToolName` union.
- Add the eight `McpToolDefinition` entries (name, description, inputSchema, `destructive: false` for all eight — we don't expose any destructive agent-definition op via MCP in this PR; the cockpit handles delete/reset).
- In `callMcpTool` (snapshot dispatch):
  - **All eight tools — including `list_custom_agents` — return `{ error: "agent_launcher_requires_daemon" }`.** The earlier revision's idea of running `list_custom_agents` in the snapshot path was wrong: `McpToolContext` (file:line in `packages/mcp/src/index.ts` ~73–84) is pure in-memory snapshots — it has no fs access, no `agentDefinitions` reference, and no `os.homedir()` setup. Forcing fs access into the snapshot path also breaks the "snapshot may run remote-of-daemon" invariant. The pattern matches the existing scratchpad family (`packages/mcp/src/index.ts` ~682-683): "the scratchpad lives on disk under the daemon's data dir; the snapshot path has no fs access, so route through the daemon explicitly."
  - Use a new, family-specific sentinel `agent_launcher_requires_daemon` (matching the existing per-family pattern: `scratchpad_tool_requires_daemon`, `session_tool_requires_daemon`, `scheduled_agent_run_tool_requires_daemon`) — NOT the generic `mutating_tool_requires_daemon`.
- Extend `mcpToolDefinitions()` exports so `pnpm check` round-trips them in tests.

### 9. Web cockpit — Agents nav entry

In `apps/web/src/navigator.tsx`, immediately above the existing History `<Link>` (line 228):

```tsx
<Link to="/agents" className={path === "/agents" ? "active" : ""} title="Manage agent definitions">
  <Bot size={13} /> <span>Agents</span>
</Link>
```

Pick an unused lucide-react icon (e.g. `Bot` or `UserCog`). Verify no other nav entry already uses it.

### 10. Web cockpit — Agents route + editor (THREE files, file-size pre-commit)

**Pre-commit to file split** so the 800-LoC gate doesn't get hit by the editor + form + selector being one file:

1. `apps/web/src/routes/agents.tsx` (route + master/detail layout; target ≤200 LoC).
   - Top-level `<AgentsView />` with `useQuery({ queryKey: ["agents"], queryFn: ... })` against `/api/agents`.
   - Left rail: predefined section, then custom section, with a "+ New custom agent" button.
   - Right pane: renders `<AgentsEditor agent={selected} />`.

2. `apps/web/src/agents-editor.tsx` (editor form + mutations; target ≤300 LoC).
   - Form fields: `name` (read-only for predefined), `systemPrompt` (textarea, monospace), `runtime` selector (from `/api/state`'s `runtimes`), `model` selector (`<RuntimeModelSelector>`).
   - Buttons: `Save` (both kinds), `Reset to citadel defaults` (predefined only), `Delete` (custom only — confirm dialog).
   - Mutations: `useMutation` per action; invalidates `["agents"]` and `["state"]` on success.
   - Errors render in a small banner above the form (e.g. `predefined_agent_cannot_be_deleted`, `name_collides`, `agent_storage_unavailable`).

3. `apps/web/src/components/runtime-model-selector.tsx` (target ≤150 LoC).
   - Props: `{ runtime: string, value?: string, onChange(model: string): void }`.
   - Calls `useQuery({ queryKey: ["runtime-models", runtime] })`.
   - Shows a `probeError` banner if returned; still renders the fallback list so the user can save.
   - **Renders a small "↻ Refresh" button** next to the selector that triggers a re-query against `/api/runtimes/:id/models?refresh=1` (matches the daemon's TTL invalidation knob).

### 11. Web cockpit — default-runtime Settings row

In `apps/web/src/settings-runtimes.tsx`, add a single labeled row near the top:

- Label: "Default agent runtime".
- Selector: same list of healthy runtimes already shown elsewhere on the page.
- Save: PUTs `/api/agents/config` with `{ defaultRuntime }`.
- Used by: the `/api/agents` create path defaults `runtime` to this when the user doesn't pick one in the editor.

### 12. Smoke / E2E

Add a single Playwright happy-path test that:
1. Loads the cockpit.
2. Clicks the Agents nav entry.
3. Verifies the four predefined agents appear in the list.
4. Opens "implementation", edits the system prompt, clicks Save, refreshes, verifies the edit persisted.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|---|---|---|
| Unit (Vitest) | **Required** | Contracts schema round-trips; agent-definitions service (seed, CRUD, reset, predefined-delete-rejection); model-list adapters (with mocked tmux IO); MCP dispatcher (all 8 new cases, including auth/validation/error paths); handoff plan-resolution order. |
| E2E (Playwright) | **Required** | One happy-path: nav entry visible, predefined list renders, edit-and-save persists across reload. |

### New tests to add

**Vitest unit tests:**

- `packages/contracts/src/index.test.ts` — extend with a new `describe("agent definition contracts")` block that round-trips `AgentDefinitionSchema`, `LaunchPredefinedAgentInputSchema`, `LaunchCustomAgentInputSchema`, `RegisterPlanInputSchema`, `LaunchHandoffAgentInputSchema`, `PlanRegistrationSchema`, `RuntimeModelsResponseSchema`, `AgentsConfigSchema`. Specifically assert: kind enum is exact; ids match `IdSchema`; LaunchPredefinedAgentInputSchema accepts both `workspaceId`-only AND `repoName`-only inputs (xor branch).
- `apps/daemon/src/agent-definitions/storage.test.ts` (new file) — assert: seed creates four files on first read; `seed()` is idempotent-by-content (running it on a directory that already has well-formed defaults does NOT rewrite the files; running it on a directory with a missing predefined file recreates just that one); `create()` rejects when name or id collides with a predefined; `update()` rejects `kind` change; `remove()` throws on predefined id; `resetToDefaults()` rejects on custom id; `resetToDefaults()` returns the citadel-authored seed, NOT the user's `defaultRuntime`; concurrent `create` calls don't corrupt the directory; **boot-safety**: when `~/.citadel/agents/` cannot be created (parent is read-only), `list()` returns a structured error and does NOT throw out of the call chain.
- `apps/daemon/src/agent-definitions/seed.test.ts` (new file) — assert: each of the four predefined seeds has a non-empty system prompt; runtime defaults to claude-code; names are stable across calls (the seed function is pure).
- `packages/runtimes/src/models/index.test.ts` (new file) — assert: `runtimeModelListers` has entries for the four citadel-maintained runtimes; `hasRuntimeModelLister` returns false for unknown ids.
- `packages/runtimes/src/models/claude-code.test.ts` (new file) — mock the tmux capture surface; assert: a happy-path capture returns a parsed model list (driven by `packages/runtimes/src/models/fixtures/claude-code-models.txt` — a real captured `/models` output, NOT a hand-crafted approximation); a tmux failure returns `{ models: [...fallback], probeError: "<reason>" }`; a 5s+ hang triggers the timeout AND the tmux session is killed (verify via the kill-session mock counter); a parser throw still triggers tmux cleanup (the `finally` block runs).
- `packages/mcp/src/index.test.ts` — extend with a new `describe("agent launchers")` block that asserts: snapshot dispatch returns `{ error: "agent_launcher_requires_daemon" }` for ALL EIGHT new tools (including `list_custom_agents`); tool definitions include the eight new names; sentinel name does NOT clash with any existing sentinel.
- `apps/daemon/src/daemon-mcp-tool.test.ts` (or whichever file holds the existing daemon-mcp-tool tests — verify path first) — assert: `launch_implementation_agent` composes prompt as `## System\n... \n\n## User prompt\n...` (exact header strings; the canary for "system prompt silently dropped"); composition works identically whether `workspaceId` is provided or omitted (both paths route through `composeAndLaunchAgent`); `launch_custom_agent` 404s on unknown id AND on predefined id; `register_plan` rejects:
  - `../etc/passwd` (lexical traversal) → `plan_path_escapes_workspace`
  - `/etc/passwd` (absolute outside workspace) → `plan_path_escapes_workspace`
  - a symlink under `<workspacePath>` pointing OUT to `/etc/passwd` (realpath escape) → `plan_path_escapes_workspace`
  - a directory rather than a file → `plan_path_unreadable` or similar
  - a file larger than 1 MiB → `plan_file_too_large`
- And ACCEPTS a normal `<workspacePath>/.agents/plans/some-plan.md`, storing the realpath in the row.
- `launch_handoff_agent`:
  - When `predefinedKind` and `customAgentId` are both supplied → schema-level rejection (one-of constraint).
  - When neither is supplied → schema-level rejection.
  - Resolves in the order: `planId` → newest registered → newest `.agents/plans/*.md` → `no_plan_found`. Mtimes controlled by test fixtures.
  - Re-validates the stored path at read time: if a registered plan's realpath now escapes the workspace (symlink swap post-registration), reject with `plan_path_escapes_workspace` and do NOT launch.
- `apps/daemon/src/agents-routes.test.ts` (new file — pattern confirmed: `apps/daemon/src/` has `agent-session-routes.ts`, `namespace-routes.ts`, etc. as siblings, follow the existing test-co-location convention). Tests:
  - Happy path for each of the seven new HTTP endpoints.
  - `DELETE /api/agents/<predefined-id>` → 409 with structured error body.
  - `POST /api/agents/<custom-id>/reset` → 400 (only predefined can be reset).
  - `GET /api/runtimes/:id/models` propagates `probeError` to the response without failing the request.
  - `GET /api/runtimes/:id/models?refresh=1` bypasses cache (counter on the underlying adapter advances).
  - `GET /api/runtimes/:id/models` honors the 1h TTL: two calls within 1h hit the cache (counter advances once), a third call after `vi.advanceTimersByTime(3_600_001)` re-probes (counter advances).
  - **Boot-failure regression**: mount the daemon HTTP app in a vitest harness with the home dir pointed at a path where the agents dir cannot be created (e.g. a file where the dir should be); assert the daemon-app boot does NOT throw, `GET /api/agents` returns 503 `{ error: "agent_storage_unavailable" }`, and `POST /api/agents` returns 503 likewise.
  - **Workspace cascade test**: insert a workspace + a `plan_registrations` row, DELETE the workspace via the existing workspace-removal route (or call `store.removeWorkspace` directly), assert the registration row is gone AND `launch_handoff_agent` for that workspace returns `no_plan_found` without throwing.

**Playwright E2E tests:**

- `e2e/agents.spec.ts` (new file) — one test as described in step 12 above. Use the existing fixtures harness (see `e2e/` for the pattern).

### Existing tests to update

- `packages/mcp/src/index.test.ts` — the existing `it("reports local/internal MCP tools and resources")` test asserts `tools` contains specific names (around `expect(status.tools).toContain("launch_agent")`). Update so it also asserts the eight new names are present.
- `packages/db/src/index.test.ts` — the existing `expect(store.query("SELECT version FROM schema_migrations ORDER BY version")).toEqual([...])` assertion (around line 37) needs version 8 appended to the expected list.

### Assertions to add/change/tighten

- In every MCP launch test, assert the **exact** prompt composition: the system prompt MUST appear at the top of the user-facing message, separated by the `## System` / `## User prompt` headers we chose. A regression where the system prompt is silently dropped or appended at the bottom would defeat the entire feature; this assertion is the canary. Run the assertion on BOTH `workspaceId`-provided and `workspaceId`-absent paths.
- Assert that `register_plan`'s path-traversal rejection is strict: `path.resolve` then `fs.realpath` then `startsWith(realpathWorkspace + path.sep)` (note: include `path.sep` to avoid `/work/ws` matching `/work/ws-evil/...`). Test with `../etc/passwd`, `/etc/passwd`, a symlink under `<workspacePath>` pointing to `/etc/passwd`, and a 2-MiB file.
- Assert that the stored `path` column in `plan_registrations` is the realpath (not the input), so a post-registration symlink swap cannot change the target.
- Assert that the handoff resolution order is deterministic given mtimes (the test fixture controls them explicitly).
- Assert that the `LaunchHandoffAgentInputSchema` one-of constraint rejects both "neither field" and "both fields" inputs at schema-parse time (before the daemon dispatch).

### Failure modes / edge cases / regression risks

- **System prompt silently dropped via two-path divergence.** If `operations.startAgentSession` and `operations.launchAgent` thread `prompt` differently to the runtime, the system prompt could be applied in the create-workspace path but dropped in the reuse-workspace path. Mitigation: unified `composeAndLaunchAgent` seam in `packages/operations`; composition assertion runs against BOTH workspaceId-provided and workspaceId-absent inputs.
- **Symlink-based exfiltration via `register_plan`.** A compromised remote agent registers `<workspacePath>/.agents/plans/innocent.md` where it's a symlink to `~/.ssh/id_rsa` or `/etc/passwd`; on `launch_handoff_agent`, the daemon would read the target and prepend it to the next agent's prompt, leaking secrets to the runtime. Mitigation: realpath-based check on register AND on read, max file size 1 MiB.
- **Boot-loop on the user's running systemd daemon.** Merging this PR triggers migration v8 AND new HTTP routes on the user's `:4010` daemon at next start. A defect in `~/.citadel/agents/` access could crashloop the daemon under `Restart=always`. Mitigation: storage layer never throws out of route handlers; broken storage surfaces as 503; boot-safety regression test pins this.
- **Cross-daemon edit races.** Systemd daemon + worktree daemon both write to `~/.citadel/agents/`. Mitigation: file-per-id atomic writes; no in-memory cache (re-read on every API call); seed() is idempotent-by-content; documented "concurrent edits last-write-wins" caveat at v1.
- **Predefined agent ids collide with custom user ids.** A user creates a custom agent with id `implementation`. Storage layer must reserve the four predefined ids; covered by a unit test.
- **Schema migration race on daemon startup.** Two daemon processes start simultaneously (e.g. systemd + a `make deploy`) and both try to apply v8. The existing `INSERT OR IGNORE` already handles this; verify no new code paths introduce a non-idempotent step.
- **Plan registration FK violation when workspace is deleted.** The FK has `ON DELETE CASCADE`; covered by an integration-style unit test that deletes a workspace and asserts registrations vanish.
- **claude-code TUI scrape hangs.** The `/models` interactive command could block if the TUI is unresponsive. The adapter MUST wrap the tmux call in a hard timeout (≤5s) and return the fallback list with a `probeError`. Covered by a timeout-injection test in `claude-code.test.ts`.
- **Nav-entry icon collision.** Adding the wrong `Bot` icon may clash visually with an existing entry. Check by running the cockpit visually before merging (the Playwright test won't catch this).
- **Concurrent edits to the same agent file.** Two cockpit tabs editing the same definition; last write wins. Acceptable for v1 — the form re-reads on save success — but flag for future optimistic-locking work.
- **Other parallel agents touching `apps/daemon/src/app.ts` or `packages/mcp/src/index.ts`.** High overlap risk tonight. Mitigation: prefer adding new files (`apps/daemon/src/agents-routes.ts`, `apps/daemon/src/agent-definitions/*`) and keep edits to `app.ts` and `index.ts` to a few additive lines.

### Adversarial analysis

- **How could this fail in production?** A malformed predefined seed (e.g., a non-string system prompt) is written to `~/.citadel/agents/`, then read on next daemon boot, and the schema-validation throw makes the daemon refuse to start. **Mitigation:** the storage layer validates with the schema on read; on validation failure, log loudly and fall back to re-seeding the predefined defaults rather than crashing.
- **What user actions trigger unexpected behavior?** A user deletes `~/.citadel/agents/implementation.json` manually outside the cockpit. **Mitigation:** the seed function runs on every `list()`, recreating any missing predefined file. Test this explicitly.
- **What existing behavior could break?** The new launchers compose on top of `operations.launchAgent`. If the prompt composition mangles the user prompt (e.g., a stray null byte from the system prompt's encoding), the runtime could receive a malformed input and fail. **Mitigation:** assert the composed prompt is valid UTF-8 and contains the original user prompt verbatim in a contract test.
- **Which tests credibly catch those failures?** The composition assertion, the path-traversal assertion, the timeout-injection assertion, the FK-cascade assertion. Together these cover the four highest-risk paths.
- **What gaps remain?** The Playwright happy-path only covers the edit-and-save loop, not the actual MCP-launch path through to a running agent. Validating an MCP launch end-to-end requires a real workspace + real runtime, which the current Playwright harness doesn't have. Acceptable gap: the unit-level tests around composition and dispatch cover the contract; the launch path itself is already exercised by the existing `launch_agent` MCP tests, and the new launchers reuse that path.

## Tests

(Files listed in QA/Test Strategy above. TDD order: contracts tests → schema/migration tests → storage service tests → model adapter tests → MCP dispatch tests → HTTP route tests → Playwright E2E.)

## Schema or contract generation

No code-generation step; the contracts package is hand-written zod schemas. Run `pnpm -r build` (covered by `make check`) after edits to ensure the contracts package compiles cleanly and consumers pick up the new exports.

## Verification

Before opening the PR:

- `make check` — runs `check:arch`, `check:size` (800 LoC limit), `typecheck`, `lint` (biome), `test` (vitest), `coverage` (90% target on core/backend/shared), `check:deps`, `build`. **Mandatory.** This includes `check:arch` (architecture-boundary gate — verify the new imports in `apps/web` don't pull in `@citadel/daemon` internals; web stays on `@citadel/contracts` only) and `check:size` (file-size gate — `apps/daemon/src/app.ts` is currently 804 LoC; this PR must leave it at or below 800).
- `make e2e` — Playwright happy-path. **Mandatory** (we added a new spec).
- `make smoke` — local API smoke against a running daemon. **Mandatory** (we added several new HTTP endpoints).
- `make performance` — local perf smoke. **Skip** unless we observe regression in the cockpit's initial load (we are adding one new query against `/api/agents`; if the daemon is cold, this could marginally affect time-to-first-paint, so run it if `make smoke` shows non-trivial added latency).

**Pre-merge sequencing.** Immediately before merge, rebase on `main`. If another branch landed a v8 migration first, bump THIS PR's migration to the next free version and update `packages/db/src/index.test.ts`'s `schema_migrations` version assertion. `INSERT OR IGNORE` prevents row collisions but does NOT prevent silent schema-version drift.

Manual gates (per `CLAUDE.md`):
- Don't run `pkill -f node` (would kill the user's systemd daemon).
- Don't touch `/home/jonsnow/Workspace/citadel/` (the main checkout).
- For redeploy/restart, use `make deploy`.
