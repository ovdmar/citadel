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

describe("OperationService", () => {
  it("registers repos, creates workspaces, runs setup hooks, and blocks dirty removal", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const hookOutput = path.join(fixture.dir, "setup-hook.json");
    const service = new OperationService(store, {
      hooks: [
        {
          id: "setup",
          kind: "command",
          event: "workspace.setup",
          command: "node",
          args: ["-e", `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(hookOutput)}))`],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: ["setup"], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Smoke Task", source: "scratch" });
    const workspace = store.listWorkspaces()[0];

    expect(result.workspaceId).toBe(workspace?.id);
    expect(workspace?.lifecycle).toBe("ready");
    expect(fs.existsSync(path.join(workspace?.path ?? "", ".git"))).toBe(true);
    expect(fs.readFileSync(hookOutput, "utf8")).toContain("workspace.setup");

    fs.writeFileSync(path.join(workspace?.path ?? "", "dirty.txt"), "dirty\n");
    const removeResult = await service.removeWorkspace({ workspaceId: result.workspaceId });

    expect(removeResult).toMatchObject({ removed: false, archived: false, dirty: true });
    expect(store.listOperations()[0]?.status).toBe("failed");
  });

  it("archives metadata without deleting dirty worktrees", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Archive Task", source: "scratch" });
    const workspace = store.listWorkspaces()[0];
    fs.writeFileSync(path.join(workspace?.path ?? "", "dirty.txt"), "dirty\n");

    const archived = await service.removeWorkspace({ workspaceId: created.workspaceId, archiveOnly: true });

    expect(archived).toMatchObject({ removed: false, archived: true, dirty: true });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    expect(store.listWorkspaces()).toHaveLength(0);
  });

  it("marks workspace creation failed when a blocking setup hook fails", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "setup-fails",
          kind: "command",
          event: "workspace.setup",
          command: "node",
          args: ["-e", "process.stderr.write('setup denied'); process.exit(12)"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: ["setup-fails"], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Blocked Setup", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);

    expect(workspace?.lifecycle).toBe("failed");
    expect(store.listOperations().find((operation) => operation.id === result.operationId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("setup denied"),
    });
  });

  it("blocks destructive cleanup on teardown failure unless force is explicit", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "teardown-fails",
          kind: "command",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", "process.stderr.write('teardown denied'); process.exit(13)"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: ["teardown-fails"] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Teardown Policy", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);

    const blocked = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(blocked).toMatchObject({ removed: false, archived: false, dirty: false });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    expect(store.listWorkspaces()).toHaveLength(1);

    const forced = await service.removeWorkspace({ workspaceId: created.workspaceId, force: true });
    expect(forced).toMatchObject({ removed: true, archived: false, dirty: false });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(false);
    expect(store.listWorkspaces()).toHaveLength(0);
  });

  it("records notification hook failures without blocking workspace readiness", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "notify-fails",
          kind: "command",
          event: "workspace.created",
          command: "node",
          args: ["-e", "process.stderr.write('notify denied'); process.exit(14)"],
          blocking: false,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Notify Policy", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);

    expect(workspace?.lifecycle).toBe("ready");
    expect(store.listActivity().find((event) => event.type === "hook.workspace.created.failed")).toMatchObject({
      source: "hook",
      message: expect.stringContaining("notify denied"),
    });
  });

  it("records hook-provided workspace links and actions", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "workspace-links",
          kind: "command",
          event: "workspace.created",
          command: "node",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({links:[{label:'Preview',url:'https://example.test/preview',kind:'preview'}],actions:[{id:'redeploy',label:'Redeploy',url:'https://example.test/deploy'}]}))",
          ],
          blocking: false,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Hook Surface", source: "scratch" });

    expect(
      store.listActivity(result.workspaceId).find((event) => event.type === "hook.workspace.created"),
    ).toMatchObject({
      hookOutput: {
        links: [{ label: "Preview", kind: "preview" }],
        actions: [{ id: "redeploy", label: "Redeploy" }],
      },
    });
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-ops-"));
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
