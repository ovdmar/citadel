# Citadel User Journeys

These journeys translate the Citadel specs into developer-facing product behavior for a UI/UX rebuild.

They intentionally avoid implementation vocabulary. The UI should speak in terms of repositories, workspaces, agents, sessions, checks, issues, pull requests, apps, operations, and activity. It should not expose backend architecture, integration internals, raw command output, raw enum names, planning metadata, or tool-specific wiring unless the user explicitly opens diagnostics.

## Primary User

A developer/operator starting, supervising, and reviewing long-running AI engineering agents across several local coding workspaces. They are comfortable with git, terminals, pull requests, checks, issue trackers, local development, and preview environments, but they want Citadel to be the home base where agent work is launched, managed, inspected, and turned into delivery decisions.

## UX Principles From The Journeys

1. Citadel is the place where developers start, manage, and return to long-running agents.
2. The cockpit must make agent output inspectable as both code changes and running preview apps.
3. The cockpit must also answer: what is running, what is blocked, what needs review, what changed, and what can I do next?
4. The daily UI must optimize for frequent workspace creation, workspace switching, agent chat, and finished-agent review.
5. Every visible status needs a reason and, where possible, a next action.
6. Links, actions, statuses, and destructive commands must be visually distinct.
7. Empty, degraded, stale, failed, and loading states belong exactly where the user would otherwise act.
8. The UI should stay dense and scannable with 10-12 active workspaces across 2-3 repositories.
9. Mobile is for monitoring, navigation, and light intervention; desktop is for sustained terminal/review work.
10. Rare setup/configuration flows should not dominate the default cockpit.

## Core Product Promise

Citadel is the developer's agent workbench.

From one workspace, a developer should be able to:

1. Start a long-running agent with a clear task.
2. Leave it running without losing track of it.
3. Return later and see what happened.
4. Inspect the produced code through diff/review surfaces.
5. Inspect the produced product behavior through local preview links tied to the worktree.
6. Continue, stop, retry, hand off, review, or clean up the work.

The cockpit is valuable because it keeps those agent lifecycle and output-review loops in one place.

## Flow Frequency And Priority

The UI hierarchy should reflect how often each flow happens:

1. **Change active workspace:** very frequent. The navigator must make workspace state scannable with compact indicators, including agent state and PR state when present.
2. **Chat with the active agent:** very frequent. The active session/terminal is the main working surface, and terminal shortcuts must pass through correctly.
3. **Create workspace:** frequent, roughly 15-20 times per day. This must be fast and low-friction for empty workspaces, issue-linked workspaces, and pull-request workspaces.
4. **Launch an agent:** frequent but usually automatic after workspace creation. Manual handoff to another agent still needs to be easy.
5. **Inspect agent output:** frequent after agents finish. The UI should notify on completion and make diff/preview review easy.
6. **Inspect PR stats/checks/diff/apps/worktree state:** only when the workspace is ready for review or has a PR. Keep this pane collapsed by default, and open it manually or automatically when a PR exists.
7. **Add/configure repository and hooks:** rare. This happens mostly when starting a new project, so it belongs in setup/settings, not the main daily path.

## Workspace Card Requirements

Workspace cards/rows are the highest-frequency scanning surface. They must stay slim - ideally two lines.

Each card shows:

1. **Left:** an agent state icon. Spinner while an agent session is starting or actively working, static icon when no session is running, dimmed when sessions exist but are stopped or idle.
2. **First line:** editable workspace title. The default title is the worktree name; when an issue is attached the default becomes `<issue-key> · <issue-title> · <workspace-name>`. Edits persist on the workspace record.
3. **Second line:** branch name in a smaller, lighter monospace style.
4. **Right side, PR group:** a PR icon plus diff size (`+adds/-dels`). The PR icon colors map to lifecycle: grey when no PR exists, yellow when the PR exists and checks are pending, green when checks pass, red when any check fails. Clicking the PR icon opens the provider PR URL.
5. **Right side, approval group:** a separate approval icon to the right of the PR icon. Grey when no reviewer is requested, yellow when reviewers are requested but no answer yet, red when changes are requested or comments are unresolved, green check when at least one approval exists.
6. **Inline indicators:** dirty/worktree status, attention dot, issue chip when attached. Extra detail (last activity, full status reason) appears on hover or in the inspector, not as permanent clutter.

