// Integration tests for the extracted `create-workspace` / `remove-workspace`
// modules — covers AC7 (funny-name auto-generation + collision retry) and the
// AC5 dirtySummary attach. Kept separate from `index.test.ts` so the size
// budget on that file isn't pushed past the 800-line gate.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace lifecycle", () => {
  it("attaches dirtySummary to removeWorkspace result when the worktree is dirty", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "DirtyDrop", source: "scratch" });
    const workspace = store.listWorkspaces().find((w) => w.id === created.workspaceId);

    // Make the worktree dirty: untracked file + an additional commit beyond
    // origin/main. Both should show in the dirtySummary.
    fs.writeFileSync(path.join(workspace?.path ?? "", "untracked.txt"), "u\n");
    execFileSync("git", ["add", "untracked.txt"], { cwd: workspace?.path, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "Add untracked file"], { cwd: workspace?.path, stdio: "pipe" });
    fs.writeFileSync(path.join(workspace?.path ?? "", "dirty.txt"), "dirty\n");

    const result = await service.removeWorkspace({ workspaceId: created.workspaceId });

    expect(result.removed).toBe(false);
    expect(result.dirty).toBe(true);
    expect(result.dirtySummary).toBeDefined();
    expect(result.dirtySummary?.files.map((f) => f.path)).toContain("dirty.txt");
    expect((result.dirtySummary?.unpushedCommits.length ?? 0) >= 1).toBe(true);
  });

  it("omits dirtySummary on a successful removeWorkspace (clean worktree)", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "CleanDrop", source: "scratch" });

    const result = await service.removeWorkspace({ workspaceId: created.workspaceId });

    expect(result.removed).toBe(true);
    expect(result.dirty).toBe(false);
    expect(result.dirtySummary).toBeUndefined();
  });

  it("generates a funny-name when input.name is empty (no Jira key)", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    const created = await service.createWorkspace({ repoId: repo.id, name: "", source: "scratch" });
    const workspace = store.listWorkspaces().find((w) => w.id === created.workspaceId);

    // Funny names are kebab-cased two-token strings (e.g. "snappy-otter").
    expect(workspace?.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(workspace?.lifecycle).toBe("ready");
  });

  it("retries on unique-name collision when generating funny-names", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    // Create 8 scratch workspaces with no name; each must succeed despite
    // the unique-name constraint on the workspaces table. Verifies the
    // retry loop produces distinct names (or appends a suffix on the
    // sixth attempt). With a 30×30 dictionary, 8 draws are extremely
    // unlikely to all collide, but the retry path is exercised by the
    // unique-constraint violation when collisions do happen.
    const names = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const created = await service.createWorkspace({ repoId: repo.id, name: "", source: "scratch" });
      const ws = store.listWorkspaces().find((w) => w.id === created.workspaceId);
      expect(ws?.name).toMatch(/^[a-z]+-[a-z]+(-[a-z0-9]{4})?$/);
      names.add(ws?.name ?? "");
    }
    expect(names.size).toBe(8);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-wsl-"));
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
