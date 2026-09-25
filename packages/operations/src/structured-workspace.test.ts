import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];
function validCheckoutPlan(repoId: string) {
  return `# Plan

## Delivery Units
API work.

\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoId": "${repoId}",
      "checkoutName": "api",
      "branch": "feature/api",
      "childIssue": { "provider": "jira", "key": "CIT-2" },
      "dependencies": []
    }
  ]
}
\`\`\`

## Dependencies / Timeline
None.

## Manager Handoff
Create the checkout.

## Plan Version Notes
Initial.
`;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function serviceFor(dir: string, store: SqliteStore) {
  return new OperationService(store, {
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  });
}

describe("structured workspace operations", () => {
  it("creates a zero-checkout structured workspace Home with a manager", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-structured-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const rootPath = path.join(dir, "feature");
    const service = serviceFor(dir, store);

    const created = await service.createWorkspace({
      mode: "structured",
      rootPath,
      name: "Feature",
      source: "scratch",
      parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Feature", status: "To Do", fetchedAt: null },
    });

    expect(store.listWorkspaces()[0]).toMatchObject({
      id: created.workspaceId,
      repoId: null,
      rootPath,
      mode: "structured",
      lifecyclePhase: "discovery_inputs",
    });
    expect(store.getWorkspaceManager(created.workspaceId)).toMatchObject({ pauseState: "running" });
    expect(fs.existsSync(path.join(rootPath, ".citadel", "workspace.json"))).toBe(true);
    expect(store.listWorkspaceCheckouts(created.workspaceId)).toEqual([]);
  });

  it("creates a checkout under the structured workspace root", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(fixture.dir, store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const workspace = await service.createWorkspace({
      mode: "structured",
      rootPath: path.join(fixture.dir, "feature"),
      name: "Feature",
      source: "scratch",
    });
    const planPath = path.join(fixture.dir, "feature", "plan.md");
    fs.writeFileSync(planPath, validCheckoutPlan(repo.id));
    const planResult = service.registerWorkspacePlan({
      workspaceId: workspace.workspaceId,
      path: planPath,
      status: "approved",
      approvalMode: "manual",
    });
    if (!planResult.ok) throw new Error(planResult.error);

    const checkout = await service.createWorkspaceCheckout({
      workspaceId: workspace.workspaceId,
      repoId: repo.id,
      name: "api",
      source: "default_branch",
      branch: "feature/api",
      deliveryUnitKey: "api",
      deliveryPlanVersionId: planResult.planVersion.id,
    });

    const row = store.findWorkspaceCheckout(checkout.checkoutId);
    expect(row).toMatchObject({
      workspaceId: workspace.workspaceId,
      repoId: repo.id,
      name: "api",
      path: path.join(fixture.dir, "feature", "api"),
      branch: "feature/api",
      deliveryUnitKey: "api",
      deliveryPlanVersionId: planResult.planVersion.id,
    });
    expect(fs.existsSync(path.join(row?.path ?? "", ".git"))).toBe(true);
  });

  it("removes a zero-checkout structured workspace Home and its root directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-structured-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const rootPath = path.join(dir, "feature");
    const service = serviceFor(dir, store);
    const created = await service.createWorkspace({
      mode: "structured",
      rootPath,
      name: "Feature",
      source: "scratch",
    });

    const removed = await service.removeWorkspace({ workspaceId: created.workspaceId });

    expect(removed).toMatchObject({ removed: true, archived: false, dirty: false });
    expect(store.listWorkspaces().find((workspace) => workspace.id === created.workspaceId)).toBeUndefined();
    expect(fs.existsSync(rootPath)).toBe(false);
  });

  it("blocks structured workspace Home removal while checkouts remain", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(fixture.dir, store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const workspace = await service.createWorkspace({
      mode: "structured",
      rootPath: path.join(fixture.dir, "feature"),
      name: "Feature",
      source: "scratch",
    });
    await service.createWorkspaceCheckout({
      workspaceId: workspace.workspaceId,
      repoId: repo.id,
      name: "api",
      source: "default_branch",
      branch: "feature/api",
    });

    expect(service.checkWorkspaceRemoval({ workspaceId: workspace.workspaceId })).toMatchObject({
      removable: false,
      reason: "non_empty_workspace",
    });
    const blocked = await service.removeWorkspace({ workspaceId: workspace.workspaceId });
    expect(blocked.removed).toBe(false);
    expect(store.listWorkspaces().find((entry) => entry.id === workspace.workspaceId)).toBeTruthy();
  });

  it("removes an individual structured workspace checkout without removing Home", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(fixture.dir, store);
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
    const checkoutPath = store.findWorkspaceCheckout(checkout.checkoutId)?.path ?? "";

    const removed = await service.removeWorkspaceCheckout({
      workspaceId: workspace.workspaceId,
      checkoutId: checkout.checkoutId,
    });

    expect(removed).toMatchObject({ removed: true, dirty: false });
    expect(store.findWorkspaceCheckout(checkout.checkoutId)).toBeNull();
    expect(store.listWorkspaces().find((entry) => entry.id === workspace.workspaceId)).toBeTruthy();
    expect(fs.existsSync(checkoutPath)).toBe(false);
  });

  it("rejects checkout names that would escape the workspace root", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = serviceFor(fixture.dir, store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const workspace = await service.createWorkspace({
      mode: "structured",
      rootPath: path.join(fixture.dir, "feature"),
      name: "Feature",
      source: "scratch",
    });

    await expect(
      service.createWorkspaceCheckout({
        workspaceId: workspace.workspaceId,
        repoId: repo.id,
        name: "../outside",
        source: "default_branch",
        branch: "feature/outside",
      }),
    ).rejects.toThrow("checkout_name_invalid");
    expect(store.listWorkspaceCheckouts(workspace.workspaceId)).toEqual([]);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-structured-"));
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
