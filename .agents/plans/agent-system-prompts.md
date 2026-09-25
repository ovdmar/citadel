Activate the /implement-task skill first.

# Plan: Agent System Prompts

## Acceptance Criteria

- [ ] Set system prompts, ideally on the fly when launching agents, provided by Citadel for specialized agents and freestyle sessions.
- [ ] Freestyle sessions must be configurable in Settings once for all runtimes, not per runtime.
- [ ] Specialized agents use the agent prompt defined in the Agents tab.
- [ ] The Settings-configured freestyle/base system prompt must also be included for specialized agents, so a specialized agent receives the Settings base prompt plus its specialized role prompt.
- [ ] Pass the prompt on the fly via flags when possible, including Claude and Codex.
- [ ] Paste it and send the message for Cursor or other runtimes that do not support system prompt append.

## Context and problem statement

Citadel already models role templates with `systemPrompt` in `packages/contracts/src/agents-system.ts`, and the Agents tab edits that value. Launch code does not currently treat it as a system/developer instruction. Freestyle direct role launches in `apps/web/src/stage.tsx` send the role `systemPrompt` as `prompt`, and structured launchers in `apps/daemon/src/structured-role-launchers.ts` join `template.systemPrompt` into the ordinary prompt array.

Session launch is centralized in `packages/operations/src/create-agent-session.ts`: it resolves runtime launch settings, then delivers the initial prompt either through `promptArg`, Codex positional prompt, or `submitPrompt` paste. Runtime launch argv mapping lives in `packages/runtimes/src/launch-profile.ts`, with built-in runtime defaults in `packages/config/src/index.ts`.

The change needs a separate launch-time session instruction channel so role prompts and the global Citadel base prompt are no longer conflated with initial user tasks. It also needs a single Settings field that applies once across all runtimes, and a fallback path for runtimes without native support.

## Spec alignment

Specs touched:

- `specs/A-shared-definitions.md`: role template already says a role stores a system prompt. Update Agent session / Launch settings language to distinguish initial prompt/task from launch-time system instructions and define the Settings base system prompt.
- `specs/B.2-ade-cockpit.md`: Center Stage and Global Agents Configuration need to state that freestyle runtime launches use the Settings base system prompt, while specialized role launches compose the Settings base prompt first and the Agents-tab role prompt second.
- `specs/B.3-agent-sessions-terminal.md`: Agent Sessions and Agent Runtimes need to cover `systemPrompt` delivery, source/delivery metadata, native argv support, and pasted fallback semantics.
- `specs/B.6-providers-hooks-config.md`: Runtime Capability Discovery and Settings IA need the global base system prompt setting and adapter-specific system prompt argv mapping.
- `specs/B.8-ui-performance-quality.md`: Applies to the Settings UI addition. No new visual pattern is needed beyond existing Settings form patterns.
- `docs/operations/config-reference.md`: Update config docs for `agentSessions.baseSystemPrompt`, built-in runtime mappings, composition order, and process-list visibility caveat for argv-delivered prompts.

This is new behavior relative to the current specs, so spec/doc updates are the first implementation step. The implementation-status markers in every touched spec must be updated in the same PR so the specs clearly show which prompt-delivery behavior is planned versus implemented and tested.

## Implementation approach

Add an explicit system-prompt model at the contract and operation boundary:

- Public `CreateAgentSessionInput.systemPrompt?: string`, treated only as optional caller-supplied supplemental text.
- Public `LaunchAgentInput.systemPrompt?: string`, treated only as optional caller-supplied supplemental text.
- Public role-launch intent input, separate from generic session creation, that carries constrained role/action intent but no prompt text or trusted source metadata.
- Internal trusted role prompt input, passed through daemon/operation options rather than public REST/MCP request bodies.
- Internal restore metadata input `resumeSourceSessionId?: string`, passed by daemon restore paths only and never accepted from public REST/MCP request bodies.
- Internal persisted session metadata: `systemPromptSnapshot`, `systemPromptSources`, and `systemPromptDelivery`
- Public read-only session metadata: `systemPromptSources`, `systemPromptDelivery`, and `systemPromptLastDelivery`; normal session/API/MCP responses do not expose `systemPromptSnapshot`.

