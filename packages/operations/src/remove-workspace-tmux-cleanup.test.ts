import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import {
  killTmuxServer,
  killTmuxSession,
  tmuxPrefix,
  tmuxSessionExists,
  tmuxSocketNameForWorkspace,
} from "@citadel/terminal";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];
const tmuxSessions: Array<{ sessionName: string; socketName: string | null }> = [];
const tmuxServers: string[] = [];

afterEach(() => {
  for (const session of tmuxSessions.splice(0)) killTmuxSession(session.sessionName, session.socketName);
  for (const socketName of tmuxServers.splice(0)) killTmuxServer(socketName);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("removeWorkspace Citadel-owned tmux cleanup", () => {
  it("kills orphan workspace tmux sessions and background runs before deleting a worktree", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "tmux-cleanup", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    if (!workspace) throw new Error("workspace_missing");

    const socketName = tmuxSocketNameForWorkspace(workspace.id);
    const orphanName = `citadel_${workspace.id}_orphan`;
    startTmuxSession(orphanName, workspace.path, socketName);

    const backgroundName = `citadel_bg_${Date.now().toString(36)}`;
    startTmuxSession(backgroundName, workspace.path, null);
    store.insertBackgroundSession({
      id: "bgsess_cleanup",
      scheduledAgentId: "sched_cleanup",
      cwd: workspace.path,
      logFilePath: path.join(fixture.dir, "background.log"),
      tmuxSessionName: backgroundName,
      tmuxSessionId: "$bg",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const removed = await service.removeWorkspace({ workspaceId: workspace.id });

    expect(removed).toMatchObject({ removed: true, archived: false });
    expect(tmuxSessionExists(orphanName, socketName)).toBe(false);
    expect(tmuxSessionExists(backgroundName, null)).toBe(false);
    expect(store.findBackgroundSession("bgsess_cleanup")?.status).toBe("stopped");
    const messages = store
      .listOperations()
      .find((op) => op.id === removed.operationId)
      ?.logs.map((log) => log.message);
    expect(messages?.some((message) => message.includes("orphan Citadel tmux session"))).toBe(true);
    expect(messages?.some((message) => message.includes("background tmux session"))).toBe(true);
  });

  it("checkout removal kills only orphan sessions whose cwd is inside that checkout", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const workspace = await service.createWorkspace({
      mode: "structured",
      rootPath: path.join(fixture.dir, "feature"),
      name: "Feature",
      source: "scratch",
    });
    const checkout = await service.createWorkspaceCheckout({
      workspaceId: workspace.workspaceId,
      repoId: repo.id,
      name: "api",
      source: "default_branch",
      branch: "feature/api",
    });
    const checkoutPath = store.findWorkspaceCheckout(checkout.checkoutId)?.path;
    if (!checkoutPath) throw new Error("checkout_missing");

    const socketName = tmuxSocketNameForWorkspace(workspace.workspaceId);
    const checkoutSession = `citadel_${workspace.workspaceId}_checkout`;
    const homeSession = `citadel_${workspace.workspaceId}_home`;
    startTmuxSession(checkoutSession, checkoutPath, socketName);
    startTmuxSession(homeSession, path.join(fixture.dir, "feature"), socketName);

    const removed = await service.removeWorkspaceCheckout({
      workspaceId: workspace.workspaceId,
      checkoutId: checkout.checkoutId,
    });

    expect(removed).toMatchObject({ removed: true, dirty: false });
    expect(tmuxSessionExists(checkoutSession, socketName)).toBe(false);
    expect(tmuxSessionExists(homeSession, socketName)).toBe(true);
  });
});

function serviceFor(store: SqliteStore) {
  return new OperationService(store, {
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  });
}

function startTmuxSession(sessionName: string, cwd: string, socketName: string | null) {
  execFileSync("tmux", [...tmuxPrefix(socketName), "new-session", "-d", "-s", sessionName, "-c", cwd, "sleep 60"], {
    stdio: "pipe",
  });
  tmuxSessions.push({ sessionName, socketName });
  if (socketName) tmuxServers.push(socketName);
}

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-rm-tmux-"));
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
