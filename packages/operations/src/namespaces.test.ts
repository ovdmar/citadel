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

    const createResult = service.createNamespace({ name: "MS-100 epic", color: "#aabbcc" });
    expect(createResult.created).toBe(true);
    const namespace = createResult.namespace;
    expect(service.listNamespaces()).toMatchObject([{ id: namespace.id, name: "MS-100 epic" }]);

    // Idempotency: creating again with the same name returns the existing one
    // without erroring, and reports created=false so the caller can tell.
    const idempotent = service.createNamespace({ name: "MS-100 epic" });
    expect(idempotent.created).toBe(false);
    expect(idempotent.namespace.id).toBe(namespace.id);

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

    // Re-creating a namespace with a previously-archived name reactivates the
    // archived row (instead of hitting the UNIQUE(name) constraint).
    const recreated = service.createNamespace({ name: "MS-100 launch", color: "#112233" });
    expect(recreated.created).toBe(true);
    expect(recreated.namespace.id).toBe(namespace.id);
    expect(recreated.namespace.archivedAt).toBeNull();
    expect(recreated.namespace.color).toBe("#112233");
    expect(service.listNamespaces()).toHaveLength(1);
  });

  it("supports explicit restoreNamespace and skips no-op rename activity", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    service.registerRepo({ rootPath: fixture.repoPath });
    const namespace = service.createNamespace({ name: "to-restore" }).namespace;
    service.archiveNamespace(namespace.id);
    expect(service.listNamespaces()).toEqual([]);
    const restored = service.restoreNamespace(namespace.id);
    expect(restored?.archivedAt).toBeNull();
    expect(service.listNamespaces()).toHaveLength(1);

    // No-op patch (no name or color) should not record activity.
    const beforeRename = store.listActivity().length;
    const next = service.renameNamespace(namespace.id, {});
    expect(next?.id).toBe(namespace.id);
    expect(store.listActivity().length).toBe(beforeRename);
  });

  it("createAgentSession reassigns the workspace to the supplied namespaceId", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const namespace = service.createNamespace({ name: "session-target" }).namespace;
    const created = await service.createWorkspace({ repoId: repo.id, name: "ws-x", source: "scratch" });
    expect(store.listWorkspaces().find((entry) => entry.id === created.workspaceId)?.namespaceId).toBeNull();
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "test-agent", namespaceId: namespace.id },
      { command: "bash", args: ["-l"], displayName: "Test Agent" },
    );
    try {
      expect(session.workspaceId).toBe(created.workspaceId);
      const after = store.listWorkspaces().find((entry) => entry.id === created.workspaceId);
      expect(after?.namespaceId).toBe(namespace.id);
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
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

    const namespace = service.createNamespace({ name: "epic" }).namespace;
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