Use an omitted public `systemPrompt` to mean "no caller supplement." Use a public string to mean "append this caller-provided prompt after the Settings base prompt." Public callers cannot suppress the Settings base prompt or role prompt. If implementation needs suppression for internal restore/test paths, use an internal-only option such as `systemPromptMode: "default" | "none"`, and reject/prohibit `none` for specialized role launches. For fresh non-role sessions, `OperationService` resolves the Settings base prompt from `config.agentSessions.baseSystemPrompt`. For specialized role sessions, the daemon resolves the role template prompt from trusted server-side template storage, and `OperationService` composes `baseSystemPrompt + roleTemplate.systemPrompt` in that order. Resume/restore launches must not append a new system prompt to an existing runtime conversation; internal restore callers pass a Citadel `resumeSourceSessionId` when they need prompt audit metadata copied from a known source row.

Extend runtime launch options with a generic system-prompt argv mapping:

- Claude built-in: `systemPromptArgv: { argv: ["--append-system-prompt", "{value}"], valueEncoding: "raw" }`
- Codex built-in: `systemPromptArgv: { argv: ["-c", "developer_instructions={value}"], valueEncoding: "toml-string" }`
- Cursor, Pi, and custom runtimes default to no mapping, so Citadel pastes a wrapped first message.

`packages/operations/src/create-agent-session.ts` stays the central delivery point. If a non-empty composed system prompt has a native mapping, insert mapped argv into the runtime option segment before any `promptArg` or positional user prompt. If a non-empty composed system prompt has no usable native mapping, combine the system prompt wrapper and the initial user prompt into one pasted message, bypassing `promptArg` for that launch because unsupported runtimes must receive the system prompt through the visible conversation channel. If no system prompt is composed, preserve existing prompt delivery behavior exactly.

Preserve role launch behavior by splitting role instructions from launch tasks. The Settings base prompt carries Citadel environment/tool guidance for every agent. Role templates remain the specialized `systemPrompt`; role-specific context remains the ordinary prompt. Where a role launch currently has no user task, add a minimal launch task such as "Begin the PM role for this workspace" so native system-prompt delivery does not open an agent that simply waits forever.

## Alternatives considered

- Store the base system prompt on each runtime. Rejected because the requirement is one Settings value for all runtimes, and per-runtime prompt text would invite drift.
- Always paste the prompt wrapper. Rejected because Claude and Codex support launch-time native instruction channels and the user explicitly wants flags when possible.
- Keep role `systemPrompt` in the ordinary initial prompt. Rejected because it fails the core distinction between session instructions and the user's launch task, and it makes native system-prompt support unusable for role agents.
- Use hardcoded runtime IDs inside `createAgentSession`. Rejected because Citadel already has adapter launch options; a `systemPromptArgv` mapping fits the existing model and works for future runtimes.

## Implementation steps

### Specs And Docs

- Update `specs/A-shared-definitions.md`, `specs/B.2-ade-cockpit.md`, `specs/B.3-agent-sessions-terminal.md`, `specs/B.6-providers-hooks-config.md`, and `docs/operations/config-reference.md` before code changes.
- Update implementation-status markers in the touched specs after the code/tests land so each item reflects whether the behavior is implemented and tested.
- Mention in `B.3` that argv-delivered prompts can be visible in local process listings and prompt snapshots are not a secret store.
- Add an explicit `B.3` rule that raw authority tokens must be rejected from every stored or launch-delivered prompt component before config/template save, system prompt composition, snapshotting, argv construction, pasted wrappers, logs, activity, terminal paste, or runtime handoff. Documentation alone is not sufficient.

### Contracts And Config

