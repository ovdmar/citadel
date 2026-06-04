import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixture, createGitFixtureWithRemote } from "./app-test-helpers.js";

vi.mock("@citadel/operations", () => ({
  BranchInUseByWorktreeError: class BranchInUseByWorktreeError extends Error {},
  RemoteRefMissingError: class RemoteRefMissingError extends Error {},
  WorkspaceInUseError: class WorkspaceInUseError extends Error {},
  WorkspaceNameTakenError: class WorkspaceNameTakenError extends Error {},
}));

const { callDaemonMcpTool } = await import("./daemon-mcp-tool.js");

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("daemon review thread MCP tools", () => {
  it("lets agents create, reply to, resolve, and list internal review threads", async () => {
    const fixture = createFixture(dirs);
    const { repoPath } = createReviewGitFixture(fixture.config.dataDir);
    registerReviewCheckout(fixture, repoPath);
    const events: Array<[string, unknown]> = [];
    const deps = {
      config: fixture.config,
      store: fixture.store,
      operations: {} as never,
      scheduledAgents: {} as never,
      scheduledAgentService: {} as never,
      providerCache: new Map(),
      emit: (type: string, payload: unknown) => events.push([type, payload]),
    };

    const created = (await callDaemonMcpTool(
      deps,
      {
        name: "create_review_thread",
        arguments: {
          checkoutId: "checkout_review",
          bucket: "against-base",
          path: "README.md",
          anchorKind: "file",
          body: "Please address before review.",
        },
      },
      { actor: "agent" },
    )) as { thread: { id: string; authorKind: string; status: string } };
    expect(created.thread).toMatchObject({ authorKind: "agent", status: "open" });

    const replied = (await callDaemonMcpTool(
      deps,
      {
        name: "reply_review_thread",
        arguments: {
          threadId: created.thread.id,
          body: "Fixed this.",
          authorLabel: "Implementation agent",
          resolve: true,
        },
      },
      { actor: "agent" },
    )) as { thread: { status: string; replies: unknown[] } };
    expect(replied.thread.status).toBe("resolved");
    expect(replied.thread.replies).toHaveLength(2);

    expect(
      await callDaemonMcpTool(deps, {
        name: "list_review_threads",
        arguments: { checkoutId: "checkout_review" },
      }),
    ).toMatchObject({ threads: [] });
    expect(
      await callDaemonMcpTool(deps, {
        name: "list_review_threads",
        arguments: { checkoutId: "checkout_review", includeResolved: true },
      }),
    ).toMatchObject({ threads: [expect.objectContaining({ id: created.thread.id, status: "resolved" })] });

    expect(events.map(([type]) => type)).toEqual(["review.thread.created", "review.thread.replied"]);
  });
});

function createReviewGitFixture(parent: string) {
  const git = createGitFixtureWithRemote(parent);
  execGit(git.repoPath, ["checkout", "-b", "feature/review"]);
  fs.appendFileSync(path.join(git.repoPath, "README.md"), "committed\n");
  execGit(git.repoPath, ["add", "README.md"]);
  execGit(git.repoPath, ["commit", "-m", "committed change"]);
  return git;
}

function registerReviewCheckout(fixture: ReturnType<typeof createFixture>, repoPath: string) {
  const now = new Date().toISOString();
  fixture.store.insertRepo({
    id: "repo_review",
    name: "Review Repo",
    rootPath: repoPath,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  fixture.store.insertWorkspace({
    id: "ws_review",
    repoId: "repo_review",
    name: "Review Workspace",
    path: path.join(fixture.config.dataDir, "workspace"),
    rootPath: path.join(fixture.config.dataDir, "workspace"),
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
    parentIssue: null,
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  fixture.store.insertWorkspaceCheckout({
    id: "checkout_review",
    workspaceId: "ws_review",
    repoId: "repo_review",
    name: "Review checkout",
    path: repoPath,
    branch: "feature/review",
    baseBranch: "main",
    issue: null,
    intendedPr: {
      provider: "github",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      headSha: null,
      baseRef: "main",
      fetchedAt: now,
      checksGreen: null,
      mergeStateStatus: null,
      hasConflicts: null,
    },
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "review_required",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
}

function execGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
