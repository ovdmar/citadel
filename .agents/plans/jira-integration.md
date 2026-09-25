Activate the /implement-task skill first.

# Plan: Jira integration (status changes, auto-update on lifecycle, native picker)

## Acceptance Criteria

Verbatim from the Citadel scratchpad topic "Jira integration":

- [ ] Change Jira status from Citadel (operator-triggered transition from the inspector chip).
- [ ] Agents/hooks auto-update Jira status to keep tickets live (lifecycle events trigger declared transitions).
- [ ] Native Jira issue picker: search + recent issues by default.
- [ ] Hover an attached issue to unattach.
- [ ] (Jira chip dark/light theming is explicitly covered under Theming — out of scope for this plan.)

## Context and problem statement

Today's Jira integration is partial:

- The inspector renders a Jira chip (`apps/web/src/inspector.tsx:329-459`, `IssueAttachSlot`) but the only attach affordance is a free-form `key + URL` text form. There is no search, no recent-issues list, no transition UI, and no unattach control — operators must clear both fields manually and re-PATCH the workspace.
- The daemon already exposes `POST /api/workspaces/:workspaceId/issue-transition` (`apps/daemon/src/app.ts:467-483`) backed by `providers.transitionJiraIssue` (`packages/providers/src/index.ts:389-418`), but the web app never calls it. Status pills in the chip are read-only (`inspector.tsx:390-395`).
- There is no Jira search helper. `collectJiraIssueSummary` only does exact-key lookups (`packages/providers/src/index.ts:322`). The `jtk` CLI is invoked via `jtk(args)` (`index.ts:568-574`) and the project key + command override are already config-driven (`packages/config/src/index.ts:86-92`).
- `agent.started` is logged via `deps.activity(...)` and fans out via `deps.runNotificationHooks(...)` from inside `packages/operations/src/create-agent-session.ts:100-102` — it is **not** emitted on the daemon's SSE/`emit` channel. Workspace lifecycle events (`workspace.created`, `workspace.archived`, `workspace.removed`) fire `runNotificationHooks` from `packages/operations/src/index.ts:242-249,503-511`. There is no EventEmitter or pub/sub bus in the daemon — `apps/daemon/src/app.ts:112-124`'s `emit` is a closure that writes to `sseClients` and conditionally triggers `fsWatchers.reconcile()`.

We need to (a) make the chip a real two-way control (search → attach, unattach, transition), and (b) let Citadel keep Jira tickets in sync without operator action when an agent picks up or finishes work in a workspace.

## Spec alignment

| Spec | Why it applies | Update needed? |
|---|---|---|
| `specs/B.2-ade-cockpit.md` §Inspector Tabs item 4 | Defines the Jira chip behavior. Currently flagged `[x] Shipped`; today's chip only covers attach + read-only status pill. Needs picker + unattach + operator-driven transition. | **Yes** — (1) extend item 4 text to declare: picker with search + recent default; hover-to-unattach affordance; inline transition menu sourced from `IssueTrackerSummary.transitions`; optimistic transition with rollback on `degraded`; "Enter key manually" fallback for issues the picker can't surface. (2) Replace the `[x] Shipped` marker with `[~]` until the picker PR lands; the same commit that ships the picker code re-promotes it to `[x]`. |
| `specs/B.6-providers-hooks-config.md` §Providers items 4 & §Hooks | Declares Jira provider supports `issue state and transitions where practical`. Auto-transition wiring is new product surface — needs spec coverage so it's reviewable. | **Yes** — add a subsection (`## Auto-transitions`) under Providers declaring the `providers.jira.autoTransitions` config block, the supported events (see step 2 for the final enum), idempotency behavior (skip when already in target status), and the degradation behavior (failures log to `activity_events` and never block the originating operation). |
| `specs/B.7-operations-activity-mcp.md` | Activity log already records `provider.issue_transition`. Auto-transitions also surface here as `provider.issue_transition.auto`. | No new behavior required; existing `activity_events` table holds the rows. |
| `specs/A-shared-definitions.md` | Uses canonical terms (Workspace, Provider, Hook, Operation). Plan/code must use these exactly. | No update — terminology stays as-is. |

Spec updates are the **first** implementation step (see Implementation steps §1).

## Implementation approach

Three orthogonal slices, sequenced so each can land + ship independently if needed:

1. **Provider surface for search.** Add `providers.searchJiraIssues(query?: string)` returning `IssueSearchResult[]` (key, summary, status, url, updated). Empty/null query returns recent issues via a JQL that broadens beyond `assignee` (see step 3 for the exact JQL). Non-empty query: if it matches the issue-key regex `^[A-Z][A-Z0-9_]+-\d+$`, route to a `key = "X"` JQL; otherwise route to a `summary ~ "X"` JQL with the full Lucene reserved-character set stripped from the input. Limit 20 results, 12 s timeout, returns `{ status: "degraded", reason, results: [] }` on failure — matches the existing degradation pattern.