- Add `systemPrompt` to public generic session schemas as optional caller-supplied supplemental system-prompt text only.
- Split public REST/MCP session inputs from internal operations inputs where needed. Public generic `start_agent_session` / `/api/agent-sessions` inputs must not let callers set trusted metadata such as `role`, `actionId`, `managed`, `systemPromptSources`, `systemPromptDelivery`, `systemPromptSnapshot`, trusted role prompts, or a suppress/default mode. Server-side role/manager launchers set those fields internally.
- Add internal-only `resumeSourceSessionId?: IdSchema` to the operations input used by daemon restore flows. Public REST/MCP schemas must reject it; restore code passes it only when it already has a source Citadel session row id.
- Add a dedicated browser role-launch input schema, for example `StartRoleSessionInputSchema`, with constrained role/action intent and no role prompt text. The daemon resolves the template server-side and rejects unknown/missing roles, invalid target/role combinations, and any payload attempting to include trusted prompt/source metadata.
- Add read-only optional session metadata fields to public `WorkspaceSessionBaseSchema`: `systemPromptSources`, `systemPromptDelivery`, and `systemPromptLastDelivery`. Keep `systemPromptSnapshot` out of public session contracts; persist it in DB only for internal audit/debug access.
- Define `SystemPromptSourceSchema = z.enum(["settings_base", "role_template", "caller"])`.
- Define `SystemPromptDeliverySchema` as a stable read-only shape, for example `{ mode: "native_argv" | "pasted_wrapper" | "none" | "skipped_resume"; runtimeId?: string; reason?: "empty" | "native_unavailable" | "resume" | "argv_too_large" }`.
- Define `systemPromptDelivery` as initial-conversation delivery metadata and `systemPromptLastDelivery` as latest process-launch delivery metadata. Fresh launches set both to the same value; resume/restore preserves or copies the initial metadata and sets only last-delivery to `skipped_resume`.
- Extend `RuntimeLaunchOptionCapabilitiesSchema` to expose whether the runtime has native system-prompt delivery.
- Add `agentSessions: { baseSystemPrompt: string }` to `CitadelConfigSchema`, defaulting to an empty string. This is the Settings-configured freestyle/base prompt; freestyle sessions use it alone, specialized sessions append the role prompt after it.
- Extend `AgentRuntimeConfigSchema.launchOptions` with `systemPromptArgv`.
- Update built-in runtime defaults:
  - `claude-code` uses `--append-system-prompt`.
  - `codex` uses `-c developer_instructions=<toml string>`.
  - Cursor, Pi, and custom runtimes have no native mapping by default.
- Keep `packages/config/src/index.ts` under the 800-line file-size gate by extracting agent-runtime config types/defaults into a small helper module such as `packages/config/src/agent-runtime-config.ts` before adding the new config field.
- Update MCP tool schemas in `packages/mcp/src/index.ts` so `start_agent_session` and `launch_agent` expose optional `systemPrompt`.

### Database Migration

Migration strategy:

- Operation list:
  - `ALTER TABLE workspace_sessions ADD COLUMN system_prompt_snapshot TEXT`
  - `ALTER TABLE workspace_sessions ADD COLUMN system_prompt_sources TEXT`
  - `ALTER TABLE workspace_sessions ADD COLUMN system_prompt_delivery TEXT`
  - `ALTER TABLE workspace_sessions ADD COLUMN system_prompt_last_delivery TEXT`
  - `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (23, 'workspace-session-system-prompts', datetime('now'))`
- Classification:
  - All four `ADD COLUMN` operations are additive nullable columns.
  - The migration row is additive metadata.
  - No destructive or rename operation.
- `schema_migrations` row: version `23`, name `workspace-session-system-prompts`, strictly greater than current `CURRENT_SCHEMA_VERSION = 22`.
- Preserve `PRAGMA foreign_keys = ON;`; this change does not disable or alter FK constraints.
- Existing operator databases: existing session rows get null metadata and continue to list/restore exactly as before. Fresh agent sessions always persist concrete delivery metadata, including `{ mode: "none", reason: "empty" }` when no system prompt is composed; terminal sessions keep null system-prompt metadata.
- Update `CURRENT_SCHEMA_VERSION` to `23`, `workspaceSessionsTableSql()`, `insertWorkspaceSession`, and `sessionFromRow`.
- Store `system_prompt_sources` as a JSON string array such as `["settings_base"]` or `["settings_base", "role_template"]`.
- Store `system_prompt_delivery` as JSON matching the stable `SystemPromptDeliverySchema`, not as ad hoc text.
- Store `system_prompt_last_delivery` as JSON matching the stable `SystemPromptDeliverySchema`.
- Store `system_prompt_snapshot` internally only; normal public session responses omit it.

