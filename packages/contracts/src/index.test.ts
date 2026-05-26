import { describe, expect, it } from "vitest";
import {
  AgentRuntimeSchema,
  AgentSessionSchema,
  AgentSessionStatusSchema,
  AppEventSchema,
  BackgroundAgentSessionSchema,
  CiProviderSummarySchema,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateScheduledAgentInputSchema,
  CreateWorkspaceInputSchema,
  HookOutputSchema,
  IssueTrackerSummarySchema,
  IssueTransitionActionResultSchema,
  OperationSchema,
  PrReviewerSchema,
  ProviderHealthSchema,
  PullRequestSummarySchema,
  RateLimitResumptionSchema,
  RecentCommitSchema,
  RepoSchema,
  RuntimeUsageSummarySchema,
  ScheduledAgentRunSchema,
  ScheduledAgentSchema,
  UpdateScheduledAgentInputSchema,
  VersionControlSummarySchema,
  WorkspaceDiffSchema,
  WorkspaceRecentCommitsSchema,
  WorkspaceSchema,
  isAcceptingInputStatus,
  isAliveStatus,
  isInteractiveStatus,
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
      workspaceId: workspace.id,
      runtimeId: "shell",
      displayName: "Shell",
      status: "running",
      transport: "connected",
      tmuxSessionName: "citadel_test",
      tmuxSessionId: "$1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(repo.defaultBranch).toBe("main");
    expect(workspace.section).toBe("backlog");
    expect(session.runtimeId).toBe("shell");
  });

  it("validates command inputs and provider/status contracts", () => {
    expect(CreateRepoInputSchema.parse({ rootPath: "/tmp/repo" }).rootPath).toBe("/tmp/repo");
    expect(CreateWorkspaceInputSchema.parse({ repoId: "repo_test", name: "Work" }).source).toBe("scratch");
    expect(CreateAgentSessionInputSchema.parse({ workspaceId: "ws_test", runtimeId: "shell" }).runtimeId).toBe("shell");

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
        id: "shell",
        displayName: "Shell",
        command: "bash",
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

  it("requires cron for recurring scheduled agents and runAt for one-shots", () => {
    const base = {
      name: "Sweep",
      repoId: "repo_test",
      runtimeId: "shell",
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
      runtimeId: "shell",
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
      runtimeId: "shell",
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

  it("validates the canonical AgentSessionStatus enum and round-trips rate_limited", () => {
    const allValues = ["starting", "running", "waiting_for_input", "idle", "rate_limited", "stopped", "failed", "unknown"];
    for (const value of allValues) {
      expect(AgentSessionStatusSchema.parse(value)).toBe(value);
    }
    expect(() => AgentSessionStatusSchema.parse("waiting")).toThrow();
    expect(() => AgentSessionStatusSchema.parse("orphaned")).toThrow();
    const rl = AgentSessionSchema.parse({
      id: "sess_rl",
      workspaceId: "ws_test",
      runtimeId: "claude-code",
      displayName: "Claude",
      status: "rate_limited",
      statusReason: "rate_limited:2026-05-26T10:00:00.000Z",
      transport: "connected",
      tmuxSessionName: "citadel_rl",
      tmuxSessionId: "$2",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(rl.status).toBe("rate_limited");
    expect(rl.statusReason).toBe("rate_limited:2026-05-26T10:00:00.000Z");
  });

  it("validates RateLimitResumption rows and rejects bad shapes", () => {
    const pending = RateLimitResumptionSchema.parse({
      id: "rlr_test",
      scheduledAt: timestamp,
      createdAt: timestamp,
    });
    expect(pending.status).toBe("pending");
    expect(pending.executedAt).toBeNull();
    const done = RateLimitResumptionSchema.parse({
      id: "rlr_done",
      scheduledAt: timestamp,
      status: "executed",
      createdAt: timestamp,
      executedAt: "2026-05-26T10:01:00.000Z",
    });
    expect(done.status).toBe("executed");
    expect(done.executedAt).toBe("2026-05-26T10:01:00.000Z");
    expect(() =>
      RateLimitResumptionSchema.parse({
        id: "rlr_bad",
        scheduledAt: timestamp,
        status: "queued",
        createdAt: timestamp,
      }),
    ).toThrow();
  });

  it("typed status helpers partition the canonical enum correctly", () => {
    // isInteractiveStatus
    expect(isInteractiveStatus("starting")).toBe(true);
    expect(isInteractiveStatus("running")).toBe(true);
    expect(isInteractiveStatus("waiting_for_input")).toBe(true);
    expect(isInteractiveStatus("idle")).toBe(false);
    expect(isInteractiveStatus("rate_limited")).toBe(false);
    expect(isInteractiveStatus("stopped")).toBe(false);
    expect(isInteractiveStatus("failed")).toBe(false);
    expect(isInteractiveStatus("unknown")).toBe(false);
    // isAliveStatus
    expect(isAliveStatus("starting")).toBe(true);
    expect(isAliveStatus("running")).toBe(true);
    expect(isAliveStatus("waiting_for_input")).toBe(true);
    expect(isAliveStatus("idle")).toBe(true);
    expect(isAliveStatus("rate_limited")).toBe(true);
    expect(isAliveStatus("unknown")).toBe(true);
    expect(isAliveStatus("stopped")).toBe(false);
    expect(isAliveStatus("failed")).toBe(false);
    // isAcceptingInputStatus (rate_limited intentionally excluded)
    expect(isAcceptingInputStatus("starting")).toBe(true);
    expect(isAcceptingInputStatus("running")).toBe(true);
    expect(isAcceptingInputStatus("waiting_for_input")).toBe(true);
    expect(isAcceptingInputStatus("idle")).toBe(true);
    expect(isAcceptingInputStatus("rate_limited")).toBe(false);
    expect(isAcceptingInputStatus("stopped")).toBe(false);
    expect(isAcceptingInputStatus("failed")).toBe(false);
    expect(isAcceptingInputStatus("unknown")).toBe(false);
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
});
