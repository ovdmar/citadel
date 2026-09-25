Activate the /implement-task skill first.

# Plan: Repo hooks framework (file-based bash + agent)

## Acceptance Criteria

- [ ] Hook files dropped into `.citadel/hooks/<event>/<name>.sh` are discovered automatically per workspace, with NO entry required in `config.hooks` or `repoDefaults.{setupHookIds,teardownHookIds,appHookIds,actionHookIds}`.
- [ ] Hook files dropped into `.citadel/hooks/<event>/<name>.agent` or `.prompt` are discovered automatically per workspace, parsed for optional frontmatter, body templated against the hook payload, and dispatched by spawning a fresh isolated agent session in the workspace with the rendered body as the seed prompt.
- [ ] `.sh` file hooks behave identically to today's config-defined command hooks: spawn with `cwd=<workspace.path>`, JSON payload on stdin, stdout parsed as `HookOutput`, activity logged.
- [ ] Multiple files per event run in lexicographic filename order; config-defined hooks for the same event run first (preserving today's `setupHookIds` ordering), then file hooks.
- [ ] `.citadel/hooks/deploy` continues to work unchanged — its `list`/`redeploy` contract is untouched. `deploy` is NOT a `HookEvent`, so event-folder discovery never iterates `.citadel/hooks/deploy/`. If someone creates that as a directory, its contents are silently ignored by the framework (the deploy file at `.citadel/hooks/deploy` would then fail `inspectHookFile`'s `isFile()` check and `resolveDeployHook` returns `"missing"` — same behavior as today).
- [ ] Existing config-defined hooks continue to work unchanged. After the pre-implementation fixture audit (step 1.5), no existing daemon or operations test requires modification.
- [ ] `HookEventSchema` is extended with `pr.merge`, `merge.conflict.detected`, `review.requested`. Consumer PRs can land file hooks before their producers ship — the events validate via zod and are accepted by discovery.
- [ ] File hook diagnostics surface in the same `HookDiagnostic` shape used by config hooks: validation status, last run, output summary, exit status (or session id for `.agent`).
- [ ] `.sh` file that exists but is not executable produces a diagnostic ("exists but is not executable") and is skipped — same pattern as `resolveDeployHook`.
- [ ] Agent-prompt files (`.agent` / `.prompt`) with malformed frontmatter, unknown frontmatter keys, reserved keys (`target`, `blocking`), invalid `displayName`, or non-existent `runtime` produce a diagnostic and are skipped without dispatching a session. The frontmatter schema is `.strict()` — unknown keys reject.
- [ ] Agent-prompt files inside `.citadel/hooks/agent.started/` are rejected with a diagnostic (would cause infinite session-spawn loop). Only `.sh` is allowed under that event.
- [ ] Agent-prompt template references to missing payload fields render as the literal `{{path}}` token (no crash, no error). Numeric path segments (`{{links.0.url}}`) are supported. Traversal uses `Object.hasOwn` per hop (no prototype walk).
- [ ] Agent-prompt hooks return after the agent session is *launched*, defined as: the promise from `createAgentSession` has resolved with a session object — which per `packages/operations/src/create-agent-session.ts` means tmux session created AND first prompt delivered (`submitPrompt` returned `{ ok: true }`). The runner never blocks on subsequent session output.
- [ ] Agent-prompt dispatch propagates the firing `operationId` so the session's activity events link back to the operation that triggered the hook.
- [ ] `make check` passes (typecheck, biome, vitest, coverage ≥90% on touched core/backend/shared modules including `packages/operations/src/index.ts` wiring, deps, build).

## Context and problem statement

**What exists now.** Citadel hooks are defined in `config.hooks` (citadel's global JSON config) with `{ id, event, command, args, cwd, blocking }`. Repos opt into specific hooks via `repoDefaults.{setupHookIds, teardownHookIds, appHookIds, actionHookIds}`. The hooks runner (`packages/operations/src/hooks-runner.ts`) filters by event + hookIds, spawns the command, writes a JSON payload on stdin, parses `HookOutput` from stdout, logs activity. Hook events are: `workspace.{setup,teardown,apps,action,created,archived,removed}`, `agent.started`.

The lone exception is the **deploy hook**: a single executable file at `.citadel/hooks/deploy` discovered by `resolveDeployHook` with a bespoke `list`/`redeploy` subcommand contract. It demonstrates the file-based-tracked-in-repo pattern but is special-cased — every other hook type still flows through citadel's global config.

**What needs to change.** Generalize file-based discovery so repos can ship hooks *tracked in the repo* (versioned alongside code, reviewable in PRs, no citadel-config touch) for every hook event. Add a second hook kind — `.agent` / `.prompt` — that spawns an agent session instead of running a subprocess, so hooks can use MCP tools the bash hooks cannot reach (Slack MCP for Hootsuite deploy notifications, GitHub MCP for PR merge orchestration, etc.).

**Why.** Three parallel consumer features depend on this contract:

1. **PR merge button** (PR block): needs a `pr.merge` hook firing site so repos can declare merge orchestration in `.citadel/hooks/pr.merge/` — a bash hook for repos that just want `gh pr merge`, an agent hook for repos that need MCP-mediated downstream effects (Slack notify, deploy trigger).
2. **fix-conflicts** (merge-conflict block): needs an `.agent` hook that, when conflicts are detected, dispatches an agent to resolve them.
3. **Review system**: needs a `review.requested` hook firing site so repos can choose their review workflow.

The framework must publish an explicit contract (event names, payload shapes, frontmatter spec, ordering, failure semantics). This branch now also wires the initial producers for `pr.merge`, `merge.conflict.detected`, and `review.requested` so dependent features have a real firing site to target.

## Spec alignment

Primary spec: `specs/B.6-providers-hooks-config.md` §Hooks (items 1–10). Today the section reads "Setup/Teardown/App/Action hooks are *configured per repo*" — file-based discovery is an additive way of "configuring per repo" (tracked in the repo's `.citadel/hooks/` tree rather than citadel config). No item is invalidated; three items need amending and one new item added:

- §Hooks item 1 currently `[~]`: extend the sentence to mention the two configuration surfaces (citadel config + repo `.citadel/hooks/`).
- §Hooks item 6 (structured workspace/repo/provider context): add explicit payload-shape reference per event.
- §Hooks item 9 (cwd/env policy, timeout, output bounds, logs): extend to cover `.agent` dispatch (session launch as the unit of execution).
- New §Hooks item 11: agent hooks. "Hooks may be implemented as agent prompts (`.agent` files). Agent hooks spawn a fresh isolated agent session with the file body as the seed prompt; the session runs to completion independently and logs its own activity. `.agent` is not allowed under `agent.started/` to prevent infinite loops."

Cross-cutting specs:

- `specs/B.5-apps-links-actions.md` §Actions item 1 already notes "A dedicated home for repo-level actions is TBD." The `pr.merge` event opens that door but the UI for it ships in the PR-merge-button consumer PR — only document the event name here.
- `specs/A-shared-definitions.md` item 6 defines Hook as "a repo-scoped extension command that returns structured data or executes structured actions." Extend to "…command or agent prompt that returns structured data or executes structured actions."

**Spec updates are the first implementation step.**

## Implementation approach

Introduce a single discovery layer that returns a unified `DiscoveredHook` list per event per workspace, combining config-defined hooks and file-based hooks. The runner iterates that list; each entry knows how to execute itself (command spawn or session launch).

**Layering.** A new module `packages/hooks/src/discovery.ts` owns file enumeration, classification by extension, frontmatter parsing for `.agent`, and `DiscoveredHook` construction. To avoid a new package-edge from `@citadel/hooks` to `@citadel/config`, `HookEventSchema` moves to `@citadel/contracts` (a stable enum already publicly referenced via `HookConfig.event`) and is re-exported from `@citadel/config` for backcompat. Discovery imports the schema from contracts (already a dep of `@citadel/hooks`).

**Agent dispatch.** `.agent` files are dispatched by injecting a `dispatchAgentHook` callable into the hooks runner's deps. This avoids a `@citadel/hooks` → `@citadel/operations` import; the wiring happens in `packages/operations/src/index.ts` where both already live. Per `create-agent-session.ts`, the existing `createAgentSession` resolves *after* tmux session creation AND first prompt delivery — that resolution point is what the framework treats as "launched".

**Frontmatter parser (no YAML dep).** Minimal line-oriented format between two `---` lines at file start. Each line: `^([a-z][a-z0-9_-]*): (.+)$`. The value is *everything after the first colon-space* — naturally handles colons-in-values (`displayName: Hootsuite: notify`). No quoting, no nesting, no arrays, no multi-line values. Supported keys (PR1): `runtime`, `model`, `displayName`. Reserved (`.strict()` zod rejects with diagnostic): `target`, `blocking`, any unknown key. Body is everything after the closing `---`; missing frontmatter means body is the entire file. ~30 LOC parser + 20 LOC validator.

**Templating.** Render `{{a.b.c}}` against the JSON payload by walking dotted paths. Each hop uses `Object.hasOwn(parent, segment)` (no prototype walk). Numeric segments treated as array indices (`{{links.0.url}}`). Missing fields render as the literal `{{...}}` token. Non-string leaves stringified via `String(value)`. ~35 LOC.

**Ordering.** Per event: config-defined hooks first (in `hookIds[]` array order, matching today's behavior for `setupHookIds`), then file-based hooks (lexicographic by filename, ascending). Predictable, surprising-free, preserves all existing tests.

**Activity & failure semantics.**
- `.sh` file hook: identical activity event to today (`hook.<event>` with `outputSummary`/`structuredPayload`).
- `.agent` file hook: activity event `hook.<event>` with `outputSummary: "Launched agent session <id> (runtime=<r>, model=<m>)"`, `structuredPayload: null`. Session's subsequent activity events link by `operationId` (propagated through `dispatchAgentHook`).
- Either kind failing: activity event `hook.<event>.failed` with the error message, runner continues to next hook (non-blocking) UNLESS the hook is `.sh` and the event's default-blocking is true (today: `workspace.setup`/`workspace.teardown`; adding `pr.merge` in this PR — `gh pr merge` failure must surface).
- `.agent` failure (`createAgentSession` rejected OR `submitPrompt` returned `{ ok: false }`) is treated identically to a `.sh` non-zero exit: `hook.<event>.failed` activity, non-blocking. `.agent` hooks cannot be blocking in PR1 (`blocking` frontmatter is reserved/rejected).

**No churn to existing tests.** The fixture audit in step 1.5 verifies no `apps/daemon/src/**/*.test.ts` or `packages/operations/src/**/*.test.ts` fixture creates a `.citadel/hooks/<event>/` directory that would now activate. Discovery returns an empty list when the directory is missing; the runner sees only config hooks; existing tests passing `setupHookIds: []` keep working.

## Alternatives considered

**A. Make file-based discovery write virtual `HookConfig` entries into `config.hooks` at startup.** Rejected: hooks are workspace-scoped (each workspace has its own checked-out copy of `.citadel/hooks/`), but `config.hooks` is process-global. Two workspaces of the same repo on different branches could have different hook files. Discovery must happen at hook-firing time, scoped to the workspace.

**B. Use a single extension (e.g. `.hook`) with internal type detection (shebang line).** Rejected: the user explicitly asked for the `.agent` extension as the visible signal. Filename-as-contract makes diffs reviewable at a glance ("this PR adds a new agent hook for pr.merge") without opening the file. Shebang-based dispatch would also tempt people to put arbitrary interpreters (`#!/usr/bin/env python3`) into a path Citadel claims to govern.

**C. Run `.agent` hooks synchronously (block on session completion).** Rejected: agent sessions can run for minutes or hours. Blocking the hook runner would freeze `workspace.setup` flows and the activity feed. Fire-and-forget after launch is the only viable shape for PR1; if a future use case needs synchronous behavior, frontmatter `blocking: true` is the upgrade path (currently reserved).

**D. Interleave config-based and file-based hooks via a single user-declared order.** Rejected: requires a new ordering primitive (priority numbers? a manifest file?) that nobody has asked for. The simple two-tier order (config first, then files lex) is documented and predictable; users who care about precise ordering can choose one surface.

**E. Drop `.sh` file discovery from PR1 and ship only `.agent` (config hooks already cover bash).** Rejected by user in the grilling round (Q1 = "Full surface"). File-based bash discovery is the foundation for migrating repos away from citadel-global `config.hooks` over time, which is the actual destination state ("hooks tracked inside each repo" per the scratchpad block).

**F. Use `js-yaml` or `yaml` package for frontmatter parsing.** Rejected: adds a supply-chain edge (lockfile-sensitivity gate) for a use-case that only needs flat `key: value` lines. The line-oriented mini parser handles colons-in-values via split-on-first-colon and rejects everything else with a diagnostic. If frontmatter ever needs nested structures, we add a parser then.

**G. Add a `suppressNotificationHooks: true` flag to `CreateAgentSessionInput` to prevent the `.agent`-at-`agent.started` infinite loop.** Rejected: more general but adds an input field consumers can forget. Simpler: refuse `.agent` files under `agent.started/` outright (diagnostic, skip). `.sh` is fine there because subprocess execution doesn't fire `agent.started`.

## Implementation steps

### 1. Spec updates (FIRST)
- `specs/B.6-providers-hooks-config.md` §Hooks: amend items 1, 6, 9 as described in Spec alignment; add new item 11 for agent hooks (including the `agent.started/` restriction).
- `specs/A-shared-definitions.md` item 6: extend Hook definition to include "or agent prompt."
- Both are doc-only; reviewable in the same PR as the implementation.

### 1.5. Pre-implementation fixture audit
- Grep `apps/daemon/src/**/*.test.ts` and `packages/operations/src/**/*.test.ts` for any test fixture creating `.citadel/hooks/` directories (`grep -rn "\\.citadel/hooks" apps/daemon/src packages/operations/src --include='*.test.ts'`).
- For each match, classify: (a) a `.citadel/hooks/deploy` file fixture (safe — not picked up by event-folder discovery), (b) a `.citadel/hooks/<event>/` directory fixture (must delete or assert on the additional hook firing).
- Document the audit results inline in the implementation PR description before writing any production code.

### 2. Contracts (`packages/contracts`)
- **Move** `HookEventSchema` from `@citadel/config` to `@citadel/contracts`. Re-export from `@citadel/config` so existing imports (`import { HookEventSchema } from "@citadel/config"`) keep working. The enum gains three variants: `pr.merge`, `merge.conflict.detected`, `review.requested`. `deploy` is deliberately NOT added — it remains a file-name convention for the special-case deploy hook, not an event.
- Add `AgentHookFrontmatterSchema` (zod, `.strict()`) covering:
  - `runtime: z.string().min(1).optional()`
  - `model: z.string().min(1).optional()`
  - `displayName: z.string().regex(/^[A-Za-z0-9 _:-]{1,80}$/).optional()`
  - `.strict()` rejects unknown keys including the reserved `target` and `blocking` (with a clear "reserved for future use" message in the catch path of discovery — zod emits "Unrecognized key" which we wrap).
- Add `CreateAgentSessionInputSchema.shape.operationId: z.string().optional()` (round-trip parse test in `packages/contracts/src/index.test.ts`) so `dispatchAgentHook` can propagate the firing operation id into the session.
- Do NOT add `DiscoveredHookSchema` in PR1 — no consumer reads it yet; deferred to the UI PR that surfaces file hooks in `repo-settings.tsx`. Internal types live inside `@citadel/hooks`.

### 3. Config schema (`packages/config`)
- Replace the local `HookEventSchema` definition with `export { HookEventSchema } from "@citadel/contracts"`.
- Extend the `HookConfigSchema.transform` default-blocking list from `["workspace.setup", "workspace.teardown"]` to `["workspace.setup", "workspace.teardown", "pr.merge"]` — a failing `gh pr merge` must surface.
- Enforce the `file:` prefix reservation on `HookConfigSchema.shape.id`: `.refine(id => !id.startsWith("file:"), { message: "id 'file:' prefix is reserved for file-based hooks" })`. Test asserts rejection.
- `superRefine` paths for new events are not needed (no `repoDefaults.*HookIds` arrays reference them).

### 4. Frontmatter parser (`packages/hooks/src/frontmatter.ts` — new file, ~50 LOC)
- `parseFrontmatter(content: string): { meta: Record<string, string>; body: string; error?: string }`
- Detect frontmatter: file must start with `---\n`. Find next `\n---\n`. If absent, return `{ meta: {}, body: content }`.
- Each line between fences: strip a trailing `\r` (defensive, even though Citadel is Linux-only — accidental CRLF from a copy-paste shouldn't break parsing). Then match `^([a-z][a-z0-9_-]*): (.+)$`. Split value on the FIRST `: ` occurrence; the rest is the value verbatim (handles colons-in-values; trailing whitespace in values is preserved — document in the parser test).
- Lines that don't match yield `error: "malformed frontmatter line: <line>"` and short-circuit (no partial meta).
- Body = everything after the closing fence's `\n`.
- Pure function, no I/O.

### 5. Discovery (`packages/hooks/src/discovery.ts` — new file, ~160 LOC)
- `discoverFileHooks(input: { workspacePath: string; event: HookEvent }): { hooks: FileHook[]; diagnostics: FileHookDiagnostic[] }`.
- Reads `<workspacePath>/.citadel/hooks/<event>/`; returns `{ hooks: [], diagnostics: [] }` if missing.
- For each directory entry:
  - Skip subdirectories.
  - Classify by extension: `.sh` → `command-file`, `.agent` → `agent-file`; ignore other extensions silently.
  - For `.sh`: `fs.accessSync(path, X_OK)`; if missing, push diagnostic (`"<path> exists but is not executable"`), exclude from `hooks`.
  - For `.agent`:
    - If `event === "agent.started"`: push diagnostic (`".agent hooks are not allowed under agent.started/ (would loop); use .sh instead"`), exclude.
    - Read file. Parse frontmatter via `parseFrontmatter`. On parser error, push diagnostic, exclude.
    - Validate meta via `AgentHookFrontmatterSchema`. On zod error, push diagnostic, exclude.
    - If body (after frontmatter) is empty/whitespace-only, push diagnostic (`"empty body"`), exclude.
- Sort `hooks` by filename ascending (`name.localeCompare(other)`).
- Hook id is derived: `file:<event>/<filename>`. The `file:` prefix is **enforced** as reserved by `HookConfigSchema.shape.id.refine(id => !id.startsWith("file:"), { message: "id 'file:' prefix is reserved for file-based hooks" })` (step 3). Test in `packages/config/src/index.test.ts` asserts a config hook with `id: "file:foo"` fails validation.

### 6. Template renderer (`packages/hooks/src/template.ts` — new file, ~35 LOC)
- `renderTemplate(body: string, payload: unknown): string`
- Match `\{\{([a-zA-Z0-9_.]+)\}\}`. For each match:
  - Split path on `.`. Walk via reducer: `path.reduce((cur, seg) => cur && Object.hasOwn(cur, seg) ? cur[seg] : MISS, payload)`. For numeric segments on arrays, `Object.hasOwn(arr, "0")` returns true for index 0 — works out of the box.
  - On MISS: return the literal `{{path}}` (do not substitute).
  - On hit: `String(value)` (numbers/booleans stringify naturally).
- Pure function, no I/O.

### 7. Unified hooks-runner (`packages/operations/src/hooks-runner.ts`)
- Inject `dispatchAgentHook(input: { workspace, repo, runtimeId, model?, displayName?, prompt, operationId }): Promise<{ sessionId: string }>` into the deps of both `runWorkspaceHooks` and `runNotificationHooks`.
- Replace the inline `config.hooks.filter(...)` body with a call to a new internal helper `collectHooks(event, hookIds, config, workspacePath)` that returns the combined ordered list of `{ kind: "command-config" | "command-file" | "agent-file"; ... }`.
- Dispatch each:
  - `command-config` / `command-file` → existing `runCommandHook` path. For `command-file`, the command is the absolute file path; args are `[]`; cwd is workspace.path.
  - `agent-file` → call `dispatchAgentHook` with the rendered template body and the firing `operationId`; log activity; await ONLY the launch (per AC, `createAgentSession` resolves after `submitPrompt` succeeds).
- Failure: caught per-hook. `.sh` honors today's blocking semantics (`workspace.setup`, `workspace.teardown`, now `pr.merge`). `.agent` is always non-blocking.
- Log via `activity` callback. Both file diagnostics (from `discoverFileHooks`) and per-hook results flow through the same `hookDiagnostic`-style record so `repo-settings.tsx` rendering doesn't change shape.

### 8. Operations wiring (`packages/operations/src/index.ts`)
- In the same module where `createAgentSession` is imported, define `dispatchAgentHook` as a closure that:
  - Resolves the runtime: frontmatter `runtime` if present; else the workspace's repo default; else `claude-code`.
  - Calls `createAgentSession({ workspaceId: workspace.id, runtimeId, displayName: meta.displayName, prompt: renderedBody, operationId })`.
  - Maps the resulting `AgentSession` to `{ sessionId: session.id }`.
- Inject this closure into `runWorkspaceHooks`/`runNotificationHooks` calls.
- Architecture-boundary check: today `scripts/checks/architecture-boundaries.ts` only governs `packages/core/src` and `apps/web/src`; it does NOT yet enforce a `packages/hooks/src` rule. As part of this step, extend the script with a new scope `packages/hooks/src` forbidding imports from `@citadel/operations` (~5 LOC, matches the existing rule shape). The new edge `@citadel/operations` → `@citadel/hooks` already exists. No new forbidden edges.

### 9. Diagnostics (`packages/hooks/src/index.ts`)
- Extend `hookDiagnostic` to accept file-hook input (`source: "command-config" | "command-file" | "agent-file"`, `filePath?: string`, `runtime?: string`, `model?: string`). For `agent-file` results, `outputSummary` is `Launched agent session <id> (runtime=<r>)`, `exitStatus` is `null`, `structuredPayload` is `null`.
- Discovery-time diagnostics (skipped files) flow through the same shape with `validationStatus: "invalid"`, `validationErrors: [<reason>]`, `outputSummary: null`.

### 10. CLAUDE.md note
- Add one-line entry under existing conventions: where hook files live, the two extensions, the `agent.started/` `.agent` restriction, and a security note ("Files in `.citadel/hooks/` execute on every relevant event — review them in PRs like you'd review any other privileged code.").

### 11. No schema changes
- File-based discovery is filesystem-only. The `schema_migrations` table is not touched.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Frontmatter parser, template renderer, discovery, runner ordering, failure modes, operations wiring. ~25 new test cases across 5 files. |
| E2E (Playwright) | **Not required** | No user-visible UI surface ships in PR1 (the diagnostic UI in `repo-settings.tsx` already renders any `HookDiagnostic`; the new `command-file`/`agent-file` source values are a label change at most). The actual user-facing entry points — PR merge button, fix-conflicts prompt, review system — ship in consumer PRs and will each get their own E2E coverage when they land. **Rationale:** there is no end-to-end flow that exercises the new code path through the browser in PR1. An E2E that creates `.citadel/hooks/workspace.setup/x.sh`, triggers setup, asserts on the activity feed would be a contrived "test the test" — covered more precisely by unit tests of the runner's combined ordering. |

### New tests to add

- `packages/hooks/src/frontmatter.test.ts` — new file:
  - `parseFrontmatter: no frontmatter → meta:{}, body:entire content`.
  - `parseFrontmatter: empty frontmatter (--- followed immediately by ---) → meta:{}, body after`.
  - `parseFrontmatter: parses key:value lines`.
  - `parseFrontmatter: value containing colon parses correctly` (`displayName: Hootsuite: notify`).
  - `parseFrontmatter: malformed line returns error, no partial meta`.

- `packages/hooks/src/template.test.ts` — new file:
  - `renderTemplate: substitutes single-level keys`.
  - `renderTemplate: substitutes nested dotted paths`.
  - `renderTemplate: leaves missing paths as literal {{token}}`.
  - `renderTemplate: handles non-string leaves (numbers, booleans stringified)`.
  - `renderTemplate: numeric segments index into arrays` (`{{links.0.url}}`).
  - `renderTemplate: does NOT traverse the prototype chain` (`{{__proto__.constructor.name}}` renders as literal token).
  - `renderTemplate: returns body unchanged when no tokens present`.

- `packages/hooks/src/discovery.test.ts` — new file:
  - `discoverFileHooks: returns empty when .citadel/hooks/<event>/ is missing` (`mkdtempSync` for isolated fs).
  - `discoverFileHooks: classifies .sh as command-file, .agent as agent-file, ignores other extensions and subdirectories`.
  - `discoverFileHooks: returns files in lexicographic order regardless of readdir order`.
  - `discoverFileHooks: .sh that lacks executable bit is excluded with a diagnostic`.
  - `discoverFileHooks: .agent with malformed frontmatter is excluded with a diagnostic`.
  - `discoverFileHooks: .agent with no frontmatter treats whole file as body`.
  - `discoverFileHooks: .agent with reserved frontmatter key (target, blocking) is rejected with a diagnostic`.
  - `discoverFileHooks: .agent with unknown frontmatter key is rejected with a diagnostic` (strict-mode zod).
  - `discoverFileHooks: .agent with empty body after frontmatter is rejected with a diagnostic`.
  - `discoverFileHooks: .agent with invalid displayName charset is rejected with a diagnostic`.
  - `discoverFileHooks: .agent under agent.started/ is rejected with a diagnostic (would loop)`.
  - `discoverFileHooks: .sh under agent.started/ is accepted` (no loop risk for subprocess hooks).
  - `discoverFileHooks: parameterized — for each HookEvent except agent.started, .agent files are accepted` (catches per-event special-case regressions).
  - `discoverFileHooks: ignores .citadel/hooks/deploy at the root` (sanity — `deploy` is not in HookEventSchema, so the loop never reads it; assert behavior anyway).

- `packages/operations/src/hooks-runner.test.ts` — new file (no existing test there):
  - `runWorkspaceHooks: runs config hooks (in hookIds order) before file hooks (in lex order)` — spy asserts exact call order.
  - `runWorkspaceHooks: dispatches .agent hooks via injected dispatcher with rendered prompt and does NOT block on session completion` — spy checks resolved promise from launch but no further await.
  - `runWorkspaceHooks: .agent dispatcher rejection produces hook.<event>.failed activity and continues to next hook`.
  - `runWorkspaceHooks: .agent dispatch where submitPrompt fails (createAgentSession rejects with "initial_prompt_not_delivered") produces hook.<event>.failed`.
  - `runWorkspaceHooks: .sh blocking failure on workspace.setup propagates (legacy semantics preserved)`.
  - `runWorkspaceHooks: .sh blocking failure on pr.merge propagates (new blocking default)`.
  - `runWorkspaceHooks: dispatchAgentHook receives the firing operationId`.
  - `runNotificationHooks: file-based agent.started hook (.sh) fires when present; .agent under agent.started/ is rejected at discovery time`.

- `packages/operations/src/index.test.ts` — existing file or new sibling, append:
  - `Operations.runWorkspaceHooks dispatcher wiring: dispatchAgentHook closure calls createAgentSession with rendered prompt and propagated operationId` (~30 LOC, stub store, asserts the closure shape — closes the coverage gate for `index.ts` wiring).

- `packages/config/src/index.test.ts` — existing file, append:
  - `HookEventSchema (re-exported) accepts pr.merge, merge.conflict.detected, review.requested`.
  - `HookConfigSchema.transform defaults blocking:true for pr.merge`.
  - `Config-hook id starting with "file:" is rejected as reserved` (mandatory — enforced via zod refine per step 3).

- `packages/contracts/src/index.test.ts` — existing file, append:
  - `HookEventSchema round-trip parse for all variants including new ones`.
  - `AgentHookFrontmatterSchema accepts valid frontmatter; rejects unknown keys, reserved keys, invalid displayName charset`.
  - `CreateAgentSessionInputSchema accepts optional operationId`.

### Existing tests to update

- After step 1.5 (fixture audit), any fixture that creates `.citadel/hooks/<event>/` directories must either be deleted (if accidental) or updated to assert on the new hook firing. Until the audit runs, this is "to be determined" — the audit is a hard gate before implementation.
- Should any daemon test fail because of changed activity logging (the new `outputSummary` shape for `agent-file`), update it to assert on stable substrings rather than full equality.

### Assertions to add/change/tighten

- Discovery: assert the diagnostic shape (not just empty result) when files are skipped — catches silent regressions where an exec-bit bug produces a "passes by exclusion" green test.
- Runner ordering: assert exact call order of a spy across config + file hooks (lex order is non-obvious; explicit assertion prevents future "sort stability" regressions).
- Agent dispatch: assert the dispatcher is invoked exactly once per `.agent` file AND that the rendered prompt has substitutions applied AND that the operationId is propagated (use a payload with `{{workspace.id}}` to catch a regression where the template step is silently skipped).
- Template prototype: explicit test that `{{__proto__.foo}}` renders as literal `{{__proto__.foo}}`, not `[object Object]` or anything from the prototype chain.

### Failure modes / edge cases / regression risks

- `.citadel/hooks/<event>/` exists but is empty → empty list, no diagnostic, no error.
- `.citadel/hooks/<event>/` contains a subdirectory → ignored.
- Symlink in `.citadel/hooks/<event>/` → `fs.accessSync` follows by default, matches deploy hook behavior.
- Two file hooks share a base name with different extensions (`foo.sh` and `foo.agent`) → both included; lex order resolves precedence.
- `.agent` body empty after frontmatter → diagnostic, skip.
- Runtime resolution fails (`runtime: nonexistent` in frontmatter) → diagnostic, skip.
- Payload values containing `{{` → not substituted recursively (template walks once over body, not over substituted values).
- Same hook file fires during `workspace.setup` AND `workspace.created` (different events) → no conflict; each event has its own folder.
- Backward-compat: a repo has `repoDefaults.setupHookIds: ["bootstrap"]` referencing a config hook AND drops `.citadel/hooks/workspace.setup/00-bootstrap.sh`. Both fire (config first, then file). By design — same as configuring two `setupHookIds`. Document in CLAUDE.md.
- Worktree gotcha: `.citadel/hooks/` is checked out per worktree; a hook file added on a branch doesn't fire for workspaces on other branches. By design — that's the point of "tracked in the repo."
- `.citadel/hooks/deploy/` directory accidentally created while `.citadel/hooks/deploy` file still exists: `inspectHookFile`'s `isFile()` returns false on the directory, `resolveDeployHook` returns `"missing"` — deploy silently disabled. Document in CLAUDE.md alongside the hook layout note.
- `pr.merge` `.sh` hook fails: blocking semantics propagate (operation fails). Consumer PR (PR merge button) gets to handle the failure — framework does the right thing automatically.

### Adversarial analysis

- **How could this fail in production?** A repo drops `.citadel/hooks/workspace.setup/destructive.sh` with `rm -rf /`. Same blast radius as any setup hook today; file-based discovery removes the soft gate of "must be added to `setupHookIds`." Mitigation: files in `.citadel/hooks/` are reviewed in PR like any other code. CLAUDE.md note makes this explicit.
- **What user actions trigger unexpected behavior?** `chmod -x .citadel/hooks/workspace.setup/bootstrap.sh` silently disables the hook. Diagnostic surfaces in `repo-settings.tsx` (existing panel) — easy to miss but not silent at the system level.
- **What existing behavior could break?**
  - `apps/daemon/*.test.ts` setup/teardown hookIds tests: covered by the step 1.5 audit. Expected to keep passing.
  - The deploy hook contract: covered by an explicit discovery test and the `deploy`-not-in-`HookEventSchema` invariant.
  - Hook timeout policy: file hooks use the same `commandPolicy.hookTimeoutMs` (120s) as config hooks.
  - Agent-session loop: blocked by the `agent.started/.agent` rejection.
- **Which tests credibly catch those failures?** Runner ordering test catches "config hooks no longer fire"; deploy-hook isolation test catches "deploy hook double-fires"; diagnostic-on-skip tests catch "silent skip"; agent dispatch + submitPrompt-failure test catches "session never launches"; agent.started/.agent rejection test catches the loop.
- **What gaps remain?** No E2E coverage. No integration test verifying a `.agent` hook actually produces a real agent session (the dispatcher is mocked in unit tests). A consumer PR (PR merge button) will exercise the full path; if that PR's tests fail, this PR's framework is the suspect. Acceptable for PR1.

## Tests

(Derived from QA/Test Strategy — TDD order: tests written first, then implementation passes them.)

New files:
- `packages/hooks/src/frontmatter.test.ts`
- `packages/hooks/src/template.test.ts`
- `packages/hooks/src/discovery.test.ts`
- `packages/operations/src/hooks-runner.test.ts`

Existing files extended:
- `packages/contracts/src/index.test.ts` — `HookEventSchema` move + new variants; `AgentHookFrontmatterSchema`; `CreateAgentSessionInputSchema.operationId`.
- `packages/config/src/index.test.ts` — re-exported `HookEventSchema` accepts new events; `pr.merge` default-blocking.
- `packages/operations/src/index.test.ts` — `dispatchAgentHook` wiring test.

Implementation order (TDD):
1. `frontmatter.test.ts` → `packages/hooks/src/frontmatter.ts`.
2. `template.test.ts` → `packages/hooks/src/template.ts`.
3. Contracts schema tests → schema additions/move in `packages/contracts/src/index.ts`.
4. Config schema tests → re-export + `pr.merge` blocking in `packages/config/src/index.ts`.
5. `discovery.test.ts` → `packages/hooks/src/discovery.ts`.
6. `hooks-runner.test.ts` → rewrite `hooks-runner.ts` around `collectHooks` + dispatcher injection.
7. Operations wiring test → wire `dispatchAgentHook` in `packages/operations/src/index.ts`.

## Schema or contract generation

No DB schema changes. No generated artifacts. Zod schema changes (move of `HookEventSchema`, new `AgentHookFrontmatterSchema`, `CreateAgentSessionInputSchema.operationId`) are picked up by the next `pnpm build` automatically.

## Verification

- `make check` — full local gate (typecheck, biome, vitest, coverage ≥90% on `@citadel/hooks`, `@citadel/config`, `@citadel/operations`, `@citadel/contracts`, deps, build). **Required.**
- `make smoke` — not required: no new daemon HTTP routes; existing routes that emit `HookDiagnostic[]` keep the same response shape (the new `source` field on diagnostics is additive; serializers tolerate extra fields).
- `make e2e` — not required: no user flow changes ship in PR1 (rationale in QA Layer evaluation).
- `make performance` — not required: discovery runs once per hook firing and is bounded by the number of files in `.citadel/hooks/<event>/` (small constant in practice); not on a hot path.