### Runtime Delivery

- Extend `packages/runtimes/src/launch-profile.ts` with `systemPromptArgv` support and value encodings `raw` and `toml-string`.
- Add a small encoder for TOML string values so Codex prompts with quotes, newlines, or backslashes are safe in `developer_instructions={value}`.
- Add a shared composition helper, for example `resolveSystemPromptForLaunch({ basePrompt, trustedRolePrompt, callerPrompt, mode })`, that returns `{ value, sources }`.
- Add a central launch-text validation helper, for example `validateLaunchTextComponents(components)`, that checks every text component before composition, snapshotting, argv construction, wrapper rendering, warnings/activity, DB insert, or terminal/runtime handoff. Components include Settings base prompt, trusted role prompt, caller supplemental prompt, ordinary initial user prompt/task, structured role context prompt arrays, and fallback default task text.
- The launch-text validator must call a raw authority-token guard, for example `assertNoRawAgentAuthorityToken(text)`. The safe behavior is to reject the launch; do not silently redact launch instructions unless an existing Citadel authority-token utility already defines a reversible-safe redaction convention.
- Validation failures must be sanitized data, not interpolated prompt text. Return or throw only component labels, field paths, and stable error codes such as `authority_token_present`; REST responses, MCP errors, activity entries, warnings, and logs must never include the rejected prompt text or matched token.
- Reuse the same raw authority-token guard when saving `agentSessions.baseSystemPrompt` through config routes and role `template.systemPrompt` through the Agents-tab template update route. Error messages must identify the rejected field without echoing the rejected prompt text.
- Validate native argv suitability after rendering the native mapping and before spawning. Reject NUL bytes and unsupported control content. Measure final UTF-8 byte size of the encoded system-prompt argv segment and the projected full argv after raw/TOML encoding, not the raw prompt length; use conservative constants such as `MAX_SYSTEM_PROMPT_ARGV_SEGMENT_BYTES` and `MAX_AGENT_PROCESS_ARGV_BYTES`. If the prompt is otherwise valid but the encoded segment or projected argv exceeds the limit, fall back to pasted wrapper delivery with `reason: "argv_too_large"` and a launch warning.
- Return delivery metadata from runtime resolution or a new helper, for example `resolveSystemPromptDelivery(runtime, composedSystemPrompt)`.
- Verify native built-in mappings during implementation against local CLI behavior before baking them in:
  - Claude: confirm `claude --help` exposes `--append-system-prompt`.
  - Codex: confirm `codex debug prompt-input -c 'developer_instructions="..."'` renders the value as a developer-level instruction, or fall back to marking the mapping experimental and relying on pasted fallback if verification fails.
- Add a shared wrapper helper with exact text, for example `renderSystemPromptFallbackMessage(systemPrompt, userPrompt)`, so unsupported runtimes all receive the same delimited shape:

```text
<citadel-system-instructions>
[composed system prompt]
</citadel-system-instructions>

<user-task>
[initial prompt, or "No initial task was provided. Wait for the next user instruction."]
</user-task>
```

