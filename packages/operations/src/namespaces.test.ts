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

describe("namespace operations", () => {
  it("creates, renames, archives a namespace and assigns/unassigns workspaces", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });

    const namespace = service.createNamespace({ name: "MS-100 epic", color: "#aabbcc" });
    expect(service.listNamespaces()).toMatchObject([{ id: namespace.id, name: "MS-100 epic" }]);

    // Workspace created with namespaceId lands in the namespace.
    const created = await service.createWorkspace({
      repoId: repo.id,
      name: "task-a",
      source: "scratch",
      namespaceId: namespace.id,
    });
    const workspace = store.listWorkspaces().find((entry) => entry.id === created.workspaceId);
    expect(workspace?.namespaceId).toBe(namespace.id);

    // Reassign to null (Uncategorized).
    const detached = service.assignWorkspaceToNamespace({
      workspaceId: created.workspaceId,
      namespaceId: null,
    });
    expect(detached).toMatchObject({ assigned: true, namespaceId: null });
    expect(store.listWorkspaces().find((entry) => entry.id === created.workspaceId)?.namespaceId).toBeNull();

    // Reassign back, then rename the namespace.
    service.assignWorkspaceToNamespace({ workspaceId: created.workspaceId, namespaceId: namespace.id });
    const renamed = service.renameNamespace(namespace.id, { name: "MS-100 launch" });
    expect(renamed?.name).toBe("MS-100 launch");

    // Archiving the namespace detaches workspaces and hides it from default list.
    const archived = service.archiveNamespace(namespace.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(service.listNamespaces()).toEqual([]);
    expect(service.listNamespaces(true)).toHaveLength(1);
    expect(store.listWorkspaces().find((entry) => entry.id === created.workspaceId)?.namespaceId).toBeNull();
  });

  it("rejects assignment to an unknown or archived namespace", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "task-b", source: "scratch" });

    expect(
      service.assignWorkspaceToNamespace({ workspaceId: created.workspaceId, namespaceId: "ns_missing" }),
    ).toMatchObject({ assigned: false, reason: "namespace_not_found" });

    const namespace = service.createNamespace({ name: "epic" });
    service.archiveNamespace(namespace.id);
    expect(
      service.assignWorkspaceToNamespace({ workspaceId: created.workspaceId, namespaceId: namespace.id }),
    ).toMatchObject({ assigned: false, reason: "namespace_archived" });

    expect(service.assignWorkspaceToNamespace({ workspaceId: "ws_missing", namespaceId: null })).toMatchObject({
      assigned: false,
      reason: "workspace_not_found",
    });
  });

  it("rejects workspace creation when the requested namespace is missing or archived", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    await expect(
      service.createWorkspace({ repoId: repo.id, name: "task-c", source: "scratch", namespaceId: "ns_nope" }),
    ).rejects.toThrow(/Unknown namespace/);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-ns-"));
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