## V1 UX Cross-Check

Ovidiu was happy with Citadel v1's UX shape. The v1 problem was coupling to one implementation workflow, not the everyday interaction model. V2 should preserve the useful UX loop while replacing implementation-specific concepts with generic Citadel product concepts.

### Preserve From V1

1. **Three-part cockpit:** compact workspace list on the left, active agent terminal/stream in the center, contextual stats/actions on the right.
2. **Workspace switching as the dominant action:** selecting a workspace immediately changes the active terminal and context.
3. **Agent stream as the center of the product:** the main pane is where the active agent conversation/terminal lives.
4. **Compact workspace rows:** rows show identity, state, next-action signal, last activity, and lightweight external/status icons.
5. **Icon-first external state:** Jira/Slack/GitHub-style links worked because they were compact and recognizable. V2 should generalize this to issue, thread, PR, checks, preview, and logs links, while still allowing selected providers to render their recognizable icons.
6. **PR status color on the PR icon:** v1 used the PR icon color to communicate missing/pending/passing/failing/merged. V2 should keep this pattern.
7. **Diff size near PR status:** v1 exposed +additions/-deletions compactly. V2 workspace cards should show PR number, state, and diff size when a PR exists.
8. **Contextual stats pane:** v1 had stats/review/dev links/git status in a side pane. V2 should keep it contextual and collapsed/off by default until review/PR state makes it relevant.
9. **Worktree app links:** v1's container/dev links made output inspectable as a running app. V2 should keep worktree preview links as first-class agent output.
10. **Plain worktree terminal:** v1 allowed a shell terminal separate from the agent stream. V2 should support empty/manual terminals inside a workspace.
11. **Mobile split between stream and stats:** v1's mobile detail used a stream/stats toggle. V2 should preserve that basic mode split.
12. **Fast manual workspace creation:** v1's create modal supported new workspace, existing branch, and existing PR. V2 should keep that flow fast, with issue-linked and PR-based variants.

### Change For V2

1. Replace v1's job/workflow-specific language with repository/workspace/agent/session language.
2. Replace implementation-specific state names with product-level attention states.
3. Replace OpenClaw-specific, Slack-specific, Jira-specific, GitHub-specific, or engine-specific assumptions with generic product slots: communication thread, issue/ticket, version control, pull request, checks, agents, sessions, and preview apps.
4. Allow selected providers to surface provider-branded links/icons inside those generic slots. For example, Jira can appear as the selected issue/ticket provider and Slack can appear as the selected communication-thread provider, but the layout should not depend on Jira or Slack specifically.
5. Keep diagnostics available, but move raw classifier/provider/session internals out of the default cockpit.
6. Make automatic agent launch part of workspace creation when a task is provided.
7. Make terminal fidelity native to the product rather than an iframe bridge assumption.
8. Keep setup/configuration out of the daily cockpit unless it blocks the current workspace.

### V2 Layout Implication

The target should be close to v1's proven interaction model:

1. **Slim top bar:** logo/title on the left, centered fuzzy search input that doubles as the Cmd+K target, settings icon on the right. The top bar is intentionally thin and never the visual focus.
2. **Left navigator:** primary entries are *Dashboard* (kanban grouped by attention/status) and *History* (archived workspaces with PR snapshot and unarchive). A subtle divider separates those entries from the *Workspaces* group, which carries three small icon controls on its right edge: group-by overlay, add repository overlay, and create workspace.
3. **Center stage:** the active workspace terminal/session column. A tabbed bar lists the workspace's sessions (agent chats and plain terminals) and exposes a plus button to add another agent session or a plain terminal. The selected session occupies the rest of the column. The center column owns its own scrolling; terminal output stays inside xterm.js.
4. **Right inspector:** workspace stats with two tabs - *Stats* (workspace identity, attached threads/issue/PR icons with dual state, deploy hook chips, CI checks) and *Git* (changed files with additions/deletions, structured to grow into a full-screen human review surface).
5. **Resizable + collapsible columns:** both side columns are independently resizable and collapsible. When collapsed they disappear entirely; only the persistent expand affordance remains. The app itself never page-scrolls.

