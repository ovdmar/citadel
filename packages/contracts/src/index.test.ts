import { describe, expect, it } from "vitest";
import {
  AgentRuntimeSchema,
  AgentSessionSchema,
  AppEventSchema,
  CiProviderSummarySchema,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateScheduledAgentInputSchema,
  CreateWorkspaceInputSchema,
  HookOutputSchema,
  IssueTrackerSummarySchema,
  IssueTransitionActionResultSchema,
  OperationSchema,
  ProviderHealthSchema,
  RepoSchema,
  RuntimeUsageSummarySchema,
  UpdateScheduledAgentInputSchema,
  VersionControlSummarySchema,
  WorkspaceDiffSchema,
  WorkspaceSchema,
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
        status: "unavailable",
        reason: "Unsupported on this host",
        model: null,
        remaining: null,
        spend: null,
        resetAt: null,
        checkedAt: timestamp,
      }).runtimeId,
    ).toBe("codex");
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
});