- In `createAgentSession`:
  - Validate every launch-delivered text component before building `runtimeArgs` or inserting a DB row.
  - Resolve the composed system prompt after validation.
  - Build argv in explicit order: runtime base args, semantic launch-option args, native system-prompt option args when used, session/resume option args, then any runtime-native user prompt arg or positional user prompt. Native system-prompt option args must never be appended after the user prompt.
  - If a non-empty composed system prompt has a native mapping and passes argv suitability checks, insert native args in the runtime option segment and keep existing prompt delivery behavior.
  - If a non-empty composed system prompt has no native mapping, or native argv is unsuitable due to size, render a wrapper message and paste it through `submitPrompt`.
  - If both system prompt and user prompt exist, paste one combined message in fallback mode.
  - If only system prompt exists in fallback mode, paste the wrapper plus an instruction to wait for the next user task.
  - If no system prompt is composed, do not enter fallback wrapper mode; preserve existing user-prompt delivery behavior and persist delivery metadata `{ mode: "none", reason: "empty" }`.
  - If `resumeRuntimeSessionId` is set, do not deliver a system prompt unless an explicit future restore path proves the runtime supports safe append-on-resume.
  - Add an internal-only `resumeSourceSessionId` option for restore callers that know the Citadel row being resumed. When present, load that exact row by id and require its `workspaceId`, `runtimeId`, and `runtimeSessionId` to match the resume request; if the row is missing or mismatched, reject before DB insert or runtime launch.
  - For resume launches with a valid `resumeSourceSessionId`, copy the source row's `systemPromptDelivery`, `systemPromptSources`, and internal snapshot exactly, including legacy null values, and set only the new row's `systemPromptLastDelivery` to `{ mode: "skipped_resume", reason: "resume" }`.
  - For resume launches without `resumeSourceSessionId`, do not attempt an ambiguous lookup by `runtimeSessionId`; persist null initial prompt metadata and `systemPromptLastDelivery: { mode: "skipped_resume", reason: "resume" }`.
- Record `agent.launch_warning` when a system prompt had to be delivered via pasted wrapper because the runtime lacks native support.

### Launch Surfaces

- Add a daemon/operations helper to resolve system prompt sources:
  - Fresh non-role sessions with `systemPrompt === undefined` use `config.agentSessions.baseSystemPrompt` when non-empty and source `settings_base`.
  - Role launchers pass a trusted internal `roleTemplatePrompt` option resolved from server-side template storage; the resolver composes `settings_base` first, then `role_template`.
  - Explicit `systemPrompt` from REST/MCP/launch_agent is appended after `settings_base` and source `caller`.
  - Only internal restore/test paths may set `systemPromptMode: "none"`; public REST/MCP callers cannot disable defaults, and specialized role launches cannot use `none`.
- External REST/MCP callers may provide supplemental prompt text but may not provide trusted source metadata. Source metadata is resolver-owned and read-only.
- Add a browser-facing direct role launch route or equivalent daemon handler using `StartRoleSessionInputSchema`. The browser sends role/action intent and target information; the daemon loads the Agents-tab template, validates role target rules, creates the minimal launch task, and passes a trusted internal `roleTemplatePrompt` into operations.
- Update `apps/web/src/stage.tsx` direct PM/Prototype role launches to use that role-launch intent contract and not send role prompt text.
- Update `apps/daemon/src/structured-role-launchers.ts` so `template.systemPrompt` is removed from prompt arrays and passed separately.
- Update `packages/operations/src/launch-agent.ts` so `LaunchAgentInput.systemPrompt` flows into session creation as caller supplemental text and undefined uses the global base prompt through `OperationService`.
- Update daemon/MCP surfaces that construct runtime descriptors to include `launchOptions` consistently where they need native mapping: `agent-session-routes.ts`, `daemon-mcp-tool.ts`, `structured-role-launchers.ts`, and launch-agent call sites such as scratchpad refine/scaffold hooks if they use `OperationService.launchAgent`.
- Ensure boot restore and resume routes do not inject the current Settings base prompt into resumed conversations. Restore routes that have a source row, such as boot restore candidates, pass internal `resumeSourceSessionId`; public resume requests cannot set it.

### Settings UI

- Add a "Base system prompt" textarea to the Settings -> Agents panel in `apps/web/src/settings-runtimes.tsx`; copy should make clear it applies to freestyle sessions and is prepended to specialized role prompts.
- Bind it to `config.agentSessions.baseSystemPrompt`; saving persists it with the same `/api/config` PUT used by runtimes and terminal settings.
- Keep it outside runtime cards so it is visibly global, not per runtime.
- Preserve existing dense Settings styling and avoid nested card layouts. Keep text and controls within stable Settings form dimensions on mobile and desktop.
- Update the raw structured config editor type in `apps/web/src/structured-config.tsx` so Advanced editing round-trips the new field.