The redesign should not invent a new dashboard-first UX. It should take v1's dark-blue cockpit muscle memory and make it generic, compact, and less coupled to the old implementation lane.

### Visual System

The cockpit uses a dark-blue v1-inspired surface palette. Color carries information density (status colors on PR/check/approval icons, accent on selection), not decoration. Headers are short, controls are dense, and there are no marketing-style hero areas or oversized cards. The top bar is the only horizontal landmark above the workbench.

## Journey 1: First Run And Setup Check

**User goal:** I want to open Citadel for the first time and know what I need to configure before I can manage work.

**Trigger:** Citadel starts with no configured repositories or incomplete setup.

**Flow:**

1. The user opens Citadel.
2. Citadel shows a compact setup view with setup health, missing tools, and available next steps.
3. The user sees which capabilities are ready, unavailable, or need attention.
4. The user fixes missing setup items or proceeds to add a repository.
5. When setup is sufficient, Citadel moves the user into the cockpit.

**UI requirements:**

- Show setup as a checklist with concrete statuses: ready, unavailable, needs sign-in, degraded.
- Explain what product surfaces are affected: pull requests, checks, issues, terminal sessions, app links, actions.
- Keep advanced diagnostics collapsed by default.
- Avoid presenting config files, command names, or integration internals as the primary UI.

**Done when:** The user can tell whether Citadel is ready to manage work, and the next setup action is obvious.

## Journey 2: Add A Repository

**User goal:** I want to register an existing local repository so Citadel can track its workspaces and work state.

**Trigger:** The user clicks "Add repository".

**Flow:**

1. The user chooses or enters a local repository path.
2. Citadel validates the path and confirms it is a git repository.
3. Citadel detects repository identity, current branch, default branch, remotes, and available capabilities.
4. The user reviews workspace defaults and optional repo-specific behaviors.
5. The user saves the repository.
6. The repository appears immediately in the workspace navigator.

**UI requirements:**

- Validation feedback must be inline and specific.
- The user should not need to understand integration internals to decide whether setup is healthy.
- Failed validation must keep entered values editable.
- Repository removal/cleanup must not be mixed into the happy path.

**Done when:** The repository appears in the cockpit and the user can create or inspect workspaces from it.

## Journey 3: Start Agent Work From A Workspace

**User goal:** I want to start a long-running agent on a concrete development task.

**Trigger:** The user has selected or created a workspace and wants an agent to work there.

**Flow:**

1. The user selects a workspace.
2. Citadel shows the workspace identity, current code state, available agents, and any setup gaps before launch.
3. When the workspace was created with an agent handoff, Citadel starts the agent automatically.
4. When manual launch is needed, the user enters the task and chooses the agent to run it.
5. Citadel starts the session and shows it as durable work attached to that workspace.
6. The user can leave the workspace, switch to another one, or close the browser without losing the session.

**UI requirements:**

- Starting an agent must feel like a primary cockpit action, not a secondary terminal trick.
- Automatic launch after workspace creation should be the normal happy path when a task is provided.
- The launch surface should show enough workspace context to avoid starting work in the wrong place.
- The task prompt, selected agent, start time, and session state should remain visible after launch.
- If an agent cannot start, the UI should explain the missing setup or failing state in product language.

**Done when:** The user can confidently launch long-running agent work and know where to find it later.

## Journey 4: Manage Long-Running Agents

**User goal:** I want to supervise multiple agents over time without losing track of their state or output.

**Trigger:** One or more workspaces have active, waiting, failed, completed, or orphaned agent sessions.

