import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationService, type RunAutoTransitionsDep } from "./index.js";

// Wiring tests for the runAutoTransitions dependency injected into
// OperationService. Lives in its own file because operations/src/
// index.test.ts is at the 800-line file-size cap. Covers the
// createWorkspace + workspace-lifecycle paths; the agent.started path is
// covered by the jira-auto-transitions module's own unit tests.

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OperationService runAutoTransitions wiring", () => {
  it("fires workspace.issue_attached, workspace.archived, and workspace.removed at the right call sites", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const spy: ReturnType<typeof vi.fn> & RunAutoTransitionsDep = vi.fn(async () => {}) as ReturnType<typeof vi.fn> &
      RunAutoTransitionsDep;
    const service = new OperationService(
      store,
      {
        hooks: [],
        repoDefaults: { setupHookIds: [], teardownHookIds: [] },
        commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
      },
      spy,
    );
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    // (a) createWorkspace without issueKey — must NOT fire.
    const noIssue = await service.createWorkspace({ repoId: repo.id, name: "no-issue", source: "scratch" });
    expect(spy).not.toHaveBeenCalled();

    // (b) createWorkspace with issueKey — MUST fire workspace.issue_attached.
    spy.mockClear();
    const withIssue = await service.createWorkspace({
      repoId: repo.id,
      name: "with-issue",
      source: "scratch",
      issueKey: "AUTH-1",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("workspace.issue_attached");

    // (c) archive — MUST fire workspace.archived with snapshot issueKey.
    // (The bug fix in jira-auto-transitions.ts relies on the callback
    // receiving the workspace snapshot BEFORE archiveWorkspace clears it
    // from listWorkspaces() — that's verified by reading the snapshot's
    // issueKey here.)
    spy.mockClear();
    const archiveTarget = store.listWorkspaces().find((w) => w.id === withIssue.workspaceId);
    expect(archiveTarget?.issueKey).toBe("AUTH-1");
    fs.writeFileSync(path.join(archiveTarget?.path ?? "", "dirty.txt"), "dirty\n");
    await service.removeWorkspace({ workspaceId: withIssue.workspaceId, archiveOnly: true });
    const archivedCall = spy.mock.calls.find((c) => c[0] === "workspace.archived");
    expect(archivedCall).toBeDefined();
    expect(archivedCall?.[2].issueKey).toBe("AUTH-1");

    // (d) remove (delete) — MUST fire workspace.removed.
    spy.mockClear();
    const removeTarget = store.listWorkspaces().find((w) => w.id === noIssue.workspaceId);
    expect(removeTarget?.issueKey).toBeNull();
    await service.removeWorkspace({ workspaceId: noIssue.workspaceId, force: true });
    const removedCall = spy.mock.calls.find((c) => c[0] === "workspace.removed");
    expect(removedCall).toBeDefined();
  });

  it("does not block workspace creation when runAutoTransitions throws", async () => {
    // The callback wraps its own try/catch; verify defensive try/catch in
    // OperationService doesn't propagate either.
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const throwingSpy: RunAutoTransitionsDep = vi.fn(async () => {
      throw new Error("synthetic auto-transition failure");
    });
    const service = new OperationService(
      store,
      {
        hooks: [],
        repoDefaults: { setupHookIds: [], teardownHookIds: [] },
        commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
      },
      throwingSpy,
    );
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    // createWorkspace with issueKey triggers runAutoTransitions; it must
    // succeed regardless of the callback throwing.
    const result = await service.createWorkspace({
      repoId: repo.id,
      name: "throws-ok",
      source: "scratch",
      issueKey: "X-1",
    });
    expect(result.workspaceId).toBeTruthy();
    const ws = store.listWorkspaces().find((w) => w.id === result.workspaceId);
    expect(ws?.lifecycle).toBe("ready");
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-ops-at-"));
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
