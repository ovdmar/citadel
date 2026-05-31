import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaunchAgentInputSchema } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService, WorkspaceInUseError } from "./index.js";

const dirs: string[] = [];
const tmuxSessions: string[] = [];

afterEach(() => {
  for (const session of tmuxSessions.splice(0)) {
    killTmuxSession(session);
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function shellService() {
  const fixture = createGitFixture();
  const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
  store.migrate();
  const service = new OperationService(store, {
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  });
  return { fixture, store, service };
}

describe("launchAgent", () => {
  describe("input validation", () => {
    it("requires exactly one of repoId or repoName", () => {
      expect(() => LaunchAgentInputSchema.parse({ prompt: "hello" })).toThrow(/repoId or repoName/);
      expect(() => LaunchAgentInputSchema.parse({ prompt: "hello", repoId: "repo_test", repoName: "fixture" })).toThrow(
        /repoId or repoName/,
      );
    });

    it("requires a non-empty prompt", () => {
      expect(() => LaunchAgentInputSchema.parse({ repoId: "repo_test" })).toThrow();
      expect(() => LaunchAgentInputSchema.parse({ repoId: "repo_test", prompt: "" })).toThrow();
    });

    it("defaults runtimeId to claude-code", () => {
      const parsed = LaunchAgentInputSchema.parse({ repoName: "fixture", prompt: "do a thing" });
      expect(parsed.runtimeId).toBe("claude-code");
    });
  });

  it("auto-derives a fresh branch when caller omits branchName", async () => {
    const { fixture, store, service } = shellService();
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    const result = await service.launchAgent(
      { repoId: repo.id, prompt: "do a thing", runtimeId: "shell", workspaceName: "auto-branch" },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    const session = store.listSessions().find((s) => s.id === result.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);

    expect(result.error).toBeUndefined();
    // Auto-derived branch lives in the agent/ namespace, not on repo defaultBranch.
    expect(result.branchName).toMatch(/^agent\/auto-branch-[a-z0-9]{6}$/);
    expect(result.branchName).not.toBe(repo.defaultBranch);
  });

  it("auto-derives a fresh branch when caller passes the repo's default branch", async () => {
    const { fixture, store, service } = shellService();
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    const result = await service.launchAgent(
      {
        repoId: repo.id,
        prompt: "describe",
        runtimeId: "shell",
        workspaceName: "default-branch-coll",
        branchName: repo.defaultBranch,
      },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    const session = store.listSessions().find((s) => s.id === result.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);

    expect(result.error).toBeUndefined();
    expect(result.branchName).toMatch(/^agent\//);
  });

  it("creates a brand-new branch on baseBranch when caller passes an unknown branchName", async () => {
    const { fixture, store, service } = shellService();
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    const result = await service.launchAgent(
      {
        repoId: repo.id,
        prompt: "ship a thing",
        runtimeId: "shell",
        workspaceName: "explicit-new",
        branchName: "fb-fresh-branch",
      },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    const session = store.listSessions().find((s) => s.id === result.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);

    expect(result.error).toBeUndefined();
    expect(result.branchName).toBe("fb-fresh-branch");
  });

  it("is idempotent on (repoId, workspaceName) — second call returns resumed=true with the existing session", async () => {
    const { fixture, store, service } = shellService();
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const runtime = { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" };

    const first = await service.launchAgent(
      { repoId: repo.id, prompt: "first", runtimeId: "shell", workspaceName: "idem" },
      runtime,
    );
    const firstSession = store.listSessions().find((s) => s.id === first.sessionId);
    if (firstSession?.tmuxSessionName) tmuxSessions.push(firstSession.tmuxSessionName);
    expect(first.error).toBeUndefined();
    expect(first.resumed).toBeUndefined();

    const second = await service.launchAgent(
      { repoId: repo.id, prompt: "second", runtimeId: "shell", workspaceName: "idem" },
      runtime,
    );

    expect(second.error).toBeUndefined();
    expect(second.resumed).toBe(true);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("throws WorkspaceInUseError when an existing workspace is not ready", async () => {
    const { fixture, store, service } = shellService();
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const runtime = { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" };
    const created = await service.launchAgent(
      { repoId: repo.id, prompt: "init", runtimeId: "shell", workspaceName: "stuck" },
      runtime,
    );
    const session = store.listSessions().find((s) => s.id === created.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);
    store.updateWorkspaceLifecycle(created.workspaceId, "failed");

    await expect(
      service.launchAgent({ repoId: repo.id, prompt: "retry", runtimeId: "shell", workspaceName: "stuck" }, runtime),
    ).rejects.toBeInstanceOf(WorkspaceInUseError);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-launch-"));
  dirs.push(dir);
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  run("git", ["add", "README.md"], repoPath);
  run("git", ["commit", "-m", "initial"], repoPath);
  run("git", ["branch", "-M", "main"], repoPath);
  run("git", ["push", "-u", "origin", "main"], repoPath);
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoPath);
  return { dir, repoPath };
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