**Flow:**

1. The navigator and workspace detail show active sessions and attention states.
2. The user sees which agents are running, waiting for input, failed, completed, or need review.
3. The user opens a session to inspect terminal output, task context, and latest activity.
4. The user sends follow-up input, reconnects, stops, retries, or leaves the agent running.
5. Citadel emits a visible and audible completion notification when an agent finishes.
6. Citadel preserves session identity and history across navigation/reconnect.

**UI requirements:**

- Agent sessions must be first-class entities, not hidden terminal tabs.
- Session rows/cards need task/title, agent, status, started time, last activity, and attention reason.
- Waiting, failed, orphaned, completed, and needs-review states must be obvious.
- Completion notifications should be noticeable without being disruptive.
- Valid actions should be state-aware: continue, reconnect, stop, inspect output, review diff, open preview.

**Done when:** The user can manage several long-running agents without relying on memory or terminal tab names.

## Journey 5: Inspect What An Agent Produced

**User goal:** I want to see what the agent produced, both as code changes and as a running preview.

**Trigger:** An agent has modified a workspace, completed a task, or reached a review-ready state.

**Flow:**

1. Citadel marks the workspace/session as having output to inspect.
2. The user opens the workspace review surface.
3. Citadel shows code output: changed files, diff, additions/deletions, branch state, pull request/check state where available.
4. Citadel shows product output: local preview app links or worktree-based app links, with status/health when available.
5. The user moves between terminal transcript, diff, checks, preview app, links/logs, and activity to decide whether the work is good.

**UI requirements:**

- Code diff and preview app links must be near each other in the review flow.
- Preview links should be tied to the selected workspace/worktree so the user trusts what they are opening.
- The UI should distinguish "agent produced code", "preview is available", "preview failed", and "no preview configured".
- The default view should not require the user to hunt through settings or raw logs to find agent output.

**Done when:** The user can review both the implementation diff and the running result from the same workspace context.

## Journey 6: Understand The Cockpit At A Glance

**User goal:** I want to know what needs my attention right now across active repositories and workspaces.

**Trigger:** The user opens the main Citadel cockpit.

**Flow:**

1. The left navigator lists repositories and workspaces.
2. Each workspace row shows branch, active sessions, dirty state, pull request/check summary, and attention state.
3. The selected workspace opens with a readiness strip and recommended next action.
4. The cockpit highlights blocked, waiting, failed, stale, review-ready, and merge-ready states.
5. The user selects the workspace that needs attention.

**UI requirements:**

- The first viewport must be the agent workbench, not a dashboard collage or landing page.
- Workspace rows must be compact enough for realistic active load.
- Readiness must use human language: "Waiting for your input", "Checks failed", "Review requested", "Uncommitted changes", "Stale data".
- Recommended next actions should be close to the reason.

**Done when:** The user can pick the most important workspace without opening terminal tabs or external pages.

## Journey 7: Create A Workspace From Work To Be Done

**User goal:** I want to create an isolated workspace for a new task, existing branch, pull request, or issue.

**Trigger:** The user clicks "Create workspace" from a repository or cockpit action.

**Flow:**

1. The user chooses the source: new branch, existing branch, pull request, or issue.
2. Citadel previews branch name, local path, base branch, linked work item, and setup steps.
3. The user optionally provides an agent task/handoff for automatic launch.
4. The user confirms creation.
5. Citadel shows the creation operation with progress and output summary.
6. The new workspace appears in the navigator with its initial readiness.
7. If an agent task was provided, the agent session starts automatically inside the workspace.

**UI requirements:**

- The preview must make the workspace identity obvious before side effects happen.
- Empty workspace creation must be the fastest path.
- Issue-linked and PR-based creation should be one compact variation of the same flow, not separate heavy flows.
- If setup fails, show the failure in the operation surface and keep the workspace state explainable.
- Do not force the user through settings to understand why creation is blocked.
- Dirty or unsafe cleanup must require explicit confirmation later.

