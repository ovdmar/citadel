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

describe("removeWorkspace — file-based teardown hook", () => {
  function writeTeardownHook(
    workspacePath: string,
    body: string,
    { executable = true }: { executable?: boolean } = {},
  ) {
    const hookPath = path.join(workspacePath, ".citadel", "hooks", "teardown");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, body);
    if (executable) fs.chmodSync(hookPath, 0o755);
    // Commit the hook AND push it upstream so the workspace doesn't read as
    // dirty (the dirty gate flags both uncommitted files AND unpushed
    // commits, so commit-only would still trip it).
    execFileSync("git", ["add", ".citadel/hooks/teardown"], { cwd: workspacePath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "test: ship teardown hook"], { cwd: workspacePath, stdio: "pipe" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: workspacePath, stdio: "pipe" });
    return hookPath;
  }

  it("runs .citadel/hooks/teardown before tmux session kills and configured teardown", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "File Teardown", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    writeTeardownHook(workspace?.path ?? "", "#!/bin/sh\nprintf 'file-teardown ran\\n'\nexit 0\n");

    const removed = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(removed).toMatchObject({ removed: true, archived: false });
    const op = store.listOperations().find((o) => o.id === removed.operationId);
    expect(op?.status).toBe("succeeded");
    const messages = (op?.logs ?? []).map((entry) => entry.message);
    const fileIdx = messages.findIndex((m) => m.includes("file-teardown ran"));
    const configuredIdx = messages.findIndex((m) => m.startsWith("Running ") && m.includes("teardown hook"));
    const tmuxIdx = messages.findIndex((m) => m.includes("worktree at "));
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(configuredIdx).toBeGreaterThan(fileIdx);
    expect(tmuxIdx).toBeGreaterThan(configuredIdx);
  });

  it("blocks ALL cleanup when file-based teardown fails and force=false", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "File Teardown Block", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    writeTeardownHook(workspace?.path ?? "", "#!/bin/sh\nprintf 'boom\\n' >&2\nexit 5\n");

    const blocked = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(blocked).toMatchObject({ removed: false, archived: false });
    // Worktree, tmux, DB must all be intact.
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(1);

    const op = store.listOperations().find((o) => o.id === blocked.operationId);
    expect(op?.status).toBe("failed");
    expect(op?.error).toMatch(/^file teardown failed:/);
    expect(op?.error).toMatch(/boom/);
    const activityTypes = store.listActivity().map((a) => a.type);
    expect(activityTypes).toContain("workspace.teardown.file.failed");
  });

  it("continues with a warning when file-based teardown fails and force=true", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "File Teardown Force", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    writeTeardownHook(workspace?.path ?? "", "#!/bin/sh\nprintf 'still boom\\n' >&2\nexit 9\n");

    const forced = await service.removeWorkspace({ workspaceId: created.workspaceId, force: true });
    expect(forced).toMatchObject({ removed: true, archived: false });
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);
    const op = store.listOperations().find((o) => o.id === forced.operationId);
    const messages = (op?.logs ?? []).map((entry) => entry.message);
    expect(messages.some((m) => /file teardown failed/.test(m) && /force=true/.test(m))).toBe(true);
  });

  it("skips file teardown when archiveOnly is true even on a dirty worktree", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Dirty Archive", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    const sentinel = path.join(fixture.dir, "should-not-run");
    // Write the hook WITHOUT committing — workspace stays dirty. archiveOnly
    // is the operator's "preserve this on disk" promise; we must not run the
    // destructive teardown even though the operator-intent allowed dirty.
    const hookPath = path.join(workspace?.path ?? "", ".citadel", "hooks", "teardown");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(sentinel)}\n`);
    fs.chmodSync(hookPath, 0o755);

    const archived = await service.removeWorkspace({ workspaceId: created.workspaceId, archiveOnly: true });
    expect(archived).toMatchObject({ archived: true, dirty: true });
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
  });

  it("skips both teardown paths when archiveOnly is true", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const configuredOutput = path.join(fixture.dir, "configured-teardown.flag");
    const service = new OperationService(store, {
      hooks: [
        {
          id: "td-record",
          kind: "command",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(configuredOutput)}, 'ran')`],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: ["td-record"] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Archive Skip", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    const fileOutput = path.join(workspace?.path ?? "", "file-teardown.flag");
    writeTeardownHook(workspace?.path ?? "", `#!/bin/sh\nprintf 'ran' > ${JSON.stringify(fileOutput)}\nexit 0\n`);

    const archived = await service.removeWorkspace({ workspaceId: created.workspaceId, archiveOnly: true });
    expect(archived).toMatchObject({ archived: true, removed: false });
    expect(fs.existsSync(fileOutput)).toBe(false);
    expect(fs.existsSync(configuredOutput)).toBe(false);
  });

  it("emits workspace.teardown.file activity on success", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Activity Pin", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    writeTeardownHook(workspace?.path ?? "", "#!/bin/sh\nexit 0\n");

    await service.removeWorkspace({ workspaceId: created.workspaceId });
    const types = store.listActivity().map((a) => a.type);
    expect(types).toContain("workspace.teardown.file");
  });

  it("configured teardown failure on force=true now logs a warning instead of swallowing silently", async () => {
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
    const created = await service.createWorkspace({ repoId: repo.id, name: "Force Warn", source: "scratch" });
    const forced = await service.removeWorkspace({ workspaceId: created.workspaceId, force: true });
    expect(forced).toMatchObject({ removed: true });
    const op = store.listOperations().find((o) => o.id === forced.operationId);
    const messages = (op?.logs ?? []).map((entry) => entry.message);
    expect(messages.some((m) => /configured teardown failed/.test(m) && /force=true/.test(m))).toBe(true);
  });

  it("configured teardown failure on !force sets error prefixed with 'configured teardown failed:'", async () => {
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
    const created = await service.createWorkspace({ repoId: repo.id, name: "Configured Prefix", source: "scratch" });
    const blocked = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(blocked).toMatchObject({ removed: false });
    const op = store.listOperations().find((o) => o.id === blocked.operationId);
    expect(op?.error).toMatch(/^configured teardown failed:/);
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
