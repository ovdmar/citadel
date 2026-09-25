# Citadel Analytics Grill Decisions

Status: in-progress `/grill-me` decision record; user has started overriding prior defaults before implementation planning.

## Problem

Citadel should expose local analytics for agent concurrency and related scheduling signals so scheduled agents can be tuned away from idle gaps and large spikes. The feature must stay self-contained inside Citadel, without another deployment.

## Codebase Findings

- Citadel is a local-first TypeScript app with an Express daemon, React web UI, and SQLite state.
- Workspace-bound sessions live in `agent_sessions`.
- Scheduled background runs live in `background_sessions` and `scheduled_agent_runs`, not `agent_sessions`.
- Session status is already persisted with canonical values: `starting`, `running`, `waiting_for_input`, `rate_limited`, `usage_limited`, `idle`, `stopped`, `failed`, `unknown`.
- The daemon status monitor classifies session state on a 5s default interval.
- Scheduled-agent polling already runs inside the daemon.
- Runtime usage providers already exist for account/limit-style usage, but not reliable per-session context-token history.
- The web app does not currently depend on a charting library.

## Local Evidence

- `packages/db/src/migrate.ts:57` creates `agent_sessions`; `packages/db/src/index.ts:365` lists workspace-bound sessions and `packages/db/src/index.ts:374` inserts them.
- `packages/db/src/index.ts:465` updates `agent_sessions` in place, so historical status transitions are not retained as rows.
- `packages/db/src/migrate.ts:165` creates `scheduled_agent_runs`; `packages/db/src/migrate.ts:182` creates `background_sessions`.
- `packages/db/src/migrate.ts:169` through `packages/db/src/migrate.ts:175` store scheduled-run lifecycle timestamps and links, but not minute-level occupancy samples.
- `packages/db/src/scheduled-run-store.ts:107` lists running scheduled runs, `packages/db/src/scheduled-run-store.ts:113` counts queued runs, `packages/db/src/scheduled-run-store.ts:184` inserts background sessions, and `packages/db/src/scheduled-run-store.ts:213` lists running background sessions.
- `packages/contracts/src/scheduled-agents.ts:23` gives scheduled agents a `runtimeId`; `packages/db/src/index.ts:613` persists it as `scheduled_agents.runtime_id`; background sessions link back via `background_sessions.scheduled_agent_id`.
- `apps/daemon/src/app.ts:664` registers scheduled-agent routes; `apps/daemon/src/scheduled-agent-routes.ts:67` constructs the daemon-side runner and `apps/daemon/src/scheduled-agent-routes.ts:97` starts its poll interval.
- `packages/db/src/migrate.ts:46` stores workspace Jira attribution as `workspaces.issue_key`; `packages/db/src/index.ts:189` inserts it and `packages/db/src/index.ts:245` updates it.
- `packages/operations/src/agent-status.ts:38` and `packages/runtimes/src/status/index.ts:19` define the runtime-observed statuses used by the reducer; `packages/operations/src/agent-status.ts:112` is the single reducer path for status changes.
- `apps/daemon/src/status-monitor-wiring.ts:22` sets the daemon status-monitor default interval to 5000ms; `packages/operations/src/status-monitor.ts:478` starts the guarded interval.
- `packages/operations/src/guarded-interval.ts:20` provides the reusable guarded daemon-loop primitive, with overlap protection and `unref`; `apps/daemon/src/scheduled-agent-routes.ts:96` shows daemon-owned interval polling is already the local pattern.
- `apps/web/src/routes/scheduled-agents.tsx:4` mounts the existing Scheduled Agents page and `apps/web/src/routes/scheduled-agents.tsx:20` labels it as Scheduled agents / Cron-driven runs.
- `apps/daemon/src/scheduled-agent-routes.ts:125` exposes explicit scheduled-agent updates; `packages/operations/src/scheduled-agents.ts:182` validates schedule edits before persisting them.
- `apps/web/src/stage.tsx:427` creates `runtimeId: "shell"` sessions as "Plain Terminal"; `apps/web/src/settings-runtimes.tsx:46` describes Shell as useful for a TTY but not agent work; `apps/web/src/workspace-card.tsx:38` documents that shell sessions are plain terminals, not agents, and excludes them from agent status tones.
- `packages/contracts/src/index.ts:186` defines usage as labeled categories with `percentUsed`, optional reset, and optional section; `packages/runtimes/src/usage/index.ts:7` registers runtime-owned usage fetchers; `packages/providers/src/index.ts:251` normalizes usage collection into `RuntimeUsageSummary`; `packages/providers/src/index.ts:312` documents the external usage contract as `{ label, percentUsed, reset?, section? }`.
- `packages/runtimes/src/transcripts/codex.ts:12` and `packages/runtimes/src/transcripts/codex.test.ts:28` show transcript parsing is prompt/session metadata oriented, not a structured context-token source.
- `apps/web/package.json` dependencies include React, TanStack, Radix, and Lucide, but no charting library.