**Done when:** The user has a visible workspace and knows whether it is ready to start work.

## Journey 8: Resume Or Continue An Agent Session

**User goal:** I want to continue an existing AI coding session inside the selected workspace.

**Trigger:** The user selects a workspace with an existing agent session.

**Flow:**

1. The workspace detail shows existing sessions and their attention state.
2. The user resumes or reconnects to the relevant session.
3. Citadel attaches the terminal and preserves useful context.
4. The user can switch away and return without losing useful context.
5. If a session is waiting, failed, orphaned, or completed, Citadel labels that clearly and offers valid actions.

**UI requirements:**

- Session cards need status, task/title, started time, last activity, and attention state.
- Unavailable agents must explain the missing setup in product terms.
- Stop/reconnect/resume actions must be explicit and state-aware.
- Terminal state should clearly distinguish attached, reconnecting, disconnected, read-only, and failed.
- Terminal keyboard shortcuts must be passed through to the terminal correctly.

**Done when:** The user can supervise agent work without guessing which session is alive or where input should go.

## Journey 9: Work In The Terminal Without Losing Cockpit Context

**User goal:** I want terminal interaction to feel reliable while still seeing the operational state around it.

**Trigger:** The user opens or focuses an agent/session terminal.

**Flow:**

1. The terminal opens in the selected workspace stage.
2. The user types, pastes, resizes, scrolls, and switches sessions.
3. Citadel preserves terminal continuity across workspace changes and reconnects.
4. The user sees terminal connection state and session identity.
5. The user can create an empty terminal in a workspace without starting an agent.
6. The user can move between terminal, diff, review, apps/actions, and activity without losing orientation.

**UI requirements:**

- Terminal is a primary work surface, not a decorative preview.
- Agent chats are terminals running agent CLIs; terminal fidelity is therefore product-critical.
- Empty terminals are allowed for manual commands or prep work.
- The terminal must have stable bounds and not cause layout jumps.
- Long output must remain responsive.
- Session identity and workspace identity must stay visible near the terminal.

**Done when:** The terminal feels trustworthy enough for real interactive coding sessions.

## Journey 10: Review Code State Before Acting

**User goal:** I want to decide whether to inspect, fix, wait, hand off, merge, or deploy.

**Trigger:** The user selects a workspace with code changes or a linked pull request.

**Flow:**

1. Citadel shows branch, dirty state, changed file counts, additions/deletions, and ahead/behind state.
2. Citadel shows pull request identity, review state, and check summary when available.
3. The user opens a read-only diff.
4. The user sees failed or pending checks with direct links to details.
5. Citadel recommends the next action based on the combined state.

**UI requirements:**

- Diff/review surfaces must be read-only.
- PR/checks/diff/app stats can stay collapsed by default before review time.
- When a PR exists, the stats pane may auto-open or show a stronger compact indicator.
- Failed checks need count, name, status, and direct details link.
- Stale data must be visible instead of silently treated as fresh.
- Conflicts and dirty files should raise attention state.

**Done when:** The user can make the next delivery decision from the cockpit.

## Journey 11: Open Preview Apps, Links, And Workspace Actions

**User goal:** I want to access the useful destinations, preview apps, and actions for a workspace without hunting through external tools.

**Trigger:** The selected workspace has app links, review links, docs, logs, dashboards, or safe actions.

**Flow:**

1. Citadel groups links by purpose: preview app, review, issue, logs, docs, dashboards.
2. The user opens links directly from the workspace detail.
3. Citadel shows available actions separately from links.
4. The user triggers an action such as refresh, restart, redeploy, setup, or cleanup.
5. Citadel shows the action as an operation with progress, result, and activity.

**UI requirements:**

- Links and executable actions must look different.
- Actions that can change state must show safety level and confirmation where needed.
- Running actions must disable conflicting actions.
- Failed actions must remain visible and retryable when safe.

**Done when:** The user can move from workspace state to the right preview, external page, or safe command without ambiguity.

## Journey 12: Diagnose A Blocked Or Degraded Workspace

