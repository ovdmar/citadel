Activate the /implement-task skill first.

# Plan: Agent exit message + lifecycle status colors

## Acceptance Criteria

- [ ] **AC1.** When the wrapped agent's runtime is Claude Code, the exit hint includes the agent's actual Claude session UUID resolved at exit time from the transcript filename (`~/.claude/projects/<dasherized-cwd>/<session-uuid>.jsonl`). Final string format when a session id is resolvable: `` [citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume <UUID>`). ``
- [ ] **AC2.** When resolution fails (transcript dir missing, no .jsonl, non-claude runtime) the hint degrades to a session-id-less form that is still actionable: `` [citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume` to pick a session interactively). `` No `<sessionId>` placeholder ever ships.
- [ ] **AC3.** A new `LifecycleTone` taxonomy is introduced with exactly four values: `never-started`, `running`, `done`, `attention`. It is the single source of truth for the lifecycle status-dot colors.
- [ ] **AC4.** Grey (`cit-pulse-idle`) renders **only** for `never-started`. No other state renders grey for the lifecycle dot. (The existing `cit-pulse-idle` class continues to serve non-lifecycle uses such as the cockpit auto-mode pill at `apps/web/src/cockpit.tsx:481`.)
- [ ] **AC5.** Green pulsing renders for `done` via a **new** `cit-pulse-done` class (green color + ripple animation). The existing `cit-pulse-ok` class is **not modified** — it remains the solid-green class used by `apps/web/src/cockpit.tsx:481` (auto-mode pill) and `apps/web/src/inspector.tsx:283` (deploy-health badge). `done` covers two scenarios at the workspace level: (a) all agents finished and a PR exists with non-failing checks; (b) all agents finished and no PR yet.
- [ ] **AC6.** Red pulsing (`cit-pulse-bad` with ripple animation — new ripple, see CSS step) renders for `attention` — agent errored, `waiting_for_input`, `unknown`-with-attention-reason, or `stopped` with non-clean exit code; or workspace-level: any check in `pr.checks` has `conclusion` in `{failure, cancelled, timed_out, action_required}` (the same predicate used by `prToneFor` at `apps/web/src/workspace-card.tsx:443-459`).
- [ ] **AC7.** Spinner / orange ripple (`cit-pulse-run`) renders for `running` — the existing animation, unchanged.
- [ ] **AC8.** Per-agent indicator (stage tab dot at `apps/web/src/stage.tsx:174`) follows the same four-tone taxonomy via `deriveAgentLifecycleTone`.
- [ ] **AC9.** Workspace-level indicator (`apps/web/src/workspace-card.tsx:140-142`) aggregates per-agent tones via priority `attention > running > done` (per-agent never returns `never-started`), produces `never-started` only when `agentSessions.length === 0`, and additionally folds workspace-scoped PR/CI state via `prToneFor` into the result.
- [ ] **AC10.** The navigator "Running" stat (`apps/web/src/navigator.tsx:304`) follows the same rules — receives a workspace→PR map from its caller (cockpit) so PR/CI signals are not silently dropped at the navigator level.
- [ ] **AC11.** Unit tests cover (a) `deriveAgentLifecycleTone` over the full status × exit-code matrix; (b) `deriveWorkspaceLifecycleTone` including PR-tone folding via the actual `PullRequestSummary` shape (no fictional fields); (c) a tmux-pane integration test that runs the wrapper script end-to-end and asserts the printed hint contains a resolved session id when a fixture transcript exists, and the fallback hint when no transcript exists.
- [ ] **AC12.** No remaining `deriveWorkspaceAgentTone` or `WorkspaceAgentTone` references in the repo; the typecheck pass confirms the sweep is complete. (No shim is shipped — verification step replaces it.)

## Context and problem statement

Two related defects in the agent-lifecycle UX surface:

**1. Exit hint placeholder leaks to the user.** When a Claude/Codex agent exits inside a tmux pane, the wrapper bash script prints a hint suggesting `claude resume <sessionId>` — but `<sessionId>` is a literal placeholder, never substituted. Construction site: `packages/terminal/src/index.ts:159` (`terminalCommand`, line 173 emits it). The tmux session id (`tmuxSessionId`) is captured at session creation (line 54-64) but **`tmux` session ids (`$0`, `$5`, …) are not interchangeable with Claude's own session UUIDs**, which is what `claude resume` accepts. Substituting the tmux id would ship a hint that *looks* correct but produces an error when copy-pasted — strictly worse than the current placeholder.

The real Claude session UUID is encoded as the filename of the transcript file Claude Code writes to `~/.claude/projects/<dasherized-cwd>/<UUID>.jsonl`. The Citadel runtime adapter already knows this mapping — `packages/runtimes/src/transcripts/claude-code.ts:11-14` defines `claudeProjectsDir(workspacePath)` (replaces every non-alphanumeric in the abs path with `-`) and the helper reads `fs.readdirSync(dir)` for `*.jsonl` files at line 80-81. The wrapper script can replicate the same lookup at exit time with one `ls -t … | head -1` and a `basename … .jsonl`.

**2. Grey is overloaded in the status dot.** The shared `cit-pulse-*` classes (CSS at `apps/web/src/styles.css:260-301`) are mapped to agent statuses by `deriveWorkspaceAgentTone` in `apps/web/src/workspace-card.tsx:30-35`. Today grey (`cit-pulse-idle`) covers: workspace with no agents, agent in `idle` (post-turn, between turns of an active conversation), agent in `stopped` (finished), agent in `unknown` (daemon restart, indeterminate). That collapses four distinct lifecycle states into one neutral color.

The same dot is used per-agent at `apps/web/src/stage.tsx:174` with a binary `isRunning ? cit-pulse-run : cit-pulse-idle` mapping, so a finished agent and a never-launched agent are visually identical.

New taxonomy: `never-started`, `running`, `done`, `attention`. Per-agent tone derived from `AgentSession.status` + `exitCode` + `statusReason`. Workspace tone aggregated per-agent then folded with PR/CI signal via the existing `prToneFor` predicate (no fictional fields — see "Contract reality check" below).

## Contract reality check (do not skip)

Before drafting the helper signature, the plan was reviewed against the actual contracts:

- `PullRequestSummary` (verified at `packages/contracts/src/index.ts:214-225`) exposes: `number, title, url, state, draft, reviewDecision, checks: CheckSummary[], additions, deletions, reviewers`. **There is no `mergeable` field and no top-level `checks.conclusion`** — `checks` is an array of `CheckSummary { name, status, conclusion: string|null, url, startedAt, completedAt }`. Therefore:
  - "Merge conflicts" cannot be detected from contract data. **Removed from AC6.** A future PR can extend the contract + the gh fetcher if conflict detection is desired.
  - "CI failing" is detected via `prToneFor` (already implemented at `apps/web/src/workspace-card.tsx:443-459`): returns `"failing"` if any check has `conclusion` in `{failure, cancelled, timed_out, action_required}`. Reuse this — do not re-implement.
- The Claude session UUID is *not* available on `AgentSession` today (`packages/contracts/src/index.ts:129-147` — no `claudeSessionId` or similar field). A `runtime-session-uuid` follow-up is tracked in repo issue #17 (referenced from `packages/runtimes/src/transcripts/cursor-agent.ts:17`). This plan does **not** depend on the contract being extended — the wrapper resolves the UUID at exit time from disk.

## Spec alignment

- `specs/B.2-ade-cockpit.md` — **Spec update required** to document the four-tone lifecycle taxonomy, the priority rules, the PR/CI fold via `prToneFor`, and the three render sites. Done as part of the same PR (not a separate step).
- `specs/B.3-agent-sessions-terminal.md` — **Spec update required** to document the exit-hint contract (verbatim final strings for resolved + fallback paths, and the Claude-specific resolution algorithm).
- `specs/A-shared-definitions.md` — No change. `LifecycleTone` is a UI-layer type, not a domain noun.

Specs updated in the same PR as the code, not before — the contract reality check above forces wording that depends on `prToneFor` behavior.