## Recommended Decisions

1. Primary concurrency metric:
   `active_agents = count(agent_sessions.status = "running" AND agent_sessions.runtime_id != "shell") + count(background_sessions.status = "running" joined to scheduled_agents.runtime_id != "shell")`.
   User-confirmed: foreground `starting`, `waiting_for_input`, `rate_limited`, `usage_limited`, `unknown`, `idle`, `stopped`, and `failed` are not active. Background scheduled sessions count only while `background_sessions.status = "running"`.

2. Show `starting` as a separate initializing series, and show `waiting_for_input`, `rate_limited`, and `usage_limited` as separate blocked/non-progress series.
   User-confirmed: `starting` is not part of the primary active metric.

3. Backfill historical analytics where existing persisted rows support it:
   - Backfill scheduled/background concurrency from `scheduled_agent_runs.started_at -> ended_at`.
   - Backfill foreground session concurrency from retained `agent_sessions.created_at -> ended_at` where rows still exist.
   - Treat missing/deleted historical rows as unknown gaps rather than inventing data.
   User-confirmed: if backfill is possible, do it.
   User-confirmed: label reconstructed historical data as `backfilled`/estimated and post-ship samples as `sampled`.

4. Store raw analytics as one row per 5-minute bucket per observed session/background session for v1 concurrency analytics.

5. Denormalize attribution at sample time:
   `bucketStart`, `entityType`, `sessionId`, `backgroundSessionId`, `status`, `runtimeId`, `runtimeDisplayName`, `repoId`, `repoName`, `workspaceId`, `workspaceName`, `scheduledAgentId`, `scheduledAgentName`, `scheduledRunId`, `issueKey`.

6. Keep enough 5-minute raw/rollup data to support one year of history.

7. Use a daemon-owned 5-minute guarded analytics interval that reads persisted state. Do not couple analytics writes directly to the 5s status monitor.

8. Write a collection heartbeat every minute, even when no sessions are active, so the UI can distinguish "zero active agents" from "no data collected".

9. Sample runtime/account usage hourly into a separate usage snapshot table using existing runtime usage fetchers/providers. For v1, interpret "model usage" as provider-reported runtime usage categories, whose labels may include model scopes, not exact per-session model-token accounting.

10. Make runtime usage sampling best-effort and non-blocking; store degraded rows on failure.

11. Defer exact context usage average/p90/p95/p99 metrics until runtimes expose structured `{ tokensUsed, contextLimit, percentUsed }` values. Do not parse pane text heuristically for v1. When structured data exists, report both percent-of-context and raw token values.

12. Compute rate-limit periods from sampled `rate_limited` and `usage_limited` session states for v1.

13. Include both manual and scheduled sessions in default concurrency charts, with a filter for `all | scheduled | manual`.
    User-confirmed: running background scheduled-agent sessions count in the same primary concurrent-active graph.

14. Add queued scheduled runs as a separate demand/backlog series.

15. Use point-in-time snapshot semantics for minute buckets, not exact seconds-active occupancy.

16. Let very short sessions that start and finish between samples be absent from the concurrency chart, while still counting them in duration/run stats where possible.