**User goal:** I want to understand why a workspace is blocked and what I can do next.

**Trigger:** A workspace is marked blocked, degraded, waiting, stale, failed, or unavailable.

**Flow:**

1. The workspace readiness strip names the state and reason.
2. The detail view lists blocking checks, failed setup, missing setup, dirty files, waiting sessions, failed operations, stale data, or unavailable external state.
3. Each reason links to the exact panel, operation, session, check, or setting that explains it.
4. Citadel recommends a next action where one is valid.
5. The user resolves the issue, refreshes state, or waits with confidence.

**UI requirements:**

- No silent fallbacks. If data is stale, missing, or failed, say so.
- Blocker explanations should be short but actionable.
- Diagnostics should be reachable, but not dumped into the default view.
- The user should never need to infer the blocker from raw logs first.

**Done when:** The user knows whether to fix, review, wait, refresh, or configure something.

## Journey 13: Track Operations And Activity

**User goal:** I want durable visibility into actions Citadel ran and why the current state changed.

**Trigger:** The user opens global operations/activity or looks at a workspace with recent operations.

**Flow:**

1. Citadel shows running, completed, failed, canceled, and retryable operations.
2. Workspace detail shows relevant operations near the workspace.
3. Operation detail includes status, progress, output summary, error text, duration, and related workspace/session.
4. Activity explains what happened, when, why, and by which user/action.
5. Safe operations can be retried or canceled.

**UI requirements:**

- Operations should be first-class records, not transient toast messages.
- Failed operations should stay visible until acknowledged or superseded.
- Activity should explain causality, not just timestamp events.
- Global activity must be reachable without losing cockpit context.

**Done when:** The user can reconstruct what happened and recover from failed actions.

## Journey 14: Manage Repository And Workspace Lifecycle Safely

**User goal:** I want to archive, remove, or clean up work without accidentally deleting useful state.

**Trigger:** The user archives/removes a workspace or removes repository tracking.

**Flow:**

1. Citadel previews the impact: workspace files, sessions, operations, dirty changes, app links, and history.
2. If active sessions, dirty files, or running operations exist, Citadel requires explicit confirmation.
3. The user chooses whether to preserve local files where applicable.
4. Citadel performs cleanup as an operation.
5. The navigator and activity update after completion.

**UI requirements:**

- Archive and delete/remove must be visually and semantically distinct.
- Preservation of local files must be the safe default.
- Destructive or hard-to-reverse actions need impact text.
- Cleanup failures must be visible and recoverable.

**Done when:** The user can clean up safely without losing track of what was preserved.

## Journey 15: Monitor From Mobile

**User goal:** I want to check progress and handle light actions from a phone.

**Trigger:** The user opens Citadel on a mobile viewport.

**Flow:**

1. Citadel shows a compact monitor view with active workspaces and attention states.
2. The user drills into a workspace to see readiness, sessions, checks, failed operations, and links.
3. The user can refresh state, open external links, stop a session, or retry a safe operation.
4. Sustained terminal work remains available but not treated as the primary mobile task.

**UI requirements:**

- Panels must stack cleanly without overlap.
- Text must wrap instead of overflowing.
- High-density desktop layouts should collapse into monitoring-first mobile views.
- Light actions must remain reachable and explicit.

**Done when:** The user can monitor and unblock simple issues from mobile without broken layout.

## Journey 16: Use Search Or Command Access

**User goal:** I want fast access to common cockpit actions without navigating every panel.

**Trigger:** The user clicks the centered search input in the slim top bar, or presses Cmd+K (Ctrl+K on Linux/Windows).

**Flow:**

1. A modal opens with a focused fuzzy search input.
2. The query is matched against workspace name/title, branch name, attached issue key/title, attached PR number and URL, repository name, and current attention status.
3. Results show matching workspaces with enough context to identify them (repo, branch, attention).
4. Selecting a result focuses that workspace in the cockpit and closes the modal.
5. The same input also exposes runnable commands (open Settings, open Operations, open Onboarding, reconcile, stop active session, refresh active workspace) when no workspace matches or when typed explicitly.
6. Actions obey the same safety and operation model as the normal UI.