## Implementation approach

**Three coordinated changes:**

### 1. Exit hint substitution (terminal package)

`terminalCommand` (`packages/terminal/src/index.ts:154`) currently takes `(sessionName, command, args)`. Extend its signature to also accept the **workspace cwd** so it can compute Claude's transcript directory at script-build time, AND accept an optional `runtimeId` so the resolver runs only for Claude Code (other runtimes fall through to the fallback hint).

At exit time, the wrapper script:

```bash
# Resolve Claude session uuid by finding the newest .jsonl in the project dir.
# Mirrors claudeProjectsDir() at packages/runtimes/src/transcripts/claude-code.ts:11-14.
project_dir="$HOME/.claude/projects/$(printf %s "$CITADEL_AGENT_CWD" | sed 's/[^A-Za-z0-9]/-/g')"
sid=""
if [ -d "$project_dir" ]; then
  latest=$(ls -t "$project_dir"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest" ]; then sid=$(basename "$latest" .jsonl); fi
fi
if [ -n "$sid" ]; then
  printf '\n[citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume %s`).\n' "$sid"
else
  printf '\n[citadel] Agent exited. Run any command, or restart the agent (e.g. `claude resume` to pick a session interactively).\n'
fi
```

**Quoting discipline:** the printf data argument is double-quoted only where `%s` substitution is needed. Single-quoted format strings carry the backticks literally (bash treats backticks as command substitution inside double quotes but as literal inside single quotes). The whole script is fed to `bash -c <shellQuote(script)>`; `shellQuote` wraps it in single quotes with `'\''` escaping. The outer shell sees the script as a literal argument to `bash -c`, then `bash -c` re-parses it as code where `$()`, `$sid`, double quotes, etc. all work as written. This is the same pattern the file already uses for `trap` and `exec` lines — no new quoting territory.

Resolver is gated by runtime: if `runtimeId !== "claude-code"`, the wrapper skips the lookup and prints the fallback hint directly.

`CITADEL_AGENT_CWD` is set via the existing `env` prefix in the wrapper, so it survives `exec`. Alternatively, use `pwd` inside the wrapper — `pwd` reflects the directory the wrapper was launched in, which is the workspace cwd (the wrapper does not `cd` anywhere). **Decision: use `pwd`** — no new env-var contract, fewer moving parts.

### 2. Lifecycle tone (core helper + types)

Add to `packages/core/src/index.ts`:

```ts
export type LifecycleTone = "never-started" | "running" | "done" | "attention";

export function deriveAgentLifecycleTone(
  session: Pick<AgentSession, "status" | "statusReason" | "exitCode" | "runtimeId">,
): LifecycleTone { /* see mapping table */ }