17. Compute duration average/p90/p95/p99 metrics from completed records/spans only. User-confirmed: percentile widgets should show p90, p95, and p99 together rather than choosing only one percentile.

18. Prefer continuous active spans from consecutive `running` samples for active-work duration metrics. Keep scheduled-run duration separate as `scheduled_agent_runs.startedAt -> endedAt`.

19. Use 5-minute precision for active-span duration metrics in v1.

20. Put the first UI surface in the primary navigator as `Analytics`, directly above `History`.

21. Support one breakdown dimension at a time:
   `runtime`, `workspace`, `scheduledAgent`, `issueKey`, `status`.

22. Interpret "breakdown by agent" as scheduled-agent definition first. Runtime and individual session are separate drill-down/grouping concepts.

23. Default chart range: last 7 days. Quick switches: `24h`, `7d`, `30d`, `90d`, `1y`.

24. Return zero-filled buckets from analytics APIs using the range-dependent resolution ladder:
    `5m` for ranges `<= 7d`, `1h` for ranges `> 7d and <= 90d`, and `1d` for ranges `> 90d and <= 1y`.

25. Show collection health/gaps in the UI.

26. Add target-band controls for desired minimum/maximum active agents; default minimum is 1.

27. Add summary metrics above the chart:
   `idleMinutesBelowTarget`, `peakActiveAgents`, `minutesAboveTarget`, `rateLimitedMinutes`, `usageLimitedMinutes`, `queuedRunMinutes`.

28. Treat Jira breakdown as the sampled `workspaces.issueKey`; do not call Jira during analytics sampling or query.

29. For background scheduled runs, keep `workspaceId` and `issueKey` null unless the run is explicitly associated with a workspace.

30. Overlay scheduled-run start markers on the concurrency chart.

31. Persist only operational metadata in analytics tables. Do not store prompts, transcripts, or log text.

32. Expose REST + web UI in v1. Defer MCP resources/tools until the schema stabilizes.

33. Use established dashboard/chart libraries for v1 instead of hand-rolled charting. User-confirmed: use Recharts for charts and `react-grid-layout` for the hardcoded widget grid.

34. Keep v1 observability-only. Do not recommend or mutate schedules automatically.

35. Defer export/download and alerts/notifications.

36. Implement analytics as a separate operations/db/daemon module, not inside scheduler logic.

## Proposed V1 Deliverables

1. SQLite analytics tables and retention cleanup.
2. 60s session/background/queued-run sampler with heartbeat.
3. Hourly runtime-usage sampler.
4. REST endpoints:
   - `GET /api/analytics/concurrency`
   - `GET /api/analytics/durations`
   - `GET /api/analytics/runtime-usage`
5. Scheduled Agents analytics tab with chart, filters, summaries, run markers, and collection-gap indicators.
6. Tests for migrations, sampler attribution, aggregation, route validation, and UI rendering.

## Prompt Trace

| Prompt requirement | Covered by decisions |
| --- | --- |
| Timeseries chart of how many agents are running at a given time | 1, 2, 4, 7, 15, 20, 23, 24 |
| Breakdown by agent | 5, 21, 22 |
| Breakdown by workspace | 5, 21 |
| Breakdown by Jira ticket | 5, 21, 28 |
| Tune scheduled agents to avoid spikes and idle gaps | 13, 14, 20, 23, 26, 27, 30, 34 |
| Self-contained within Citadel; no other deployment | 3, 7, 9, 32, 36 |
| Monitor rate-limit periods | 2, 12 |
| Monitor model/runtime usage at 1-hour resolution | 9, 10 |
| One-minute resolution for concurrency | 4, 7, 15, 19 |
| Average/p90/p95 session or agent duration | 17, 18, 19 |
| Average/p90/p95/p99 context usage as percent and tokens | 11 |

## Explicitly Deferred

- Backfilling historical per-minute concurrency.
- Multi-dimensional pivot analytics.
- Context-token average/p90/p95/p99 metrics without structured runtime data.
- Provider rate-limit overlays such as GitHub cooldowns.
- Automatic schedule recommendations or schedule mutation.
- Alerts/notifications.
- Export/download.
- MCP analytics API.

