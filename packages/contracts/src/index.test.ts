import { describe, expect, it } from "vitest";
import {
  AgentHookFrontmatterSchema,
  AgentRuntimeSchema,
  AgentSessionSchema,
  AppEventSchema,
  BackgroundAgentSessionSchema,
  CiProviderSummarySchema,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateScheduledAgentInputSchema,
  CreateTerminalSessionInputSchema,
  CreateWorkspaceInputSchema,
  HookEventSchema,
  HookOutputSchema,
  IssueSearchResponseSchema,
  IssueSearchResultSchema,
  IssueTrackerSummarySchema,
  IssueTransitionActionResultSchema,
  JiraAutoTransitionEventSchema,
  JiraAutoTransitionSchema,
  OperationSchema,
  PrMergeStateStatusSchema,
  PrReviewerSchema,
  ProviderHealthSchema,
  PullRequestSummarySchema,
  RecentCommitSchema,
  RepoSchema,
  RuntimeUsageSummarySchema,
  ScheduledAgentRunSchema,
  ScheduledAgentSchema,
  TerminalProfileSchema,
  UpdateScheduledAgentInputSchema,
  VersionControlSummarySchema,
  WorkspaceDiffSchema,
  WorkspaceReadinessSchema,
  WorkspaceRecentCommitsSchema,
  WorkspaceSchema,
  WorkspaceSessionSchema,
  WorkspacesPrStateResponseSchema,
} from "./index.js";

const timestamp = "2026-05-17T00:00:00.000Z";