export function deriveWorkspaceLifecycleTone(input: {
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
}): LifecycleTone { /* see aggregation algorithm */ }
```

`PullRequestSummary` is imported from `@citadel/contracts`, which `packages/core/src/index.ts:1` already imports from — no new boundary crossing.

**Per-agent mapping:**

| `status` | exitCode | Tone | Rationale |
|---|---|---|---|
| `starting` | — | `running` | Process spawned; "warming up" is still active. Grey would mislead. |
| `running` | — | `running` | Active. |
| `idle` | — | `running` | Between-turn waiting in a live conversation. Painting green every turn is visual noise — only true terminal states earn the "done" pulse. |
| `waiting_for_input` | — | `attention` | Agent blocked on operator confirmation. |
| `stopped` | `0`, `null`, `130`, `143` | `done` | Clean exit, operator-initiated Ctrl-C (130), operator `make stop` (143). |
| `stopped` | other non-zero | `attention` | Genuine failure exit code. |
| `failed` | — | `attention` | Status monitor declared failure. |
| `unknown` | — | `attention` if `sessionNeedsAttention(session)` else `running` | Reuses the existing predicate from `packages/core/src/index.ts:21-26`. Indeterminate `unknown` (daemon restart) maps to `running` — something might still be alive, and `running` is less alarming than red while we figure it out. |

**Per-agent never returns `never-started`.** That state only exists at the workspace level.

**Workspace aggregation algorithm:**

1. Let `agentSessions = sessions.filter(s => s.runtimeId !== "shell")`.
2. If `agentSessions.length === 0` → return `never-started`.
3. Let `tones = agentSessions.map(deriveAgentLifecycleTone)`.
4. Compute `agentTone` by priority `attention > running > done > running-as-default-fallback`. (Because per-agent never returns `never-started`, the only possible values are `attention`, `running`, `done`.)
5. Fold PR/CI:
   - If `pullRequest` is non-null AND `prToneFor(pullRequest) === "failing"` → return `attention` regardless of `agentTone`.
   - Otherwise → return `agentTone`.

**Deliberate behavior:** a `running` agent on a workspace with a failing CI surfaces as `attention` (red), not `running` (spinner). This is the user's stated intent ("Red pulsing = something needs attention"). It is also what an operator wants — the failing CI is the more actionable signal. A maintainer's note in the helper comment locks this in so a future maintainer doesn't casually flip it.

### 3. CSS + UI wiring

**New CSS classes:**

- `.cit-pulse-done` — green color + ripple animation. Add to `apps/web/src/styles.css` next to `.cit-pulse-run`. The ripple keyframes are reused (`cit-ripple`); only `border-color` differs (`var(--c-ok)`).
- `.cit-pulse-bad::after` — add a red ripple animation to the existing solid `.cit-pulse-bad`. AC6 requires red pulsing for attention; today the red class is solid. Keep the existing `box-shadow` for fallback non-animated rendering.

**Untouched:** `.cit-pulse-ok` (solid green, still used by inspector + auto-mode pill), `.cit-pulse-idle` (solid grey), `.cit-pulse-run` (orange + ripple).

**Class mapping:**

```ts
function lifecycleToneClass(tone: LifecycleTone): string {
  switch (tone) {
    case "never-started": return "cit-pulse-idle";
    case "running":       return "cit-pulse-run";
    case "done":          return "cit-pulse-done";
    case "attention":     return "cit-pulse-bad";
  }
}
```

Lives in `apps/web/src/workspace-card.tsx` (kept local to the web app — core is purely tones, web maps tones → CSS classes; respects the architecture boundary). Exported so `stage.tsx` and `navigator.tsx` can reuse.

**Render-site edits:**

- `apps/web/src/workspace-card.tsx:30-45,54-56,140-142`: replace `deriveWorkspaceAgentTone` + `citPulseClass` with `deriveWorkspaceLifecycleTone` + `lifecycleToneClass`. Update aria-label suffix to include "agent finished" (done) and no-suffix (never-started).
- `apps/web/src/stage.tsx:153,174`: compute `tone = deriveAgentLifecycleTone(tab.session)`, render `cit-pulse cit-pulse-sm ${lifecycleToneClass(tone)}`.
- `apps/web/src/navigator.tsx:304`: receive a new prop `workspacePullRequests: Map<string, PullRequestSummary | null>` from the cockpit caller; for the aggregate dot, fold each workspace's tone via `deriveWorkspaceLifecycleTone({sessions: workspaceSessions, pullRequest: workspacePullRequests.get(workspaceId) ?? null})` and bubble to a single navigator-level tone using the same priority rule. The cockpit (`apps/web/src/cockpit.tsx`) already has the PR data in its global state — pass the map down.

### Migration strategy

**No schema changes.** UI + wrapper-script change only. No new DB columns, no `schema_migrations` row, no FK changes, `PRAGMA foreign_keys = ON` unaffected.

## Alternatives considered

**Alt 1: Substitute tmux session id (`$5`) for `<sessionId>`.** Rejected — `claude resume $5` is not a valid command. Surfacing the tmux id would be strictly worse than the current placeholder bug.

**Alt 2: Make the exit hint completely generic (no session id, just `claude resume` interactive picker).** Rejected as primary but **adopted as the fallback** (AC2). The reviewer suggested this as one valid path; we prefer the resolved-UUID path when possible because operators in a multi-session day benefit from a one-paste resume command, and degrade only when the transcript file doesn't yet exist.

**Alt 3: Extend `AgentSession` contract with `claudeSessionId` and have the daemon write it from the runtime adapter.** Rejected for this PR — would touch contracts/db/daemon/runtimes simultaneously and is tracked separately as repo issue #17. The wrapper-side resolution is self-contained and unlocks the user benefit immediately.

**Alt 4: Keep a `deriveWorkspaceAgentTone` shim mapping the new 4-state to the old 3-state.** Rejected — the typecheck-driven sweep is small (three call sites total; verified via `grep -r deriveWorkspaceAgentTone`), and a shim would obscure the API change. AC12 makes the sweep explicit.

**Alt 5: Two-channel indicator (ring color + dot color) so a running agent on red CI shows both.** Rejected — out of scope; the user's spec is explicit that one dot conveys lifecycle. Locked behavior in spec text + maintainer comment in helper.

## Implementation steps

### Backend — wrapper script

- Edit `packages/terminal/src/index.ts`:
  - Extend `terminalCommand(sessionName, command, args)` → `terminalCommand(sessionName, command, args, opts: { runtimeId?: string })`. Default `opts = {}`.
  - Replace the static `exitHint` constant with the multi-line shell snippet documented above. Skip the resolver entirely when `opts.runtimeId !== "claude-code"`.
  - Update the call site (search for `terminalCommand(`) — verify there's only one (in `ensureTmuxSession`) and that it has access to the runtime id (it does; runtime id is part of the session-create input).
  - File-size check: `packages/terminal/src/index.ts` is currently 707 lines (88% of the 800-line limit). The edit adds roughly 12-15 net lines for the shell snippet + signature change. Final size ≈ 720 lines — still under the limit. **If the edit pushes it over, extract the wrapper-script construction into a helper file (`terminalCommand.ts`) and re-export.** Verify at implementation time before pushing.

### Backend — types

- No `AgentSession` schema or `PullRequestSummary` changes. Helper takes existing fields.

### Frontend — core helper

- Edit `packages/core/src/index.ts`:
  - Add `LifecycleTone` type, `deriveAgentLifecycleTone`, `deriveWorkspaceLifecycleTone`.
  - Re-export `PullRequestSummary` for callers (it's already a contract type — `re-export type { PullRequestSummary } from "@citadel/contracts"` keeps consumers from importing from two places).
- `packages/core/src/index.ts` currently 90 lines — generous headroom under 800.

### Frontend — CSS

- Edit `apps/web/src/styles.css`:
  - Add `.cit-pulse-done` block (green + ripple) and `.cit-pulse-bad::after` (red ripple). Both reuse the existing `@keyframes cit-ripple`.
  - Do **not** modify `.cit-pulse-ok` — preserves inspector and cockpit auto-mode behavior.
- File-size check: `apps/web/src/styles.css` currently 725 lines. New CSS adds ≈ 10 lines. Still under limit.

### Frontend — render sites

- Edit `apps/web/src/workspace-card.tsx`:
  - Delete `WorkspaceAgentTone` type, `deriveWorkspaceAgentTone`, `citPulseClass`. Re-export `lifecycleToneClass` so stage.tsx and navigator.tsx can import.
  - Replace `agentTone` computation with `deriveWorkspaceLifecycleTone({ sessions: props.sessions, pullRequest: props.pullRequest ?? null })`.
  - Update `agentToneSuffix` for the four-state aria suffix.
- Edit `apps/web/src/stage.tsx`:
  - Replace `isRunning ? "cit-pulse-run" : "cit-pulse-idle"` with `lifecycleToneClass(deriveAgentLifecycleTone(tab.session))`.
- Edit `apps/web/src/navigator.tsx`:
  - Add prop `workspacePullRequests?: Map<string, PullRequestSummary | null>`. Wire from cockpit.
  - Replace the binary dot logic with workspace-by-workspace `deriveWorkspaceLifecycleTone` plus priority aggregate.
- Edit `apps/web/src/cockpit.tsx`:
  - Build the `workspacePullRequests` map from existing state and pass to `<Navigator>`. The data is already available — no new fetch.

### Specs

- Update `specs/B.2-ade-cockpit.md` and `specs/B.3-agent-sessions-terminal.md` per spec-alignment section. Update in same commit as the code; no separate "specs first" step.

### Sweep verification

- `grep -rn "deriveWorkspaceAgentTone\|WorkspaceAgentTone\b" --include='*.ts' --include='*.tsx'` returns empty after edits.
- `grep -rn '<sessionId>' --include='*.ts' --include='*.tsx'` returns empty (or only in test fixture strings that explicitly test the prior bug).

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Tone derivation matrix + workspace aggregation + PR fold + wrapper-script syntax. |
| Unit (Vitest) — wrapper integration | **Required** | A live-tmux integration test that spawns the wrapper in a real tmux session, simulates exit, and asserts the captured pane output contains the resolved or fallback hint depending on a fixture transcript dir. Skipped automatically when `tmux` is unavailable (CI runs with tmux installed; gated by `command -v tmux`). |
| E2E (Playwright) | **Not required** | Status dot is a CSS class change; no new HTTP contract, no new user journey. Visual regression for color is not worth Playwright pixel-diff brittleness. |

### Terminal-completeness gate (per repo extension)

The terminal-completeness gate requires test coverage for: raw input, control/meta sequences, paste, resize, long output, alternate screen, reconnect, cross-session isolation. **This change does not modify terminal I/O behavior** — it only changes the post-exit hint text. Existing tests in `packages/terminal/src/index.test.ts` already cover those dimensions and remain valid. No new coverage in those dimensions is required, but the existing tests must continue to pass (regression gate, not addition gate). Stated explicitly here so the reviewer can confirm the gate is satisfied.

### New tests to add

- `packages/core/src/index.test.ts` (extend if exists; create if not):
  - `describe("deriveAgentLifecycleTone")` — matrix:
    - `starting → running`
    - `running → running`
    - `idle → running`
    - `waiting_for_input → attention`
    - `stopped` with `exitCode: 0 → done`
    - `stopped` with `exitCode: null → done`
    - `stopped` with `exitCode: 130 → done` (Ctrl-C)
    - `stopped` with `exitCode: 143 → done` (SIGTERM)
    - `stopped` with `exitCode: 1 → attention`
    - `stopped` with `exitCode: 127 → attention`
    - `failed → attention`
    - `unknown` with `statusReason: "tmux_missing" → attention`
    - `unknown` with `statusReason: "sentinel_missing_tmux_alive" → attention`
    - `unknown` with `statusReason: "migrated_from_orphaned" → attention`
    - `unknown` with `statusReason: "daemon_restart_indeterminate" → running`
    - `unknown` with `statusReason: null → running`
  - `describe("deriveWorkspaceLifecycleTone")`:
    - empty sessions → `never-started`
    - shell-only sessions → `never-started`
    - one running agent + no PR → `running`
    - one failed agent + one running agent → `attention`
    - all stopped clean + no PR → `done`
    - all stopped clean + PR with all checks `conclusion: "success"` → `done`
    - all stopped clean + PR with one check `conclusion: "failure"` → `attention`
    - one running agent + PR with one check `conclusion: "failure"` → `attention` (red wins over running)
    - all stopped clean + PR with empty `checks` array → `done` (no signal, no override)
    - all stopped clean + PR with one check `conclusion: null` (pending) → `done` (per `prToneFor` — only failure-set escalates)
- `packages/terminal/src/index.test.ts`:
  - **Wrapper script syntax test**: build the script for runtimeId="claude-code", assert `bash -nc <script>` parses cleanly. Same test for runtimeId="codex" (fallback path).
  - **`cd` regression guard**: assert `expect(script).not.toMatch(/(^|;|\n|&&)\s*cd\s/)` — a future "small fix" inserting `cd` would silently break the `pwd`-based Claude UUID resolution; this is a cheap pin.
  - **Wrapper script integration test (live tmux)**:
    - Setup: temp `HOME` pointing at a tmp dir; populate `$HOME/.claude/projects/<dasherized-tmp-cwd>/abc-123.jsonl` with a touch.
    - Build wrapper script with `runtimeId="claude-code"` and a command that exits immediately (`true`).
    - Launch in detached tmux using a portable invocation (tmux's `-e` flag is 3.2+, do not depend on it): `tmux new-session -d -s testN -c <tmpCwd> "env HOME=<tmpHome> bash -c '<wrapper>'"`. Document tmux ≥ 1.9 as the floor (the `-c` flag predates 3.2).
    - Poll until the wrapper exits (sentinel file) — bounded ~3s.
    - `tmux capture-pane -p -S -10 -t testN` and grep for `claude resume abc-123` in the captured output.
    - Cleanup: `tmux kill-session -t testN`.
    - Second case: no transcript file present → grep for `claude resume\` to pick a session` (fallback).
    - Third case: runtimeId="codex" → grep for fallback (no resolver attempted).
    - Skip block via `it.skipIf(!commandExists("tmux"))` to keep CI green when tmux is absent locally.
  - **Existing assertions** at `packages/terminal/src/index.test.ts:340,422` — confirm they still match the `[citadel] Agent exited.` prefix (verify; should be unchanged).
- `apps/web/src/workspace-card.test.tsx` (extend if exists, create otherwise):
  - Render with `sessions=[]` → assert dot class `cit-pulse-idle` and aria-label has no agent suffix.
  - Render with one `running` session + no PR → `cit-pulse-run` + "agent running".
  - Render with one `stopped` (exitCode 0) session + PR all success → `cit-pulse-done` + "agent finished".
  - Render with one `failed` session → `cit-pulse-bad` + "agent needs attention".
  - Render with one `running` session + PR with `conclusion: "failure"` check → `cit-pulse-bad` (PR fold).
- `apps/web/src/stage.test.tsx` (extend if exists):
  - Per-agent dot for each tone — assert class.

### Existing tests to update

- `packages/operations/src/agent-status.test.ts` — read-only spot check; no edits expected.
- `apps/web/src/navigator.test.tsx` (if exists) — extend with the new `workspacePullRequests` prop; assert the global dot reflects fold.

### Assertions to add/change/tighten

- `lifecycleToneClass(t)` mapping table — one `it` per tone.
- Workspace-card render tests use `container.querySelector(".workspace-status-dot")` and assert presence of BOTH `cit-pulse-sm` and the tone class.

### Failure modes / edge cases / regression risks

- **Multi-jsonl in project dir** (operator ran multiple Claude sessions in this workspace): the resolver picks the most-recent by `ls -t` which uses mtime. The most recent transcript corresponds to the session that just exited — confirmed by the same algorithm at `packages/runtimes/src/transcripts/claude-code.ts:73-91` (which adds prompt-time scoring for robustness; the wrapper uses a simpler mtime heuristic, which is correct in the typical case where the just-finished session was the most recent to write).
- **Race: transcript not flushed yet at exit time.** Claude Code may not flush the jsonl to disk in the instant the agent process exits. Mitigation: the resolver runs *after* the agent exits, in a fresh fallback shell — there's usually a tens-of-ms gap where the OS has flushed buffers. If empty, fallback hint applies. The fallback is still useful (interactive picker), so a missed resolve is not a hard failure.
- **`pwd` reflects something unexpected.** The wrapper does not `cd`, so `pwd` is the directory tmux launched the pane in, which is the workspace cwd. Verified by reading `ensureTmuxSession`. Adding a `cd` later would break this — flag in the spec.
- **`ls -t /dir/*.jsonl` with no matches and shopt `nullglob` off.** Bash's default behavior: the glob expands to the literal `/dir/*.jsonl` and `ls` errors. `2>/dev/null` suppresses the error and `head -1` returns empty, so `sid=""` and fallback fires. Confirmed.
- **Shell quoting breaks the wrapper for cwds containing single quotes.** `pwd` output is piped into `sed`, which is invoked through bash. The single-quote escaping in `shellQuote(script)` survives because `pwd` is a runtime read, not a build-time substitution — no JS-side quoting needed. Tested by including a path with a quote in the integration test if feasible.
- **Provider degradation (PR data null/stale).** `pullRequest === null` → no fold; agent-aggregate stands. `pullRequest` present but partial (`checks: []`) → no failure-class check, no fold. Documented as intentional; not "best-effort signalling stale data" — that's separate UX work.
- **Aggregation priority: red wins over running.** A running agent on a red-CI workspace surfaces as red. Documented in the helper's JSDoc with the rationale ("CI failure is the more actionable signal"); locked by test.
- **Existing `cit-pulse-ok` consumers (cockpit auto-mode pill, inspector deploy pulse) must remain unchanged.** Verified by grep: only those two sites use `cit-pulse-ok`. Adding `cit-pulse-done` as a NEW class avoids any cross-impact. Test: snapshot/visual check at the two sites is out of scope — the test is "we didn't edit `cit-pulse-ok` in styles.css" (git-diff inspection during review).
- **Lossy migration from old to new tone enum.** Any external (out-of-repo) consumer of `WorkspaceAgentTone` would typecheck-fail. Verified: type is not exported from a published package — `apps/web` is the only consumer.

### Adversarial analysis

- **How could this fail in production?** Highest-risk path is wrapper-script malformation: a quoting bug makes the script fail at `bash -c` parse time, dropping the user to the fallback shell without ever running the agent. Mitigated by the `bash -n` parse test + live-tmux integration test.
- **What user actions trigger unexpected behavior?** A user manually deleting `~/.claude/projects/<cwd>/` mid-session would cause resolution to return empty and the fallback hint to fire. Acceptable degradation. Renaming the workspace dir between agent start and exit would have the same effect — also acceptable.
- **What existing behavior could break?** The exit hint prefix `[citadel] Agent exited.` is unchanged, so existing assertions in `packages/terminal/src/index.test.ts:340,422` keep passing. Any external code grepping logs for `<sessionId>` literal would no longer match — but the literal was only the placeholder text, so no genuine consumer existed.
- **Which tests credibly catch those failures?** `bash -n` parse + live-tmux integration capture + tone unit-test matrix + workspace-card render test per tone.
- **What gaps remain?** Visual color-match across browsers (Firefox / Safari / Chromium). Accepted — color is a CSS variable already used elsewhere; no per-browser CSS difference expected. No pixel-diff test.

## Tests (TDD order)

1. `packages/core/src/index.test.ts` — `deriveAgentLifecycleTone` matrix + `deriveWorkspaceLifecycleTone` aggregation/PR-fold.
2. `packages/terminal/src/index.test.ts` — wrapper-script `bash -n` parse + live-tmux integration (skipIf no tmux).
3. `apps/web/src/workspace-card.test.tsx` and `apps/web/src/stage.test.tsx` — per-tone render assertions.

## Schema or contract generation

Not applicable. No contract or schema changes.

## Verification

Before pushing the branch:

- `make check` — full local gate (`check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage` ≥ 90% on core/backend/shared, `check:deps`, `build`).
- `grep -rn "deriveWorkspaceAgentTone\|WorkspaceAgentTone\b"` — must return empty (AC12 sweep).
- `grep -rn '<sessionId>' apps packages` — must return empty outside test fixture strings.
- `grep -rn "cit-pulse-idle" apps/web/src --include='*.tsx' --include='*.ts'` — audit each remaining hit; the only AC4-sanctioned consumers are the cockpit auto-mode pill (`cockpit.tsx:481`, when `autoMode === false`) and any other non-lifecycle uses. Any lifecycle dot still pointing at `cit-pulse-idle` is a bug.
- Manual smoke (single eye-check): launch a Claude Code agent in the cockpit, exit it with Ctrl-D, verify the printed hint contains a real UUID. Repeat with `runtimeId !== "claude-code"` (codex or shell) → verify fallback hint.
- `make e2e` and `make smoke` not required (no HTTP surface, no user journey). Reviewer may request `make e2e` for safety; not the default.