2. **Daemon routes (extracted) + UI for picker / unattach / transition.** Because `apps/daemon/src/app.ts` is **already 804 lines** (above the 800-line gate), the new route and the existing `POST /api/workspaces/:workspaceId/issue-transition` get extracted into a new `apps/daemon/src/jira-routes.ts`. New `GET /api/integrations/jira/search?q=...` lives there. UI rewrite: empty input shows recent-by-default; typing debounces 250 ms and React-Query-caches per query (no server-side cache for search — see step 4 rationale). Selecting a result PATCHes the workspace with `{ issueKey, issueTitle, issueUrl }`. Hover/focus on the attached chip exposes an unattach `×` (focus-visible too, with `aria-label="Unattach issue"`) that PATCHes nulls. The chip's status pill becomes a `<button>` opening a transition menu sourced from `IssueTrackerSummary.transitions`; selecting one calls the existing `issue-transition` route, optimistically updates the pill, and rolls back on `degraded`. The picker also exposes a small "Enter key manually" text-link under the results that opens the legacy `key + URL` form, preserving the existing PATCH path for issues the picker cannot surface (e.g., private projects).

3. **Auto-transitions on lifecycle events — wired in the `operations` layer.** Because `agent.started` and workspace lifecycle events fire from `packages/operations`, not from the daemon, this is where the trigger has to live. Extend `providers.jira` config with `autoTransitions: Array<{ event, transition }>`. The daemon constructs a callback `runAutoTransitions(event, repo, workspace, payload)` (similar to the existing `runNotificationHooks` injection in `CreateAgentSessionDeps:18-25`), passes it into `createAgentSession` and into the workspace-lifecycle code paths in `packages/operations/src/index.ts:242-249,503-511`. The callback is implemented by a new daemon module (`apps/daemon/src/jira-auto-transitions.ts`) that: reads the config, resolves the transition name to a transition id, **skips the call if the issue is already in the target status** (idempotency guard — read via `collectJiraIssueSummary`, cached), calls `transitionJiraIssue`, records an `activity_events` row (`provider.issue_transition.auto`), invalidates `providerCache.delete("issue:KEY")`, and re-emits the existing daemon SSE event `provider.issue_transition` so the cockpit refreshes. Listener wiring is constructed exactly once in `createDaemonApp`.