## Completion Audit

Objective: grill the Citadel analytics proposal until the core design decisions are resolved, using codebase inspection where local evidence can answer questions.

| Success criterion | Evidence | Status |
| --- | --- | --- |
| Identify the analytics problem and self-contained constraint | Problem statement and Codebase Findings | Covered |
| Resolve what counts as a running agent | Decisions 1, 2, 13; inspected `agent_sessions`, `background_sessions`, status reducer behavior, and existing UI shell/running/blocked-state treatment; shell terminals are excluded and `starting` is separated from active progress | Resolved by local evidence |
| Resolve time resolution, sampling semantics, and retention | Decisions 3, 4, 6, 7, 8, 15, 16, 19, 24 | Resolved default |
| Resolve supported breakdowns | Decisions 5, 21, 22, 28, 29 | Resolved default |
| Resolve scheduled-agent tuning signals | Decisions 14, 26, 27, 30, 34 | Resolved default |
| Resolve rate-limit and runtime/model usage scope | Decisions 9, 10, 12; inspected runtime usage providers | Resolved default |
| Resolve duration and context usage metrics, including averages and requested percentiles | Decisions 11, 17, 18, 19; inspected transcript/runtime status data | Resolved default |
| Resolve UI and API surface | Decisions 20, 23, 25, 32, 33, 35 | Resolved default |
| Resolve implementation boundary | Decisions 31, 36 | Resolved default |
| Confirm decisions with the user | Confirmation Needed section | Missing |

Result: the grill has produced a complete recommended decision set. The remaining open item is user sign-off on the resolved defaults or explicit changes.

## High-Impact Decisions To Confirm

All high-impact defaults have been resolved in this record. User sign-off is still required before implementation planning.

## Resolved Grill Checkpoints

- Decision 1: resolved by local evidence. `active_agents` counts only non-shell `running` agent/background sessions; shell terminals are excluded; `starting` and blocked states are separate series.
- Decision 3: resolved by local evidence. V1 analytics is forward-looking only because existing rows do not preserve minute-level historical status samples; inferred backfill would be visually distinct if ever added later.
- Decisions 4 and 7: resolved by prompt requirement plus local architecture. Concurrency samples are written once per minute by a daemon-owned guarded analytics interval, separate from the existing 5s status monitor.
- Decision 9: resolved by local contract. V1 "model usage" means hourly provider-reported runtime usage categories, not exact per-session model-token accounting.
- Decision 11: resolved by local evidence. Exact context average/p90/p95/p99 metrics are deferred until runtimes expose structured token/context data; current usage/transcript/status paths do not provide it reliably.
- Decisions 13 and 20: resolved by goal fit and existing UI. Default analytics include manual plus scheduled non-shell sessions, with filters, and the first UI surface lives under Scheduled Agents / Analytics.
- Decision 21: resolved as v1 scope. Support one breakdown dimension at a time across the requested dimensions; defer multi-dimensional pivoting until the basic analytics surface is proven.
- Decisions 26 and 34: resolved as v1 scope and safety boundary. V1 provides target bands and observability only; it does not automatically recommend or mutate schedules.

## Current Grill Checkpoint

Open question: global sign-off.

Accept decisions 1-36 as the resolved Citadel analytics defaults?

Recommended answer: yes.

Tradeoff: implementation can proceed from these defaults. Any changes should be listed by decision number before planning starts.

If rejected: list the decision numbers to change, with replacement choices.

## Confirmation Needed

The grill resolved code-answerable questions from local evidence and resolved the remaining product-shape questions as conservative v1 defaults. Before implementation planning, confirm:

- Accept all recommended decisions as defaults, or list decision numbers to change.
- Confirm whether a technical plan should be created from this record.

Suggested sign-off:

> Accept decisions 1-36 as the resolved Citadel analytics defaults. Create the technical plan next.

Alternative sign-off:

> Change decisions: <numbers and replacement choices>. Do not create the technical plan yet.