### Compatibility And Safety

- Existing configs load with `agentSessions.baseSystemPrompt = ""`; no base prompt is added until configured, but specialized role sessions still use their role prompt through the new system-prompt channel.
- Empty or whitespace-only base prompt means no Settings base prompt is included.
- New prompt setting affects only future sessions.
- Native argv delivery is local-first but visible to local process inspection while the runtime starts; document this.
- Pasted fallback is intentionally visible in the transcript and should be wrapped so the agent can distinguish Citadel session instructions from the user task.
- Architecture boundary gate: web continues using `@citadel/contracts` and REST; no web import of daemon internals. Core remains untouched.
- Provider-degradation gate: skipped, no provider-backed code paths change.
- Workspace-cleanup-safety gate: skipped, no cleanup/deletion behavior changes.
- Terminal-completeness gate: limited applicability. The plan does not change `packages/terminal`, xterm, resize, reconnect, or raw PTY handling; it reuses existing `submitPrompt` paste delivery. Targeted tests cover the new combined paste content and native/no-native branches.
- Lockfile-sensitivity gate: skipped, no dependency changes.
- File-size gate: no new non-generated source file should exceed 800 lines; extract before growing files near the limit.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | This changes contracts, config parsing, runtime arg resolution, DB row mapping, and launch behavior. Unit tests can directly assert native argv delivery, pasted fallback, config defaults, role prompt splitting, and migration metadata. |
| E2E (Playwright) | Required | The operator-facing Settings -> Agents flow and daemon-served config/session HTTP contracts change. E2E should verify the global base prompt can be saved and affects a new freestyle launch without requiring real Claude/Codex. |

### New tests to add

- `packages/runtimes/src/launch-profile.test.ts`: add `maps a system prompt to native argv with raw and toml-string encodings` and `reports fallback capability when no systemPromptArgv mapping exists`.
- `packages/operations/src/create-agent-session.test.ts`: add `inserts native composed system prompt args before any promptArg or positional user prompt`, `composes Settings base prompt before trusted role/caller prompt`, `pastes wrapped system prompt and user task for runtimes without native support`, `pastes only the wrapper when no initial prompt is provided`, `preserves existing prompt delivery when no system prompt is composed`, `falls back to pasted wrapper when encoded native argv prompt is too large`, `rejects raw authority tokens in every launch text component before DB/argv/wrapper/activity/runtime handoff without echoing rejected text`, `persists concrete initial and last-delivery metadata for native/fallback/none/resume`, `copies resume metadata only from an exact internal resumeSourceSessionId match`, `rejects missing or mismatched resumeSourceSessionId`, `does not perform ambiguous runtimeSessionId metadata lookup when resumeSourceSessionId is omitted`, and `does not apply base system prompt on resumeRuntimeSessionId`.
- `packages/db/src/migration.test.ts`: add `workspace session system prompt migration (version 23)` asserting columns, migration row, and nullable existing-row behavior.
- `e2e/agent-system-prompts.spec.ts` or `e2e/operator-cockpit.spec.ts`: save a global base prompt in Settings -> Agents, start a fake/test freestyle runtime, and assert the launched process or transcript fixture receives the prompt through the configured path.

### Existing tests to update

