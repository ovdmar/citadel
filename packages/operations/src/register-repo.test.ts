import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("registerRepo", () => {
  it("populates the root workspace root_path during repo registration", () => {
    const fixture = createGitFixture();
    run("git", ["remote", "set-url", "origin", "git@github.com:ovdmar/citadel.git"], fixture.repoPath);
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store);

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const rootWorkspace = store.listWorkspaces(repo.id).find((workspace) => workspace.kind === "root");

    expect(repo).toMatchObject({ providerRepositoryKey: "ovdmar/citadel", showMainWorkspace: false });
    expect(rootWorkspace).toMatchObject({ repoId: repo.id, path: fixture.repoPath, name: "main" });
    expect(store.database.prepare("SELECT root_path FROM workspaces WHERE id = ?").get(rootWorkspace?.id)).toEqual({
      root_path: fixture.repoPath,
    });
  });

  it("rolls back repo registration when the root workspace cannot be created", () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    store.insertRepo({
      id: "repo_existing",
      name: "Existing",
      rootPath: path.join(fixture.dir, "existing"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertWorkspace({
      id: "ws_conflict",
      repoId: "repo_existing",
      name: "conflict",
      path: fixture.repoPath,
      branch: "main",
      baseBranch: "main",
      source: "imported",
      kind: "root",
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
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    const service = new OperationService(store);

    expect(() => service.registerRepo({ rootPath: fixture.repoPath })).toThrow();
    expect(store.database.prepare("SELECT id FROM repos WHERE root_path = ?").all(fixture.repoPath)).toEqual([]);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-register-repo-"));
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