**UI requirements:**

- Search is keyboard-friendly: arrow keys move between matches, Enter selects, Escape closes.
- Results must include enough context (repo, branch, PR, attention) to avoid acting on the wrong workspace.
- Destructive commands still require confirmation.
- Unavailable actions should explain why.
- The modal trigger lives in the top bar so it is reachable from every cockpit state.

**Done when:** Frequent cockpit actions and the right workspace are reachable with one shortcut without bypassing safety.

## Journey 18: Browse The Dashboard And History

**User goal:** I want a higher-level view of active workspaces by status, and a way to recover archived workspaces.

**Trigger:** The user clicks *Dashboard* or *History* in the left navigator.

**Flow (Dashboard):**

1. The dashboard groups active workspaces into kanban-style columns by attention/lifecycle state (working, needs review, blocked, dirty, idle).
2. Each column lists the workspaces in that state with the same slim card affordances used in the navigator.
3. Selecting a card focuses that workspace in the cockpit.

**Flow (History):**

1. The history view lists archived/removed workspaces in a table.
2. Each row shows workspace name, repo, branch, archive timestamp, lifecycle outcome (fully removed vs. worktree still present), the PR snapshot at archive time (state, size, link), and an unarchive control.
3. Unarchive restores the workspace to active lifecycle when its worktree is still present.

**UI requirements:**

- Dashboard columns must remain readable with 10-12 active workspaces.
- History must distinguish worktree-still-present from fully-removed cases so unarchive is only offered when safe.
- Both views must not introduce extra scroll axes; column/table scrolling lives inside the view, not the page.

**Done when:** The user can scan workspace state at a glance and recover useful archived work.

## Journey 17: Recover From Bad Or Missing External State

**User goal:** I want Citadel to remain useful when external data is unavailable, stale, or partially broken.

**Trigger:** Checks, pull request state, issue state, app discovery, or other external data cannot be refreshed.

**Flow:**

1. Citadel keeps the workspace visible.
2. The affected surface marks data as unavailable, degraded, or stale.
3. The user sees what product capability is affected.
4. Valid local actions remain available.
5. The user can retry refresh or open diagnostics.

**UI requirements:**

- Do not hide broken assumptions behind generic empty states.
- Do not show raw integration debug dumps in the main cockpit.
- Local repository, workspace, terminal, diff, operation, and activity state should remain usable where possible.
- The degraded state should contribute to readiness.

**Done when:** The user can distinguish "nothing to show" from "Citadel could not fetch this".

## Anti-Journeys

The UI rebuild should explicitly avoid these outcomes:

1. A generic integration dashboard where the developer has to decode system plumbing before starting or reviewing agent work.
2. A landing page or marketing-style first screen.
3. Equal-weight panels where terminal, diff, status, setup, and activity compete with no clear task hierarchy.
4. Raw debug output or internal names leaking into the default product UI.
5. Silent empty states that hide failed setup, stale checks, or missing data.
6. Mobile layouts that only shrink desktop panels until they overlap.
7. Action buttons that look like links, or links that look like actions.
8. Destructive cleanup hidden behind vague labels.
9. Agent sessions hidden behind terminal implementation details.
10. Preview app links detached from the workspace/worktree that produced them.
11. Terminal previews that look nice but are not reliable for real interaction.
12. A UI that optimizes for one workspace while becoming unreadable at realistic active load.

## Journey-To-Spec Map

- First run and setup: B.6, B.8
- Add/remove repository: B.1, B.7
- Cockpit/readiness: B.2, B.8
- Workspace creation/lifecycle: B.1, B.7
- Agent sessions and terminal: B.3
- Git, pull request, checks, diff: B.4
- Apps, links, actions, deploy-style flows: B.5, B.7
- Operations and activity: B.7
- Mobile and command access: B.8
- Degraded/stale state handling: B.2, B.6, B.8