- `packages/config/src/index.test.ts`: assert default `agentSessions.baseSystemPrompt` is empty, config patches preserve/update it, raw authority tokens are rejected on config save without echoing prompt text, Claude/Codex built-ins include `systemPromptArgv`, and stale configs are backfilled.
- `packages/contracts/src/index.test.ts`: assert public generic session schemas, internal operations schemas if split, `LaunchAgentInputSchema`, `StartRoleSessionInputSchema`, source/delivery schemas, and public session schemas parse the new fields and reject public writes of role/trusted metadata/suppress mode. Assert delivery schema supports `native_argv`, `pasted_wrapper`, `none`, `skipped_resume`, and `argv_too_large` fallback reason.
- `packages/contracts/src/agents-system.test.ts`: assert runtime launch capabilities expose native system-prompt support.
- `packages/operations/src/create-agent-session.test.ts`: extend existing argv and launch-warning tests rather than duplicating setup where possible.
- `apps/daemon/src/structured-role-launchers.test.ts`: assert role launch calls pass trusted role prompt through internal options, the resolver composes Settings base + role prompt, and ordinary `prompt` excludes both system-prompt parts.
- `apps/web/src/stage.test.ts`: assert freestyle direct role actions still select PM/Prototype and the launch payload uses role intent only, with no role prompt text from the browser.
- `apps/daemon/src/agent-templates.test.ts` or the relevant route test: assert raw authority tokens are rejected when saving role `template.systemPrompt` without echoing prompt text.
- `apps/daemon/src/app.test.ts`: assert `/api/config` round-trips `agentSessions.baseSystemPrompt`, `/api/agent-sessions` applies it to a fresh non-role session, public `systemPrompt: null` is rejected, public metadata writes are rejected, unknown role intent is rejected, and direct role launch composes base + server-resolved role template.
- `packages/mcp/src/index.test.ts`: assert `start_agent_session` and `launch_agent` schemas expose optional `systemPrompt`.
- `packages/db/src/index.test.ts`: update expected migration version list through `23` and assert internal snapshot/source-array/initial-delivery/last-delivery metadata round-trips while public session DTOs omit snapshots.

### Assertions to add/change/tighten

- Native Claude/Codex mappings insert the system prompt option before any promptArg or positional user prompt and do not also paste the prompt.
- Codex TOML encoding preserves quotes, newlines, and backslashes.
- Native argv size checks measure the final encoded system-prompt argv segment and projected full argv; a TOML-escaped prompt that expands past the limit falls back to pasted wrapper with `argv_too_large`.
- Effective specialized prompts are ordered as Settings base prompt, blank-line delimiter, then role template prompt.
- No-native runtimes receive one pasted message containing a clearly delimited Citadel session instruction block and the user task, in that order.
- Empty composed system prompt preserves existing promptArg/Codex positional/paste behavior and does not force wrapper mode.
- Oversized native-argv system prompts fall back to pasted wrapper with `reason: "argv_too_large"` and a launch warning; invalid argv content such as NUL bytes is rejected.
- Public `systemPrompt` is optional string-only; `null`, metadata fields, and suppress/default modes are rejected in REST/MCP inputs.
- Internal suppress mode is unavailable for specialized role launches.
- Role launch prompt arrays no longer include `template.systemPrompt`.
- Agent session rows persist concrete initial-delivery and last-delivery metadata for native/fallback/none/resume and source arrays. Terminal sessions keep null values.
- Public session responses expose delivery/source summaries read-only and omit `systemPromptSnapshot`.
- Config save updates the global base prompt without mutating per-runtime rows.
- Raw authority-token patterns are rejected from every stored prompt field and every launch text component before they can appear in config files, template storage, snapshots, argv, fallback wrapper content, warnings, activity, logs, terminal paste content, or runtime args. Negative assertions must verify rejected launch/config/template errors do not echo the prompt text or matched token.

### Failure modes / edge cases / regression risks

