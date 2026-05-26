import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import type { IssueTrackerSummary, IssueTransitionActionResult, Repo, Workspace } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJiraAutoTransitions } from "./jira-auto-transitions.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const now = "2026-05-26T00:00:00.000Z";

function makeRepo(id = "repo_a"): Repo {
  return {
    id,
    name: "Repo A",
    rootPath: "/tmp/repo-a",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/wt",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "ws-a",
    path: "/tmp/wt/ws-a",
    branch: "ws-a",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    issueKey: "AUTH-1",
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "in-progress",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<IssueTrackerSummary> = {}): IssueTrackerSummary {
  return {
    providerId: "jira-jtk",
    status: "healthy",
    reason: null,
    key: "AUTH-1",
    summary: "Title",
    issueStatus: "To Do",
    assignee: null,
    updated: null,
    url: null,
    transitions: [
      { id: "21", name: "Start Progress", toStatus: "In Progress" },
      { id: "31", name: "Done", toStatus: "Done" },
    ],
    checkedAt: now,
    ...overrides,
  };
}

function makeTransitionResult(overrides: Partial<IssueTransitionActionResult> = {}): IssueTransitionActionResult {
  return {
    providerId: "jira-jtk",
    status: "healthy",
    reason: null,
    key: "AUTH-1",
    transition: "21",
    checkedAt: now,
    ...overrides,
  };
}

function createDeps(options: {
  autoTransitions?: Array<{
    event: "agent.started" | "workspace.issue_attached" | "workspace.archived" | "workspace.removed";
    transition: string;
  }>;
  workspaceOverrides?: Partial<Workspace>;
  summary?: IssueTrackerSummary;
  transitionResult?: IssueTransitionActionResult;
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-jat-"));
  dirs.push(dir);
  const config = loadConfig(path.join(dir, "citadel.config.json"));
  config.dataDir = dir;
  config.databasePath = path.join(dir, "db.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: true, command: "jtk", autoTransitions: options.autoTransitions ?? [] },
  };
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  const repo = makeRepo();
  store.insertRepo(repo);
  const workspace = makeWorkspace(options.workspaceOverrides);
  store.insertWorkspace(workspace);

  const collectJiraIssueSummary = vi.fn(async () => options.summary ?? makeSummary());
  const transitionJiraIssue = vi.fn(async () => options.transitionResult ?? makeTransitionResult());
  const resolveJiraTransitionByTargetStatus = vi.fn((transitions, target) => {
    for (const t of transitions) if (t.toStatus.toLowerCase() === target.toLowerCase()) return t.id;
    return null;
  });
  const activity = vi.fn();
  const emit = vi.fn();
  const providerCache = new Map<string, { expiresAt: number; value: unknown }>();

  const runAutoTransitions = createJiraAutoTransitions({
    config,
    providers: {
      collectJiraIssueSummary: collectJiraIssueSummary as never,
      transitionJiraIssue: transitionJiraIssue as never,
      resolveJiraTransitionByTargetStatus: resolveJiraTransitionByTargetStatus as never,
    },
    store,
    activity,
    emit,
    providerCache,
  });

  return {
    runAutoTransitions,
    store,
    repo,
    workspace,
    collectJiraIssueSummary,
    transitionJiraIssue,
    resolveJiraTransitionByTargetStatus,
    activity,
    emit,
    providerCache,
  };
}

describe("createJiraAutoTransitions", () => {
  it("fires transitionJiraIssue when agent.started matches a configured entry and workspace has issueKey", async () => {
    const ctx = createDeps({ autoTransitions: [{ event: "agent.started", transition: "In Progress" }] });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).toHaveBeenCalledTimes(1);
    expect(ctx.transitionJiraIssue).toHaveBeenCalledWith({ issueKey: "AUTH-1", transition: "21" });
    // SSE re-emit uses the DISTINCT name so future operations-layer
    // subscribers to provider.issue_transition can't feedback-loop.
    expect(ctx.emit).toHaveBeenCalledWith(
      "provider.issue_transition.auto",
      expect.objectContaining({ workspaceId: "ws_a", issueKey: "AUTH-1", target: "In Progress" }),
    );
    expect(ctx.providerCache.has("issue:AUTH-1")).toBe(false);
  });

  it("skips when workspace has no issueKey (re-reads from store at dispatch time)", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "In Progress" }],
      workspaceOverrides: { issueKey: null },
    });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
    expect(ctx.collectJiraIssueSummary).not.toHaveBeenCalled();
  });

  it("re-reads workspace.issueKey from the store so a post-emit unattach is honoured", async () => {
    const ctx = createDeps({ autoTransitions: [{ event: "agent.started", transition: "In Progress" }] });
    // Simulate a race: the caller passes a snapshot with an issueKey, but
    // an operator unattached between emit and dispatch.
    ctx.store.updateWorkspace(ctx.workspace.id, { issueKey: null });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
  });

  it("skips with an idempotency log when issue is already in the target status", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "In Progress" }],
      summary: makeSummary({ issueStatus: "In Progress" }),
    });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveBeenCalledWith(
      "provider.issue_transition.auto.skip",
      "system",
      expect.stringContaining("already in"),
      ctx.workspace.repoId,
      ctx.workspace.id,
      null,
    );
  });

  it("returns silently when no autoTransition entry matches the event", async () => {
    const ctx = createDeps({ autoTransitions: [{ event: "workspace.archived", transition: "Done" }] });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
    expect(ctx.collectJiraIssueSummary).not.toHaveBeenCalled();
  });

  it("records degraded transitionJiraIssue results in activity without throwing", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "In Progress" }],
      transitionResult: makeTransitionResult({ status: "degraded", reason: "jtk timeout" }),
    });
    await expect(
      ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, { repo: ctx.repo, workspace: ctx.workspace }),
    ).resolves.toBeUndefined();
    expect(ctx.activity).toHaveBeenCalledWith(
      "provider.issue_transition.auto",
      "system",
      expect.stringContaining("Auto-transition failed"),
      ctx.workspace.repoId,
      ctx.workspace.id,
      null,
    );
  });

  it("records unresolved transition target without throwing", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "Nirvana" }],
    });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveBeenCalledWith(
      "provider.issue_transition.auto.unresolved",
      "system",
      expect.stringContaining("no available transition"),
      ctx.workspace.repoId,
      ctx.workspace.id,
      null,
    );
  });

  it("swallows degraded summary reads without throwing or calling transition", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "In Progress" }],
      summary: makeSummary({ status: "degraded", reason: "jtk unauthed", issueStatus: null }),
    });
    await ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, {
      repo: ctx.repo,
      workspace: ctx.workspace,
    });
    expect(ctx.transitionJiraIssue).not.toHaveBeenCalled();
    expect(ctx.activity).toHaveBeenCalledWith(
      "provider.issue_transition.auto",
      "system",
      expect.stringContaining("Jira summary degraded"),
      ctx.workspace.repoId,
      ctx.workspace.id,
      null,
    );
  });

  it("never throws even when the inner provider call rejects synchronously", async () => {
    const ctx = createDeps({
      autoTransitions: [{ event: "agent.started", transition: "In Progress" }],
    });
    ctx.collectJiraIssueSummary.mockRejectedValueOnce(new Error("boom"));
    await expect(
      ctx.runAutoTransitions("agent.started", ctx.repo, ctx.workspace, { repo: ctx.repo, workspace: ctx.workspace }),
    ).resolves.toBeUndefined();
    expect(ctx.activity).toHaveBeenCalledWith(
      "provider.issue_transition.auto.error",
      "system",
      expect.stringContaining("boom"),
      ctx.workspace.repoId,
      ctx.workspace.id,
      null,
    );
  });
});