Rationale:
- `collectJiraIssueSummary` and `transitionJiraIssue` remain the only provider primitives that talk to `jtk`.
- Wiring auto-transitions in the operations layer (option (b) from the reviewer's BLOCKER 1 fix) is preferable to introducing a new EventEmitter on the daemon: it (i) reuses the same injection pattern as `runNotificationHooks`, (ii) gives the operations code the same dependency seam tests already exercise, and (iii) keeps the SSE `emit` API minimal (it still does what it does today: SSE fan-out + opt-in fs-reconcile).
- `auto-transitions` are pure provider plumbing, not user-defined hook commands; they don't belong in `HookConfigSchema`.

## Alternatives considered

1. **Introduce an `EventEmitter` on the daemon and have a listener subscribe to `agent.started`.** *Rejected:* `agent.started` is not emitted on the daemon at all today (it lives in operations); introducing a bus on the daemon would still require additionally wiring operations to push into that bus. Two new mechanisms instead of reusing the existing dep-injection pattern.
2. **Reuse the existing `HookConfigSchema` notification hooks.** An operator could write a custom hook command that shells out to `jtk transitions do …`. *Rejected:* the user is asking for a first-class product surface that ships out of the box — making the operator write shell glue defeats the point. Also the failure mode (custom hook executes anything) is much wider than a typed config block.
3. **Server-Sent Event subscription from a sibling service.** Have an external listener subscribe to `/events` and call back into the transition route. *Rejected:* adds a moving part, breaks the local-first guarantee, and re-introduces network round-trip latency for what is a single in-process function call.
4. **Drop the recent-issues default and require typing to search.** Simpler UI. *Rejected:* the topic explicitly calls out "recent issues by default" — and most operator workflows are "attach the ticket I'm already working on", faster from a curated list.
5. **Add a `recent_issues` table to cache JQL results across sessions.** *Rejected:* `jtk` recent JQL is fast (<1 s); the cache adds invalidation complexity and could go stale relative to Jira's actual recent state. Per-query React Query stale-time (5 s) is sufficient.
6. **Native REST + API-token client instead of shelling to `jtk`.** *Rejected:* B.6 calls out `acli/jtk` as the supported method and the existing provider surface is shell-backed. A REST client is a separate, larger work item.

## Implementation steps

### 1. Spec updates (FIRST — must precede code changes)

- `specs/B.2-ade-cockpit.md`: edit item 4 under "Inspector Tabs" to describe (a) the search + recent-default picker, (b) the hover-to-unattach affordance (with focus-visible parity for keyboard), (c) the inline transition menu sourced from `IssueTrackerSummary.transitions`, (d) the "Enter key manually" fallback link. **Demote the marker from `[x]` to `[~]`** at the start of the item to reflect that the new behavior hasn't landed yet. The spec commit ships in the same PR as the picker code; once the code is merged, the same PR re-promotes the marker to `[x]`.
- `specs/B.6-providers-hooks-config.md`: add a `## Auto-transitions` subsection under Providers describing the `providers.jira.autoTransitions: Array<{ event, transition }>` config shape, the supported events (`agent.started`, `workspace.issue_attached`, `workspace.archived`, `workspace.removed` — see step 5 for why `workspace.created` is excluded), idempotency (skip when current status equals target), and degradation behavior (failures log to `activity_events`; do not block the originating operation).

### 2. Contracts

- `packages/contracts/src/index.ts`: add `IssueSearchResultSchema` (`{ key, summary, status, url, updated }`, all but `key` nullable) and `IssueSearchResponseSchema` (`{ status: "healthy" | "degraded", reason, results }`). Export the inferred types alongside `IssueTrackerSummary`.
- Add the auto-transition config schema member (consumed by the `providers.jira` block in `packages/config/src/index.ts`):
  ```ts
  autoTransitions: z.array(
    z.object({
      event: z.enum([
        "agent.started",
        "workspace.issue_attached",
        "workspace.archived",
        "workspace.removed",
      ]),
      transition: z.string().min(1), // transition id or human name; resolved server-side
    }),
  ).default([])
  ```
  Note the explicit exclusion of `workspace.created` and `workspace.updated` — the first fires before any issue can be attached (no-op spam), the second is multi-fire and would burst Jira (see Failure modes).

### 3. Providers

- `packages/providers/src/index.ts` (already 574 lines — has room, but if any addition would push past 700, pre-extract to `packages/providers/src/jira.ts`):
  - Add `searchJiraIssues(query: string | null): Promise<IssueSearchResponse>`. Build the JQL via a pure helper `buildJiraSearchJql(query: string | null): string`:
    - `null` / empty → `(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -14d ORDER BY updated DESC`. This broadens beyond `assignee` so tickets the operator is reviewing or watching also surface.
    - Issue-key shape (`^[A-Z][A-Z0-9_]+-\d+$`, case-insensitive) → `key = "AUTH-123" ORDER BY updated DESC`.
    - Else → `summary ~ "ESCAPED_QUERY" ORDER BY updated DESC` where `ESCAPED_QUERY` strips Lucene-reserved characters (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /` and any newline / carriage-return), collapses internal whitespace, and trims. Document in a comment that `jtk` (and Jira's underlying Lucene) parse `~` operands with their own reserved set independent of shell escaping.
  - Execute via `jtk(["issues", "search", "--jql", jql, "--max", "20", "--no-color"])`. 12 s timeout. Parse with a new pure `parseJiraSearchOutput(text): IssueSearchResult[]` (test-targetable).
  - Add `resolveJiraTransitionByName(key: string, name: string): Promise<string | null>` that fetches transitions and matches case-insensitively against `transition.name` and `transition.toStatus`. Used by the auto-transition module so config can use human-readable names ("In Progress") instead of brittle numeric IDs.
  - Stay under the 800-line file-size gate. If `providers/src/index.ts` is heading past ~720, extract to `packages/providers/src/jira.ts` and re-export from `index.ts` in the same commit.

### 4. Daemon — routes (mandatory extraction)

`apps/daemon/src/app.ts` is **already 804 lines** — adding any inline route fails `check:size`. Therefore extraction is mandatory, not conditional:

- Create `apps/daemon/src/jira-routes.ts` exposing `registerJiraRoutes({ app, asyncRoute, store, providers, providerCache, emit })`. Move into it:
  - The existing `POST /api/workspaces/:workspaceId/issue-transition` handler (currently `app.ts:467-483`) — purely a relocation, no behavior change.
  - New `GET /api/integrations/jira/search?q=...` — calls `providers.searchJiraIssues(q ?? null)` directly. **No server-side cache.** Rationale: per-keystroke queries produce distinct cache keys (typing "AUTH-12" yields 7 unique strings), so the 8 s `cachedProvider` would never hit during typing; the 250 ms input debounce + React Query 5 s stale-time on the client provides all the back-pressure that's needed. Skipping the server cache also avoids stale results outliving fresh Jira state.
- Wire `registerJiraRoutes(...)` from `createDaemonApp`. Confirm `app.ts` drops below 800 lines after the move (it will: removing ~17 lines from the existing handler + not adding the new one).

### 5. Operations — auto-transition injection (replaces the prior "daemon listener")

The auto-transition trigger lives in the operations layer because that is where `agent.started` and workspace lifecycle events originate.

#### 5a. Pre-extract from `packages/operations/src/index.ts` to clear the file-size gate (mandatory, lands first)

`packages/operations/src/index.ts` is **799 lines** — adding the constructor dep + invocations at two call sites (~10 lines minimum) would breach the 800-line gate. Mandatory pre-extraction:

- Create `packages/operations/src/workspace-lifecycle.ts` and move the `archiveOrRemoveWorkspace` method body (`index.ts:503-511` area) plus any private lifecycle helpers it depends on. Re-export the function so `OperationsManager.archiveOrRemoveWorkspace(...)` becomes a thin delegating wrapper.
- The extraction lands in its **own commit** before the auto-transition wiring commit, so the diff is reviewable as a pure refactor. Tests must pass green on the extraction commit alone.
- Acceptance: after the extraction, `wc -l packages/operations/src/index.ts` must be **≤ 780** (gives ≥20 lines of headroom for the new dep + invocations + their imports). The Verification section restates this assertion.
- Alternative (if `archiveOrRemoveWorkspace` proves hard to extract cleanly): move `createWorkspace` or the lifecycle-event activity-logging helpers instead. Any extraction that drops `index.ts` to ≤780 is acceptable, as long as the moved code retains its tests.

#### 5b. New daemon module — `apps/daemon/src/jira-auto-transitions.ts`

Exports `createJiraAutoTransitions({ config, providers, store, activity, emit, providerCache })`. Returns a function with this signature:
```ts
type AutoTransitionEvent = "agent.started" | "workspace.issue_attached" | "workspace.archived" | "workspace.removed";
type RunAutoTransitions = (
  event: AutoTransitionEvent,
  repo: Repo,
  workspace: Workspace,
  payload: { repo: Repo; workspace: Workspace; session?: AgentSession },
) => Promise<void>;
```

**Semantics of `transition` in the config:** the string names the **target status** the issue should end up in (e.g., `"In Progress"`, `"In Review"`, `"Done"`), not the transition name. This is more operator-friendly ("when an agent starts, the ticket should be In Progress") and removes the ambiguity between transition names and status names. The resolver picks the available transition whose `toStatus` matches case-insensitively.

Internally the callback:
1. Looks up matching `config.providers.jira.autoTransitions` entries for `event`. No matches → return.
2. Re-fetches `store.listWorkspaces().find(...)` to read the workspace's **current** `issueKey` (avoids racing against an unattach between event-emit and dispatch). If `issueKey` is null → return.
3. Calls `providers.collectJiraIssueSummary(issueKey)` (cached). Reads `issueStatus`. **Idempotency check:** if `issueStatus` matches the configured target status (case-insensitive trim equality) → record `provider.issue_transition.auto.skip` and return. This avoids the cost and side-effect of step 4 when we're already done.
4. Calls `providers.resolveJiraTransitionByName(issueKey, targetStatus)` — the resolver finds the transition whose `toStatus` matches. If unresolved (no available transition leads to the target from the current status) → record `provider.issue_transition.auto.unresolved` and return.
5. Calls `providers.transitionJiraIssue({ issueKey, transition: resolvedId })`. Records `provider.issue_transition.auto` with the result status. Invalidates `providerCache.delete("issue:${issueKey}")`. Re-emits a **distinct** SSE event `provider.issue_transition.auto` (not the same name as the manual transition route's `provider.issue_transition`) so future operations-layer subscribers cannot accidentally feedback-loop into another auto-transition. The cockpit's SSE consumer listens for both names and invalidates the same query.
6. Wrap the whole body in try/catch — never throw out to the caller (operations would surface the error to the user as if the originating operation failed). Failures log to `activity_events` only.

#### 5c. Inject the callback at every `issueKey` write site and lifecycle emission

A grep confirmed `issueKey` is set in **two** places:
- `packages/operations/src/index.ts:174` — `createWorkspace` reads `input.issueKey ?? null`. An operator can attach an issue at workspace-create time. If non-null on create, the wiring must fire `workspace.issue_attached`.
- `apps/daemon/src/extra-routes.ts:74-75` — workspace PATCH handler. Fire when `issueKey` transitions from null|prev → new non-null.

Wiring:
- `packages/operations/src/create-agent-session.ts`: add an optional `runAutoTransitions: RunAutoTransitions | null` to `CreateAgentSessionDeps`. After `deps.runNotificationHooks(...)` (line 102), `await deps.runAutoTransitions?.("agent.started", repo, workspace, { repo, workspace, session })`. Null-safe so existing tests that don't construct it still work.
- `packages/operations/src/index.ts`: add the same `runAutoTransitions` dep on the OperationsManager constructor. Invoke it:
  - In `createWorkspace`, after the workspace is persisted, **if `input.issueKey` is non-null**, call `runAutoTransitions("workspace.issue_attached", repo, workspace, { repo, workspace })`.
  - In `archiveOrRemoveWorkspace` (now in `workspace-lifecycle.ts` per 5a), after `runNotificationHooks`, call `runAutoTransitions(input.archiveOnly ? "workspace.archived" : "workspace.removed", repo, workspace, { repo, workspace })`.
- `apps/daemon/src/extra-routes.ts:66-88` (workspace PATCH): after the store update, compute `attached = (prevIssueKey == null || prevIssueKey !== nextIssueKey) && nextIssueKey != null`. If `attached` is true, look up the repo and call `runAutoTransitions("workspace.issue_attached", repo, workspace, { repo, workspace })`. Explicitly do nothing on `value → null` (unattach) or `null → null`.
- The daemon constructs the callback **once** in `createDaemonApp` via `createJiraAutoTransitions(...)` and passes the same function reference into:
  1. `OperationsManager` construction.
  2. The `CreateAgentSessionDeps` factory.
  3. The PATCH handler closure in `extra-routes.ts` (already accepts a deps bag).

A startup-wiring snapshot test asserts that the same callback identity reaches all three sites (see TDD step 6).

### 6. Web app — picker (mandatory extraction)

`apps/web/src/inspector.tsx` is **771 lines** — adding the picker (popover, debounced input, results list with keyboard nav, hover/focus unattach, transition menu, three React Query hooks, empty-state copy, manual-entry fallback) will push it well past 800. Therefore extraction is mandatory:

- Create `apps/web/src/jira-picker.tsx` exporting `<JiraIssuePicker workspaceId issue ... />`. It contains the full new chip behavior:
  - **Unattached state.** A popover trigger that opens a search panel: input field at top (debounced 250 ms), list of results below. Empty input shows recent issues (via `useJiraSearch("")`); non-empty input shows search results. Each row renders `KEY — summary` plus a small status badge. Keyboard: ↑/↓ to navigate, Enter to attach, Esc to close. Below the results, a small text-link: "Enter key manually" — opens the legacy `key + URL` form (preserved from today's `IssueAttachSlot`).
  - **Attached state.** Wrap the chip in a container that exposes a small `×` button on hover **or focus-within**, with `aria-label="Unattach issue"`. The pill becomes a `<button>` opening a transition menu populated from the `IssueTrackerSummary.transitions` field already returned by `/api/workspaces/:workspaceId/cockpit-summary`. Selecting a transition calls the existing `issue-transition` route, optimistically updates the status pill, and rolls back on `degraded`.
  - **Empty-state when `jtk` is unavailable.** When `useJiraSearch` returns `{ status: "degraded" }`, the picker renders an explicit notice ("Jira CLI unavailable — see Settings → Providers") instead of an empty list, with a link to the providers settings route.
- `apps/web/src/inspector.tsx`: replace the existing `IssueAttachSlot` body (lines 329-459) with a one-line mount of `<JiraIssuePicker ... />`. The host component stays in inspector for layout; all picker logic lives in the new file. Confirm inspector drops below 760 after the swap.
- CSS additions live in the existing `apps/web/src/inspector-stats.css` (already owns `.cit-jira` styles). Use existing tokens — no hardcoded hex; chip dark/light theming is being handled separately.

### 7. Web app — query layer

Lives in `apps/web/src/jira-picker.tsx` (or a colocated `apps/web/src/jira-picker-queries.ts` if the picker file approaches 400 lines):

- `useJiraSearch(query: string)` wraps `useQuery({ queryKey: ["jira-search", query], queryFn: () => api("/api/integrations/jira/search?q=..."), staleTime: 5000 })`.
- `useAttachIssue(workspaceId)` and `useUnattachIssue(workspaceId)` mutations PATCH the workspace. Both call `queryClient.invalidateQueries({ queryKey: ["state"] })` and `["cockpit-summary", workspaceId]` on success.
- `useTransitionIssue(workspaceId)` mutation hits the existing `issue-transition` route. Implementation must follow the React Query optimistic-update + rollback recipe **with `cancelQueries`**:
  ```ts
  onMutate: async (next) => {
    await queryClient.cancelQueries({ queryKey: ["cockpit-summary", workspaceId] });
    const previous = queryClient.getQueryData(["cockpit-summary", workspaceId]);
    queryClient.setQueryData(["cockpit-summary", workspaceId], (old) => optimistic(old, next));
    return { previous };
  },
  onError: (_err, _vars, ctx) => ctx && queryClient.setQueryData(["cockpit-summary", workspaceId], ctx.previous),
  onSettled: () => queryClient.invalidateQueries({ queryKey: ["cockpit-summary", workspaceId] }),
  ```
  This eliminates the optimistic → server-cached-old → server-fresh flicker by suspending background refetches for the duration of the mutation.

### 8. Schema or contract generation

No DB schema changes. **No `schema_migrations` row required.** No persistent state is added — recent issues are fetched live, the attached issue continues to live in `workspaces.issue_key / issue_title / issue_url` (migration 4 already added them). `PRAGMA foreign_keys = ON` is unaffected. Existing operator databases continue to run the unchanged schema, so no data-implications statement is needed.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|---|---|---|
| Unit (Vitest) | **Required** | JQL builder (incl. Lucene-special stripping and key-shape routing), search-output parser, transition-name resolver, auto-transition callback (with mocked `transitionJiraIssue`, `collectJiraIssueSummary`, and `store`). Targets ≥90% line coverage on the new code per `docs/contributors/v2-engineering-standards.md`. |
| E2E (Playwright) | **Required** | The change touches an operator-facing cockpit surface (B.2). At minimum: cockpit loads, attach via picker (mocked or stubbed search route), unattach via hover affordance, manual transition click updates the pill. Auto-transition is verified at unit level (E2E would require a fake `jtk` and an agent-start event simulation — over-budget for this iteration). |

### New tests to add

- `packages/providers/src/jira.test.ts` (or extend `packages/providers/src/index.test.ts` if it stays under 800 lines — current file is 574; comfortable for ~10 new test cases):
  - `buildJiraSearchJql returns recent-default JQL with assignee/reporter/watcher disjunction when query is null/empty`.
  - `buildJiraSearchJql routes issue-key-shaped input to a key = "X" JQL` — covers lower-case input ("auth-123" → "AUTH-123").
  - `buildJiraSearchJql strips Lucene-reserved characters from the summary search` — parameterized over `+ - && || ! ( ) { } [ ] ^ " ~ * ? : \ /` and `\n` / `\r`.
  - `buildJiraSearchJql collapses internal whitespace and trims`.
  - `parseJiraSearchOutput parses jtk issues search output into IssueSearchResult[]` — covers row-separator + truncation behavior, missing `updated` field, empty `status`.
  - `searchJiraIssues returns degraded response with empty results on jtk failure` — uses the same "no-real-issue-key" pattern as the existing `collectJiraIssueSummary returns degraded …` test.
  - `searchJiraIssues uses recent-default JQL when query is null/empty`.
  - `resolveJiraTransitionByName matches case-insensitively against transition.name and toStatus`.
- `apps/daemon/src/jira-auto-transitions.test.ts`:
  - `runAutoTransitions fires transitionJiraIssue when agent.started matches a configured entry and workspace has issueKey`.
  - `runAutoTransitions skips when workspace has no issueKey`.
  - `runAutoTransitions skips when issue is already in the target status` (idempotency guard — assert no `transitionJiraIssue` call, expect one `provider.issue_transition.auto.skip` activity row).
  - `runAutoTransitions skips when no autoTransition entry matches the event`.
  - `runAutoTransitions records degraded transitionJiraIssue results in activity without throwing`.
  - `runAutoTransitions records unresolved transition name in activity without throwing`.
  - `runAutoTransitions re-reads workspace from store at dispatch time` (verify it sees a post-emit unattach).
  - `runAutoTransitions invalidates providerCache and re-emits provider.issue_transition on success`.
  - `createJiraAutoTransitions returns the same callback identity across multiple emit events` (single-registration sanity check — guards against double-firing if the wiring is accidentally instantiated twice).
- `apps/daemon/src/jira-routes.test.ts` (or extend `apps/daemon/src/app.test.ts`):
  - `GET /api/integrations/jira/search?q=ABC returns IssueSearchResponse`.
  - `GET /api/integrations/jira/search with no q returns recent results`.
  - `GET /api/integrations/jira/search returns degraded payload (200) when provider fails`.
  - `POST /api/workspaces/:workspaceId/issue-transition still returns 202/424 as before` (regression after extraction).
- `apps/daemon/src/extra-routes.test.ts` (or wherever the workspace-PATCH route is tested):
  - `PATCH /api/workspaces/:workspaceId calls runAutoTransitions("workspace.issue_attached", …) when issueKey transitions from null to a value`.
  - `PATCH /api/workspaces/:workspaceId does NOT call runAutoTransitions when issueKey stays the same`.
  - `PATCH /api/workspaces/:workspaceId does NOT call runAutoTransitions on unattach (null → null or value → null)`.
- `packages/operations/src/create-agent-session.test.ts`:
  - `createAgentSession invokes runAutoTransitions after runNotificationHooks` (assert call order; spy both).
  - `createAgentSession does not throw when runAutoTransitions is undefined` (backward-compat for callers that don't wire it).
  - `createAgentSession does not propagate runAutoTransitions errors to the caller` (wrap a throwing spy; assert session is still returned).
- `apps/web/src/jira-picker.test.tsx` (new):
  - `<JiraIssuePicker> renders the search popover with recent results on click`.
  - `<JiraIssuePicker> debounces search queries (no fetch within 250 ms, latest input wins)`.
  - `<JiraIssuePicker> exposes an unattach button on hover and on keyboard focus when an issue is attached`.
  - `<JiraIssuePicker> transition menu calls the transition route, applies optimistic update, and rolls back on degraded` — uses `cancelQueries` recipe.
  - `<JiraIssuePicker> "Enter key manually" link opens the legacy key+URL form and PATCHes on submit`.
  - `<JiraIssuePicker> renders an explicit notice when search returns degraded` (jtk unavailable).
- `e2e/jira-picker.spec.ts` (new — keeps `operator-cockpit.spec.ts` focused):
  - `operator opens the inspector picker, selects a recent issue, and the chip shows the key`.
  - `operator hovers the attached chip and clicks unattach — the chip returns to the empty state`.
  - `operator picks an available transition and the status pill updates` (uses a route fixture / mock for the `issue-transition` endpoint).

### Existing tests to update

- `packages/providers/src/index.test.ts`: keep the existing Jira tests untouched; add new search tests in a new `describe("searchJiraIssues", …)` block. Per the regression-test gate, extending the existing file is preferred over creating a new one unless line-count pressure forces a split.
- `apps/daemon/src/app.test.ts`: if the Jira-transition assertions check exact response shape, they continue to pass after extraction (handler body is unchanged). If they assert on event ordering, ensure they still pass with the auto-transition path absent (default config has `autoTransitions: []`).
- `packages/operations/src/index.test.ts`: similar dependency-injection updates — pass a no-op `runAutoTransitions` so existing tests stay green; add new cases for the workspace-archive/remove call sites.

### Assertions to add/change/tighten

- Search route: assert `Content-Type: application/json`, `results.length ≤ 20`, every result has a non-empty `key`.
- Search parser: assert it tolerates trailing whitespace, empty status fields, and missing `updated` — the JTK output format is loose.
- JQL builder: assert that `auth + login` becomes `auth login` in the `summary ~` body (specials stripped, not escaped). Assert that `"AUTH-123 OR DROP"` is routed to `summary ~` (not key) because it doesn't match the issue-key regex. Assert newlines never reach the JQL.
- Auto-transition: assert **exactly one** `transitionJiraIssue` call per event (single-fire), and **zero** calls when current status equals target (idempotency).
- UI debounce: assert no search request fires during the 250 ms window; assert the latest input wins when multiple keystrokes overlap.
- UI optimistic update + rollback: assert the pill renders the target status immediately, `cancelQueries` is invoked, and the pill reverts to the previous status when the response is `degraded`.

### Failure modes / edge cases / regression risks

- **`jtk` not installed / not authed.** Search returns `degraded` with empty results. Picker renders the explicit "Jira CLI unavailable" notice with a link to Settings → Providers (covered by a component test).
- **Race: event fires for a workspace that has just been unattached.** `runAutoTransitions` re-reads `issueKey` from the store at dispatch time, not at registration. Covered by a unit test.
- **JQL injection / Lucene parse errors.** Argv mode prevents shell injection; the JQL builder additionally strips the Lucene-reserved set inside `summary ~`. Issue-key-shaped queries route to `key =` (no parser interpretation needed). Covered by parameterized unit tests.
- **Idempotency confusion between transition name and target status name.** The config's `transition` field semantically names the **target status**, not the transition name. The idempotency check compares current `issueStatus` against the target status; the resolver finds the transition by `toStatus`. So "config says `In Progress`, ticket already In Progress" correctly short-circuits regardless of whether the underlying Jira transition is named `Start Progress`, `Move to In Progress`, etc. Covered by a `resolveJiraTransitionByName` test for the case where the transition name differs from the target status name.
- **Agent restart re-fires `agent.started`.** Auto-transition reads current status from `collectJiraIssueSummary` (cached) and skips if it already matches the target. Covered by a unit test.
- **Multi-fire event storms.** The auto-transition config enum explicitly excludes `workspace.created` (fires before issue attach — pure spam) and `workspace.updated` (multi-fire — would burst Jira). The enum is the gate; misconfiguration is rejected at config parse.
- **`workspace.issue_attached`** is a new event. It must fire from **every** code path that writes `issueKey` from null|prev → new non-null. Today there are two: (a) `OperationsManager.createWorkspace` (`index.ts:174` — `input.issueKey ?? null`); (b) `apps/daemon/src/extra-routes.ts:66-88` workspace-PATCH handler. Both are wired in step 5c. Tests assert the fire condition at both call sites and assert no-fire on unattach (value → null) and no-op (value → same value).
- **SSE feedback loop on `provider.issue_transition`.** The auto-transition module emits a **distinct** SSE event (`provider.issue_transition.auto`) so a future operations-layer subscriber to `provider.issue_transition` cannot accidentally trigger another auto-transition. The cockpit listens for both names but the operations layer must never subscribe to either — a comment in `jira-auto-transitions.ts` documents this invariant.
- **Spec divergence.** B.2 item 4 currently marks chip behavior `[x] Shipped`. The same commit that edits the spec text **demotes the marker to `[~]`**; the picker code re-promotes to `[x]` in the same PR. Auditable by reading the diff: if the marker isn't `[x]` and the chip code isn't merged, the PR isn't shippable.
- **`apps/daemon/src/app.ts` file-size cap (804 → must drop below 800).** Mandatory extraction of `jira-routes.ts` (covered in step 4) is verified by `check:size` in the PR.
- **`apps/web/src/inspector.tsx` file-size cap (771 → cannot absorb the picker).** Mandatory extraction of `jira-picker.tsx` (covered in step 6) is verified by `check:size`.
- **`packages/operations/src/index.ts` file-size cap (799 → cannot absorb new dep + invocations).** Mandatory pre-extraction to `packages/operations/src/workspace-lifecycle.ts` (covered in step 5a) drops the file to ≤780 lines before the auto-transition wiring lands. Verified by `check:size` and by an explicit `wc -l` assertion in the Verification section.
- **Hover-only unattach on touch devices.** Hover affordance is paired with `focus-within` so keyboard tabbing also reveals it; `aria-label` is explicit. Component-test coverage.
- **Optimistic update flicker.** `cancelQueries` before `setQueryData` prevents the optimistic → server-cached → server-fresh flicker. Covered by a `<JiraIssuePicker>` test.
- **Cockpit-summary cache after auto-transition.** Auto-transition module invalidates `providerCache.delete("issue:KEY")` and re-emits `provider.issue_transition` so SSE-driven UIs refetch. Covered by a unit test.

### Adversarial analysis

- **How could this fail in production?** (1) `jtk` returns a new output format → search parser silently drops rows → picker looks empty. Mitigated by distinguishing `status: "degraded"` (parse failed / exec failed) from `status: "healthy" + results: []` (no matches) so the UI can render a meaningful empty state. (2) Auto-transition fires for the wrong workspace because the event payload's `workspaceId` was lost — defensive: `runAutoTransitions` re-reads `workspace.issueKey` from the store using the workspace already passed by operations, not from a payload field. (3) Picker debounce regression lets a request fly on every keystroke — covered by an assertion.
- **What user actions trigger unexpected behavior?** Pasting a multiline string into the search input (newline stripping covered); selecting a transition while the pill is still loading (mutation queueing covered); rapid attach → unattach → attach cycles (`invalidateQueries` covers refresh; `cancelQueries` covers transitions).
- **What existing behavior could break?** The free-form `key + URL` form is no longer the primary path — but it remains accessible via the "Enter key manually" link inside the picker. Tests cover the manual-entry path.
- **Which tests credibly catch those failures?** Unit tests for the parser + JQL builder; route tests for the degraded path; auto-transition unit tests for the workspace re-read, idempotency, and unresolved-name paths; component tests for debounce + optimistic rollback; E2E for the operator flow.
- **What gaps remain?** No E2E for auto-transition (would need a fake `jtk` + an injected `agent.started`). Documented as a follow-up — unit coverage of the callback + manual smoke is sufficient for this iteration. Branch-rename-on-attach (B.2 item 4 "not yet implemented") remains out of scope.

## Tests

TDD order (write tests before the implementation each step):

1. `buildJiraSearchJql` + `parseJiraSearchOutput` unit tests.
2. `searchJiraIssues` degraded + recent-default tests.
3. `resolveJiraTransitionByName` tests — matches the configured **target status** against `transition.toStatus` (case-insensitive). Also covers the "transition name in config that does not equal status name" path: `resolveJiraTransitionByName("KEY", "In Progress")` returns the transition id whose `toStatus === "In Progress"`, regardless of the transition's own `name` (e.g., `"Start Progress"`).
4. `createAgentSession` dependency-injection tests (runAutoTransitions called, optional, error-suppressed). **Note:** these tests use a hand-rolled spy matching the `RunAutoTransitions` type — the real implementation arrives in step 5, but the type is defined in contracts/operations and is available immediately, so step 4 is unblocked.
5. `runAutoTransitions` unit tests (fire, skip-no-issue, idempotency-skip when current status matches target status, no-match, degraded-records, unresolved-records, store re-read, cache invalidation + distinct `provider.issue_transition.auto` emit).
6. **Startup-wiring snapshot assertion** in `apps/daemon/src/app.test.ts`: a test that constructs `createDaemonApp(...)` with a stub `createJiraAutoTransitions` factory and asserts the factory is called **exactly once**, that the returned callback reference is passed identically into (a) OperationsManager construction, (b) the `CreateAgentSessionDeps` factory, and (c) the PATCH handler in `extra-routes.ts`. This guards against accidental double-instantiation (which would produce duplicate fires per event) without relying on the factory's own return-value identity.
7. Daemon route tests: `GET /api/integrations/jira/search` (happy + degraded + recent), `POST /api/workspaces/:workspaceId/issue-transition` regression after extraction, `PATCH /api/workspaces/:workspaceId` workspace.issue_attached emission rules (fires on null→value; does NOT fire on value→null or null→null or value→same-value).
8. `OperationsManager.createWorkspace` test: fires `workspace.issue_attached` when `input.issueKey` is non-null; does NOT fire when `input.issueKey` is null.
9. `<JiraIssuePicker>` component tests (popover, debounce, hover/focus unattach, transition menu with `cancelQueries`, manual-entry link, jtk-unavailable empty state).
10. E2E spec(s).

## Schema or contract generation

No schema-generated artifacts to regenerate. Contracts are Zod-first — types flow from `packages/contracts/src/index.ts` via TypeScript; no codegen step. `pnpm -r build` reflects the new types automatically.

## Verification

Before opening the PR (per `.agents/skills/extensions/do-tech-plan.md` Verification commands):

- `make check` — runs `check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage` (≥90% on the new code), `check:deps`, `build`. Explicit `check:size` assertions:
  - `apps/daemon/src/app.ts` < 800 (currently 804 — `jira-routes.ts` extraction drops it).
  - `apps/web/src/inspector.tsx` < 800 (currently 771 — `jira-picker.tsx` extraction keeps it shrinking, not growing).
  - `packages/operations/src/index.ts` ≤ 780 (currently 799 — `workspace-lifecycle.ts` extraction drops it; the ≤780 ceiling guarantees ≥20 lines of headroom for the new constructor dep + invocations).
  - `packages/providers/src/index.ts` < 800 (currently 574 — has room; pre-extract to `jira.ts` if any addition approaches 720).
- `make e2e` — Playwright suite, including the new picker spec(s).
- `make smoke` — required because we add a new daemon HTTP route (`GET /api/integrations/jira/search`) and a new dependency-injected callback that the daemon constructs at startup. Note: smoke verifies **boot-time wiring only** (daemon comes up clean, new route returns a valid response shape). Functional verification of the auto-transition callback is at unit + manual-acceptance level — smoke does not fire `agent.started` against a real Jira.

`make performance` is **not** required — no changes to startup or hot paths; the new route is on-demand and the auto-transition callback only fires on lifecycle events.

## Architectural-boundary check (per the architecture-boundary gate)

- `packages/contracts/**` gets new types (`IssueSearchResultSchema`, `IssueSearchResponseSchema`, the `autoTransitions` member). No new imports — contracts are zod-only.
- `packages/providers/**` gets new functions calling the existing `jtk` helper. No new package imports.
- `packages/operations/**` gets a new injected dependency (`runAutoTransitions`). The dependency is a function type; operations does not import from `@citadel/daemon` or `@citadel/providers`. Pattern matches the existing `runNotificationHooks` injection.
- `apps/daemon/**` imports from `@citadel/providers` and `@citadel/operations` (already does). The new `jira-auto-transitions.ts` and `jira-routes.ts` are daemon-local. No new cross-boundary imports.
- `apps/web/**` calls the daemon via `api(...)` from `@citadel/contracts` shapes. No new daemon imports. New file `apps/web/src/jira-picker.tsx` is a sibling of `inspector.tsx`.

`scripts/checks/architecture-boundaries.ts` should pass unchanged.