- A role launch may stop auto-starting useful work if the role prompt moves to native system prompt without an ordinary launch task. The structured-role and stage tests should catch missing launch-task content.
- A specialized role launch could accidentally omit the Settings base prompt, losing Citadel environment/tool guidance. Composition tests should assert base + role ordering for role launchers and direct stage launches.
- Browser direct role launches could keep trusting client-sent role prompt text. Dedicated role-launch input/route tests should assert the daemon resolves templates server-side and rejects spoofed prompt/source metadata.
- A custom runtime with `promptArg` but no native system prompt support could incorrectly receive a combined prompt through argv instead of paste. `createAgentSession` tests should assert fallback mode uses paste.
- A native argv mapping could be inserted after a positional user prompt and be ignored or treated as prompt text. Exact argv-order tests should cover Claude and Codex.
- A large base or role prompt could exceed OS argv limits, especially after TOML escaping expands the final Codex argv element. Encoded-segment and projected-full-argv size validation plus `argv_too_large` fallback tests should cover this.
- Codex prompt text with quotes or newlines could break `-c developer_instructions=...`. Runtime tests should assert encoded argv exactly.
- Restore flows could append today's Settings base prompt into an old conversation or overwrite the original prompt audit trail. Resume tests should assert no system prompt delivery on `resumeRuntimeSessionId`, source metadata copies only from an exact internal `resumeSourceSessionId` match, mismatched/missing source rows reject, omitted source ids do not trigger ambiguous `runtimeSessionId` lookup, legacy null source metadata stays null, and only last-delivery is marked `skipped_resume`.
- Existing database rows could fail parsing if new metadata is treated as required. Migration and DB round-trip tests should assert nullable compatibility.
- Settings could accidentally save prompt text into each runtime. UI/config tests should assert one global `agentSessions.baseSystemPrompt` field.
- Prompt text in any saved field or launch component could contain raw authority tokens. Validator tests should prove saves/launches fail before any storage/delivery/log/snapshot path receives that text.
- Public API responses could expose full prompt snapshots. Contract/route tests should assert only read-only source/delivery summaries are exposed on normal session responses.
- Pasted fallback could leak sensitive instructions into transcripts. Documentation and wrapper wording should make this explicit; automated tests can only verify the behavior is intentional.

### Adversarial analysis

- **How could this fail in production?** A runtime mapping may be wrong or unsupported, causing launch failure or silent prompt loss. Tests catch built-in mappings, and custom runtimes fall back to paste unless they explicitly declare a mapping.
- **What user actions trigger unexpected behavior?** Editing the global base prompt, launching a freestyle runtime, launching a role from Center Stage, starting a structured role through MCP, passing a caller system prompt, or restoring an old session. Tests cover each category except full real-runtime Claude/Codex execution.
- **What existing behavior could break?** Initial prompts may be delivered differently, role sessions may lack a task, and config save could overwrite runtime fields. The plan preserves existing user-prompt delivery when native system prompt support exists and adds role launch-task coverage.
- **Which tests credibly catch those failures?** Runtime argv tests, create-agent-session launch tests, structured-role launcher tests, app route tests, config tests, DB migration tests, and a Playwright Settings/start-session flow.
- **What gaps remain?** Real Claude/Codex CLI behavior can drift independently of unit fixtures. Manual QA should launch one Claude and one Codex session locally after implementation when those CLIs are available.

## Tests

TDD order:

- Update/add contract tests in `packages/contracts/src/index.test.ts` and `packages/contracts/src/agents-system.test.ts`.
- Update/add config tests in `packages/config/src/index.test.ts`.
- Add runtime mapping tests in `packages/runtimes/src/launch-profile.test.ts`.
- Add DB migration and row mapping tests in `packages/db/src/migration.test.ts` and `packages/db/src/index.test.ts`.
- Add operation launch tests in `packages/operations/src/create-agent-session.test.ts`.
- Update daemon and MCP tests in `apps/daemon/src/structured-role-launchers.test.ts`, `apps/daemon/src/app.test.ts`, and `packages/mcp/src/index.test.ts`.
- Update web/source tests in `apps/web/src/stage.test.ts`.
- Add or extend Playwright coverage in `e2e/agent-system-prompts.spec.ts` or `e2e/operator-cockpit.spec.ts`.

## Schema or contract generation

No generated schema artifact is currently required. Contracts are Zod-defined TypeScript sources, and MCP tool schemas are manually declared in `packages/mcp/src/index.ts`. Run formatting/typecheck through `make check`.

## Verification

- `make check`
- `make e2e`
- `make smoke`

`make performance` is not required because the planned changes do not touch startup hot paths or rendering loops.