describe("contract schemas", () => {
  it("validates core repo/workspace/session contracts", () => {
    const repo = RepoSchema.parse({
      id: "repo_test",
      name: "Repo",
      rootPath: "/tmp/repo",
      worktreeParent: "/tmp/worktrees",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const workspace = WorkspaceSchema.parse({
      id: "ws_test",
      repoId: repo.id,
      name: "Workspace",
      path: "/tmp/worktrees/ws",
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      lifecycle: "ready",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const session = AgentSessionSchema.parse({
      id: "sess_test",
      kind: "agent",
      workspaceId: workspace.id,
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "running",
      transport: "connected",
      tmuxSessionName: "citadel_test",
      tmuxSessionId: "$1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(repo.defaultBranch).toBe("main");
    expect(workspace.section).toBe("backlog");
    expect(session.kind).toBe("agent");
    expect(session.runtimeId).toBe("claude-code");
    expect(session.terminalBackend).toBe("tmux");
    const terminal = WorkspaceSessionSchema.parse({
      id: "sess_terminal",
      kind: "terminal",
      workspaceId: workspace.id,
      runtimeId: null,
      displayName: "Terminal",
      status: "running",
      transport: "connected",
      tmuxSessionName: "citadel_terminal",
      tmuxSessionId: "$2",
      terminalBackend: "pty-daemon",
      ptySessionId: "pty_sess_terminal",
      ptyOwnerSocket: "/tmp/citadel/pty.sock",
      ptyOwnerPid: 1234,
      ptyLastSeenAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(terminal.kind).toBe("terminal");
    expect(terminal.terminalBackend).toBe("pty-daemon");
    expect(terminal.ptySessionId).toBe("pty_sess_terminal");
    expect(WorkspaceSessionSchema.safeParse({ ...terminal, runtimeId: "codex" }).success).toBe(false);
  });

  it("validates command inputs and provider/status contracts", () => {
    expect(CreateRepoInputSchema.parse({ rootPath: "/tmp/repo" }).rootPath).toBe("/tmp/repo");
    expect(CreateWorkspaceInputSchema.parse({ repoId: "repo_test", name: "Work" }).source).toBe("scratch");
    expect(CreateAgentSessionInputSchema.parse({ workspaceId: "ws_test", runtimeId: "codex" }).runtimeId).toBe("codex");
    expect(CreateTerminalSessionInputSchema.parse({ workspaceId: "ws_test" }).workspaceId).toBe("ws_test");

    expect(
      ProviderHealthSchema.parse({
        id: "github-gh",
        kind: "version-control",
        displayName: "GitHub",
        status: "healthy",
        checkedAt: timestamp,
      }).reason,
    ).toBeNull();
  });

  it("validates operations, events, diffs, runtimes, and version-control summaries", () => {
    expect(
      OperationSchema.parse({
        id: "op_test",
        type: "workspace.create",
        status: "succeeded",
        progress: 100,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).repoId,
    ).toBeNull();
    expect(
      AppEventSchema.parse({
        id: "evt_test",
        type: "workspace.updated",
        timestamp,
        source: "daemon",
        payload: { ok: true },
      }).type,
    ).toBe("workspace.updated");
    expect(
      AgentRuntimeSchema.parse({
        id: "codex",
        displayName: "Codex",
        command: "codex",
        health: "healthy",
        capabilities: {
          supportsPrompt: true,
          supportsResume: true,
          supportsModelSelection: false,
          supportsTranscript: false,
          supportsStatusDetection: true,
          supportsNonInteractiveGoal: true,
          supportsShell: true,
          supportsUsage: false,
        },
      }).args,
    ).toEqual([]);
    expect(TerminalProfileSchema.parse({ displayName: "Terminal", command: "bash", args: ["-l"] }).args).toEqual([
      "-l",
    ]);
    expect(WorkspaceDiffSchema.parse({ workspaceId: "ws_test", clean: true, files: [], truncated: false }).clean).toBe(
      true,
    );
    expect(
      VersionControlSummarySchema.parse({
        providerId: "github-gh",
        status: "healthy",
        reason: null,
        defaultBranch: "main",
        currentBranch: "main",
        remotes: ["origin"],
        pullRequest: null,
        checkedAt: timestamp,
      }).remotes,
    ).toEqual(["origin"]);
    // cooldownUntil is optional — omitting it parses cleanly (older daemons).
    expect(
      VersionControlSummarySchema.parse({
        providerId: "github-gh",
        status: "healthy",
        reason: null,
        defaultBranch: "main",
        currentBranch: "main",
        remotes: ["origin"],
        pullRequest: null,
        checkedAt: timestamp,
      }).cooldownUntil,
    ).toBeUndefined();
    // cooldownUntil accepts an ISO timestamp when the daemon's gh cooldown is active.
    expect(
      VersionControlSummarySchema.parse({
        providerId: "github-gh",
        status: "degraded",
        reason: "gh rate-limited",
        defaultBranch: "main",
        currentBranch: "main",
        remotes: ["origin"],
        pullRequest: null,
        checkedAt: timestamp,
        cooldownUntil: "2026-05-26T20:30:00.000Z",
      }).cooldownUntil,
    ).toBe("2026-05-26T20:30:00.000Z");
    // cooldownUntil accepts null (explicit "no cooldown").
    expect(
      VersionControlSummarySchema.parse({
        providerId: "github-gh",
        status: "healthy",
        reason: null,
        defaultBranch: "main",
        currentBranch: "main",
        remotes: ["origin"],
        pullRequest: null,
        checkedAt: timestamp,
        cooldownUntil: null,
      }).cooldownUntil,
    ).toBeNull();
    expect(
      CiProviderSummarySchema.parse({
        providerId: "github-gh",
        status: "healthy",
        reason: null,
        runs: [
          {
            providerId: "github-gh",
            id: "123",
            name: "CI",
            status: "completed",
            conclusion: "success",
            branch: "main",
            event: "push",
            url: "https://example.test/run/123",
            createdAt: timestamp,
          },
        ],
        checkedAt: timestamp,
      }).runs[0]?.conclusion,
    ).toBe("success");
    expect(
      RuntimeUsageSummarySchema.parse({
        runtimeId: "codex",
        providerId: "usage-codex",
        source: "codex-usage",
        status: "healthy",
        reason: null,
        categories: [
          { label: "5h limit", percentUsed: 0, reset: "10:00", section: null },
          {
            label: "Weekly limit",
            percentUsed: 90,
            reset: "21:32 on 30 May",
            section: "GPT-5.3-Codex-Spark limit",
          },
        ],
        checkedAt: timestamp,
      }).categories[1]?.section,
    ).toBe("GPT-5.3-Codex-Spark limit");
    expect(
      HookOutputSchema.parse({
        links: [{ label: "Preview", url: "https://example.test/preview", kind: "preview" }],
        actions: [{ id: "redeploy", label: "Redeploy", url: "https://example.test/deploy" }],
      }),
    ).toMatchObject({
      links: [{ label: "Preview", kind: "preview" }],
      actions: [{ id: "redeploy", description: null }],
    });
    expect(
      IssueTrackerSummarySchema.parse({
        providerId: "jira-jtk",
        status: "healthy",
        reason: null,
        key: "MS-496",
        summary: "Campaign",
        issueStatus: "In Progress",
        assignee: "Unassigned",
        updated: "2026-05-17",
        url: null,
        transitions: [{ id: "31", name: "Done", toStatus: "Done" }],
        checkedAt: timestamp,
      }).transitions[0]?.toStatus,
    ).toBe("Done");
    expect(
      IssueTransitionActionResultSchema.parse({
        providerId: "jira-jtk",
        status: "healthy",
        reason: null,
        key: "MS-496",
        transition: "31",
        checkedAt: timestamp,
      }).transition,
    ).toBe("31");
  });

  it("validates the Jira picker search-result and search-response shapes", () => {
    expect(
      IssueSearchResultSchema.parse({
        key: "MS-1",
        summary: "Pick me",
        status: "In Progress",
        url: "https://jira.example/browse/MS-1",
        updated: timestamp,
      }).key,
    ).toBe("MS-1");
    // `key` is the only required field — every other field tolerates null,
    // matching jtk's loose output (older jtk omits `updated`, statuses can
    // be empty during transitions).
    expect(
      IssueSearchResultSchema.parse({ key: "MS-2", summary: null, status: null, url: null, updated: null }).summary,
    ).toBeNull();
    expect(IssueSearchResultSchema.safeParse({ key: "" }).success).toBe(false);

    const response = IssueSearchResponseSchema.parse({
      status: "healthy",
      reason: null,
      results: [{ key: "MS-1", summary: "Pick me", status: "In Progress", url: null, updated: timestamp }],
    });
    expect(response.results).toHaveLength(1);

    // Degraded responses carry an empty results array + a reason — the
    // picker UI distinguishes "search failed" from "search returned no
    // matches".
    expect(IssueSearchResponseSchema.parse({ status: "degraded", reason: "jtk not found", results: [] }).status).toBe(
      "degraded",
    );
  });

  it("rejects auto-transition events outside the supported enum", () => {
    expect(JiraAutoTransitionEventSchema.safeParse("agent.started").success).toBe(true);
    expect(JiraAutoTransitionEventSchema.safeParse("workspace.issue_attached").success).toBe(true);
    expect(JiraAutoTransitionEventSchema.safeParse("workspace.archived").success).toBe(true);
    expect(JiraAutoTransitionEventSchema.safeParse("workspace.removed").success).toBe(true);
    // Deliberately excluded — fires before any issue can be attached.
    expect(JiraAutoTransitionEventSchema.safeParse("workspace.created").success).toBe(false);
    // Deliberately excluded — multi-fire, would burst Jira.
    expect(JiraAutoTransitionEventSchema.safeParse("workspace.updated").success).toBe(false);

    expect(JiraAutoTransitionSchema.parse({ event: "agent.started", transition: "In Progress" }).transition).toBe(
      "In Progress",
    );
    expect(JiraAutoTransitionSchema.safeParse({ event: "agent.started", transition: "" }).success).toBe(false);
  });

  it("requires cron for recurring scheduled agents and runAt for one-shots", () => {
    const base = {
      name: "Sweep",
      repoId: "repo_test",
      runtimeId: "claude-code",
      workspaceStrategy: "new" as const,
      workspaceName: "sweep",
    };

    // Recurring (default) needs cron.
    const missingCron = CreateScheduledAgentInputSchema.safeParse(base);
    expect(missingCron.success).toBe(false);
    if (!missingCron.success) {
      const issue = missingCron.error.issues.find((entry) => entry.path[0] === "cron");
      expect(issue?.message).toMatch(/cron/);
    }

    // One-shot needs runAt.
    const missingRunAt = CreateScheduledAgentInputSchema.safeParse({ ...base, scheduleType: "once" });
    expect(missingRunAt.success).toBe(false);
    if (!missingRunAt.success) {
      const issue = missingRunAt.error.issues.find((entry) => entry.path[0] === "runAt");
      expect(issue?.message).toMatch(/runAt/);
    }

    // Recurring with cron is accepted.
    expect(CreateScheduledAgentInputSchema.safeParse({ ...base, cron: "0 9 * * *" }).success).toBe(true);

    // One-shot with runAt is accepted.
    expect(
      CreateScheduledAgentInputSchema.safeParse({
        ...base,
        scheduleType: "once",
        runAt: "2030-01-01T09:00:00.000Z",
      }).success,
    ).toBe(true);

    // PATCH schema is partial and skips the refinement so a single-field
    // toggle (e.g. enabled) is always valid.
    expect(UpdateScheduledAgentInputSchema.safeParse({ enabled: false }).success).toBe(true);
    // PATCH still rejects a malformed runAt.
    expect(UpdateScheduledAgentInputSchema.safeParse({ runAt: "not-a-date" }).success).toBe(false);
  });

  it("accepts runMode/backgroundCwd/overlapPolicy with sensible defaults", () => {
    const base = {
      name: "BG",
      cron: "0 9 * * *",
      repoId: "repo_test",
      runtimeId: "codex",
      workspaceStrategy: "new" as const,
      workspaceName: "bg-prefix",
    };

    // Defaults: runMode='workspace', overlapPolicy='skip', backgroundCwd=null.
    const parsed = CreateScheduledAgentInputSchema.parse(base);
    expect(parsed.runMode).toBeUndefined(); // optional on input — defaults applied at the entity layer
    expect(parsed.overlapPolicy).toBeUndefined();
    expect(parsed.backgroundCwd).toBeUndefined();

    // Background runMode with backgroundCwd accepted.
    expect(
      CreateScheduledAgentInputSchema.safeParse({
        ...base,
        runMode: "background",
        backgroundCwd: "/tmp/some/dir",
      }).success,
    ).toBe(true);

    // overlapPolicy accepted on both runModes.
    expect(CreateScheduledAgentInputSchema.safeParse({ ...base, overlapPolicy: "queue" }).success).toBe(true);
    expect(
      CreateScheduledAgentInputSchema.safeParse({
        ...base,
        runMode: "background",
        overlapPolicy: "queue",
      }).success,
    ).toBe(true);

    // PATCH accepts overlapPolicy/runMode/backgroundCwd individually.
    expect(UpdateScheduledAgentInputSchema.safeParse({ overlapPolicy: "queue" }).success).toBe(true);
    expect(UpdateScheduledAgentInputSchema.safeParse({ runMode: "background" }).success).toBe(true);
    expect(UpdateScheduledAgentInputSchema.safeParse({ backgroundCwd: "/elsewhere" }).success).toBe(true);

    // backgroundCwd must be non-empty.
    expect(CreateScheduledAgentInputSchema.safeParse({ ...base, backgroundCwd: "" }).success).toBe(false);
    expect(UpdateScheduledAgentInputSchema.safeParse({ backgroundCwd: "" }).success).toBe(false);

    // The entity schema applies the defaults when reconstructing a stored row.
    const entity = ScheduledAgentSchema.parse({
      id: "sched_test",
      name: "Daily",
      cron: "0 9 * * *",
      repoId: "repo_test",
      runtimeId: "claude-code",
      workspaceStrategy: "new",
      workspaceName: "daily",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(entity.runMode).toBe("workspace");
    expect(entity.overlapPolicy).toBe("skip");
    expect(entity.backgroundCwd).toBeNull();
  });

  it("models ScheduledAgentRun rows distinct from the agent's lastRunStatus cache", () => {
    // The run-row status enum excludes 'never' (every row is an actual fire).
    const queued = ScheduledAgentRunSchema.parse({
      id: "run_test",
      scheduledAgentId: "sched_test",
      status: "queued",
      enqueuedAt: timestamp,
    });
    expect(queued.startedAt).toBeNull();
    expect(queued.endedAt).toBeNull();
    expect(queued.logFilePath).toBeNull();

    expect(
      ScheduledAgentRunSchema.safeParse({
        id: "run_x",
        scheduledAgentId: "sched_x",
        status: "never", // not a valid row status — only on the agent cache.
        enqueuedAt: timestamp,
      }).success,
    ).toBe(false);
  });

  it("models BackgroundAgentSession rows with the minimum reader-driven fields", () => {
    const session = BackgroundAgentSessionSchema.parse({
      id: "bg_test",
      scheduledAgentId: "sched_test",
      cwd: "/tmp/bg",
      logFilePath: "/tmp/logs/run.log",
      tmuxSessionName: "citadel_bg_abc",
      tmuxSessionId: "$1",
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(session.scheduledAgentId).toBe("sched_test");
    expect(session.status).toBe("running");
  });

  it("parses PR commit + parent + merge-strategy fields with sensible defaults", async () => {
    const mod = await import("./index.js");
    const prRoutes = await import("./pr-routes.js");
    const { PullRequestSummarySchema } = mod;
    const {
      ParentPrSchema,
      PrCommitSchema,
      PrMergeRequestSchema,
      PrMergeResponseSchema,
      PrMergeStrategySchema,
      PrRefreshResponseSchema,
      WorkspaceCockpitSummaryBatchRequestSchema,
      WorkspaceCockpitSummaryBatchResponseSchema,
    } = prRoutes;

    // Existing PR payloads without the new fields still parse — additive change.
    const legacyPr = PullRequestSummarySchema.parse({
      number: 1,
      title: "Test",
      url: "https://example.test/pr/1",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
    });
    expect(legacyPr.commits).toEqual([]);
    expect(legacyPr.parentPr).toBeNull();
    expect(legacyPr.mergeable).toBe("unknown");
    expect(legacyPr.allowedMergeStrategies).toEqual([]);

    // PrCommitSchema: checks default to [].
    const commit = PrCommitSchema.parse({
      sha: "1234567890abcdef1234567890abcdef12345678",
      shortSha: "1234567",
      message: "feat: add things",
    });
    expect(commit.checks).toEqual([]);

    // ParentPrSchema requires all four fields.
    expect(() => ParentPrSchema.parse({ number: 1, url: "u", headRefName: "h" })).toThrow();
    expect(
      ParentPrSchema.parse({ number: 42, url: "https://example.test/pr/42", headRefName: "foo", state: "OPEN" }),
    ).toEqual({ number: 42, url: "https://example.test/pr/42", headRefName: "foo", state: "OPEN" });

    // PrMergeStrategySchema constrains to the three gh strategies.
    expect(PrMergeStrategySchema.parse("squash")).toBe("squash");
    expect(() => PrMergeStrategySchema.parse("ff")).toThrow();

    // Discriminated unions: response shapes carry the ok discriminator.
    expect(PrMergeResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(PrMergeResponseSchema.parse({ ok: false, reason: "not_mergeable", detail: "PR has conflicts" })).toEqual({
      ok: false,
      reason: "not_mergeable",
      detail: "PR has conflicts",
    });
    expect(() => PrMergeResponseSchema.parse({ ok: false })).toThrow();

    // PrMergeRequestSchema requires a valid strategy and defaults admin bypass off.
    expect(PrMergeRequestSchema.parse({ strategy: "rebase" })).toEqual({ strategy: "rebase", admin: false });
    expect(PrMergeRequestSchema.parse({ strategy: "squash", admin: true })).toEqual({
      strategy: "squash",
      admin: true,
    });
    expect(() => PrMergeRequestSchema.parse({ strategy: "x" })).toThrow();
    expect(() => PrMergeRequestSchema.parse({ strategy: "squash", admin: "true" })).toThrow();

    // Batch request requires at least one workspace id.
    expect(WorkspaceCockpitSummaryBatchRequestSchema.parse({ ids: ["ws_1"] })).toEqual({ ids: ["ws_1"] });
    expect(() => WorkspaceCockpitSummaryBatchRequestSchema.parse({ ids: [] })).toThrow();
    expect(() => WorkspaceCockpitSummaryBatchRequestSchema.parse({ ids: Array(51).fill("ws") })).toThrow();

    // Batch response: each entry is either {ok:true, summary} or {ok:false, reason}; PrRefresh has a versionControl envelope.
    expect(
      WorkspaceCockpitSummaryBatchResponseSchema.parse({
        summaries: [{ workspaceId: "ws_1", ok: false, reason: "no-remote" }],
      }).summaries[0],
    ).toEqual({ workspaceId: "ws_1", ok: false, reason: "no-remote" });
    expect(() =>
      WorkspaceCockpitSummaryBatchResponseSchema.parse({
        summaries: [{ workspaceId: "ws_1", ok: false }],
      }),
    ).toThrow();

    expect(typeof PrRefreshResponseSchema).toBe("object");
  });

  it("parses PR reviewer + recent-commits schemas with their defaults and rejects malformed inputs", () => {
    // PrReviewer: name defaults to null, login is required, state is constrained.
    expect(PrReviewerSchema.parse({ login: "ovi", state: "approved" })).toEqual({
      login: "ovi",
      name: null,
      state: "approved",
    });
    expect(() => PrReviewerSchema.parse({ login: "ovi", state: "APPROVED" })).toThrow();
    expect(() => PrReviewerSchema.parse({ login: "", state: "approved" })).toThrow();

    // PullRequest reviewers defaults to []; an empty array round-trips.
    const prWithoutReviewers = PullRequestSummarySchema.parse({
      number: 1,
      title: "Test",
      url: "https://example.test/pr/1",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
    });
    expect(prWithoutReviewers.reviewers).toEqual([]);

    // RecentCommit enforces sha length bounds.
    expect(() =>
      RecentCommitSchema.parse({
        sha: "short",
        shortSha: "abcd",
        message: "",
        author: "",
        relativeTime: "",
        isoTime: "",
      }),
    ).toThrow();
    expect(() =>
      RecentCommitSchema.parse({
        sha: "1234567890abcdef",
        shortSha: "abc",
        message: "",
        author: "",
        relativeTime: "",
        isoTime: "",
      }),
    ).toThrow();

    // WorkspaceRecentCommits accepts an empty commit list.
    expect(WorkspaceRecentCommitsSchema.parse({ workspaceId: "ws_test", commits: [] })).toEqual({
      workspaceId: "ws_test",
      commits: [],
    });
  });

  it("surfaces mergeStateStatus/headSha and gates pr-conflicts readiness", () => {
    // PrMergeStateStatusSchema accepts all documented states; .catch("UNKNOWN") maps the rest.
    for (const value of ["CLEAN", "BEHIND", "BLOCKED", "DIRTY", "HAS_HOOKS", "UNKNOWN", "UNSTABLE", "DRAFT"]) {
      expect(PrMergeStateStatusSchema.parse(value)).toBe(value);
    }
    expect(PrMergeStateStatusSchema.parse("FROM_THE_FUTURE")).toBe("UNKNOWN");

    // PullRequestSummary defaults: mergeable=unknown, additive fields null.
    const prMinimal = PullRequestSummarySchema.parse({
      number: 7,
      title: "Test",
      url: "https://example.test/pr/7",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
    });
    expect(prMinimal.mergeable).toBe("unknown");
    expect(prMinimal.mergeStateStatus).toBeNull();
    expect(prMinimal.headSha).toBeNull();

    // PullRequestSummary carries the conflict-detection fields when supplied.
    const prFull = PullRequestSummarySchema.parse({
      number: 8,
      title: "Conflicting",
      url: "https://example.test/pr/8",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
      mergeable: "conflicting",
      mergeStateStatus: "DIRTY",
      headSha: "deadbeef",
    });
    expect(prFull.mergeable).toBe("conflicting");
    expect(prFull.mergeStateStatus).toBe("DIRTY");
    expect(prFull.headSha).toBe("deadbeef");

    // WorkspaceReadinessSchema accepts the new pr-conflicts state.
    expect(
      WorkspaceReadinessSchema.parse({
        state: "pr-conflicts",
        tone: "danger",
        nextAction: "Resolve PR conflicts against main before merging",
        reasons: ["PR branch has merge conflicts with the base branch"],
        freshness: { checkedAt: timestamp, stale: false, degraded: false },
      }).state,
    ).toBe("pr-conflicts");
  });

  it("accepts checkout-level PR state as a backwards-compatible additive response field", () => {
    const legacy = WorkspacesPrStateResponseSchema.parse({ workspacePrState: {} });
    expect(legacy.checkoutPrState).toEqual({});

    const response = WorkspacesPrStateResponseSchema.parse({
      workspacePrState: {},
      checkoutPrState: {
        ws_1: {
          co_1: {
            pullRequest: null,
            ciRuns: [],
            checkedAt: null,
            cachedAt: null,
          },
        },
      },
    });
    expect(response.checkoutPrState.ws_1?.co_1?.pullRequest).toBeNull();
  });
});

describe("HookEventSchema", () => {
  it("accepts all canonical hook events including the new framework events", () => {
    const events = [
      "workspace.setup",
      "workspace.teardown",
      "workspace.apps",
      "workspace.action",
      "workspace.created",
      "workspace.archived",
      "workspace.removed",
      "agent.started",
      "pr.merge",
      "merge.conflict.detected",
      "review.requested",
    ];
    for (const event of events) {
      expect(HookEventSchema.parse(event)).toBe(event);
    }
  });

  it("rejects 'deploy' — deploy is a file-name convention, not a hook event", () => {
    expect(() => HookEventSchema.parse("deploy")).toThrow();
  });

  it("rejects unknown event names", () => {
    expect(() => HookEventSchema.parse("not.a.real.event")).toThrow();
  });
});

describe("AgentHookFrontmatterSchema", () => {
  it("accepts empty frontmatter (all fields optional)", () => {
    expect(AgentHookFrontmatterSchema.parse({})).toEqual({});
  });

  it("accepts runtime and displayName", () => {
    expect(AgentHookFrontmatterSchema.parse({ runtime: "claude-code", displayName: "Hootsuite: notify" })).toEqual({
      runtime: "claude-code",
      displayName: "Hootsuite: notify",
    });
  });

  it("rejects reserved key 'model' (CreateAgentSessionInput has no model field yet; would be silently dropped)", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ model: "opus" })).toThrow();
  });

  it("rejects reserved key 'target' (strict mode catches unknown keys)", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ target: "fresh" })).toThrow();
  });

  it("rejects reserved key 'blocking'", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ blocking: true })).toThrow();
  });

  it("rejects unknown keys (forward-compat: contract is closed)", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ foo: "bar" })).toThrow();
  });

  it("rejects displayName with invalid charset", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ displayName: "no/slashes" })).toThrow();
    expect(() => AgentHookFrontmatterSchema.parse({ displayName: "no\ttabs" })).toThrow();
  });

  it("rejects displayName longer than 80 chars", () => {
    expect(() => AgentHookFrontmatterSchema.parse({ displayName: "x".repeat(81) })).toThrow();
  });
});

describe("CreateAgentSessionInputSchema.operationId", () => {
  it("accepts a session input without operationId (backcompat)", () => {
    expect(() =>
      CreateAgentSessionInputSchema.parse({ workspaceId: "ws_test", runtimeId: "claude-code" }),
    ).not.toThrow();
  });

  it("accepts an optional operationId so hook-dispatched sessions can link to the firing op", () => {
    const parsed = CreateAgentSessionInputSchema.parse({
      workspaceId: "ws_test",
      runtimeId: "claude-code",
      operationId: "op_abc123",
    });
    expect(parsed.operationId).toBe("op_abc123");
  });
});
