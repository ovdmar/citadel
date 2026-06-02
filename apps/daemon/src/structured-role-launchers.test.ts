import fs from "node:fs";
import path from "node:path";
import { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { createFixture } from "./app-test-helpers.js";
import { launchStructuredRoleAgent } from "./structured-role-launchers.js";

const dirs: string[] = [];
const validPlan = `# Plan

## Delivery Units
API work.

\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "API",
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
Launch implementation.

## Plan Version Notes
Initial.
`;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function createDeps() {
  const fixture = createFixture(dirs);
  const operations = new OperationService(fixture.store, fixture.config);
  return { ...fixture, operations };
}

describe("structured role launchers", () => {
  it("bootstraps a zero-checkout workspace and launches PM on Home", async () => {
    const { config, store, operations } = createDeps();

    const result = await launchStructuredRoleAgent(
      { config, store, operations },
      {
        role: "pm",
        input: { idea: "Coordinate a checkout workflow", workspaceName: "Checkout Workflow", actor: "mcp" },
      },
    );

    expect(result).toMatchObject({ ok: true, checkoutId: null, session: { role: "pm", targetType: "workspace_home" } });
    if (!result.ok) return;
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);
    expect(workspace).toMatchObject({ mode: "structured", lifecyclePhase: "discovery_inputs" });
    expect(store.getWorkspaceManager(result.workspaceId)).toMatchObject({ pauseState: "running" });
    expect(store.listWorkspaceCheckouts(result.workspaceId)).toEqual([]);
    operations.stopWorkspaceSession({ sessionId: result.session.id });
  });

  it("enforces implementation gates before launching checkout-scoped work", async () => {
    const { config, store, operations } = createDeps();
    const rootPath = path.join(config.dataDir, "feature");
    const workspace = await operations.createWorkspace({
      mode: "structured",
      rootPath,
      name: "Feature",
      source: "scratch",
      parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Feature", status: "To Do", fetchedAt: null },
    });
    const timestamp = "2026-06-01T00:00:00.000Z";
    store.insertRepo({
      id: "repo_api",
      name: "API",
      rootPath: path.join(config.dataDir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    store.insertWorkspaceCheckout({
      id: "co_api",
      workspaceId: workspace.workspaceId,
      repoId: "repo_api",
      name: "api",
      path: path.join(rootPath, "api"),
      branch: "feature/api",
      baseBranch: "main",
      issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    await expect(
      launchStructuredRoleAgent(
        { config, store, operations },
        { role: "implementation", input: { checkoutId: "co_api", actor: "mcp" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "approved_plan_required" });

    fs.mkdirSync(path.join(rootPath, "api"), { recursive: true });
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, validPlan);
    operations.registerWorkspacePlan({
      workspaceId: workspace.workspaceId,
      path: planPath,
      status: "approved",
      approvalMode: "manual",
    });

    const launched = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "implementation", input: { checkoutId: "co_api", actor: "mcp" } },
    );

    expect(launched).toMatchObject({
      ok: true,
      checkoutId: "co_api",
      session: { role: "implementation", targetType: "worktree_checkout", checkoutId: "co_api", managed: true },
    });
    if (launched.ok) operations.stopWorkspaceSession({ sessionId: launched.session.id });
  });

  it("blocks automated role launches while the workspace manager is paused", async () => {
    const { config, store, operations } = createDeps();
    const workspace = await operations.createWorkspace({
      mode: "structured",
      rootPath: path.join(config.dataDir, "paused-feature"),
      name: "Paused Feature",
      source: "scratch",
    });
    operations.pauseWorkspaceManager({ workspaceId: workspace.workspaceId });

    await expect(
      launchStructuredRoleAgent(
        { config, store, operations },
        { role: "pm", input: { workspaceId: workspace.workspaceId, actor: "mcp" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "automation_paused" });

    const manual = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "pm", input: { workspaceId: workspace.workspaceId, actor: "human" } },
    );
    expect(manual).toMatchObject({ ok: true, session: { role: "pm" } });
    if (manual.ok) operations.stopWorkspaceSession({ sessionId: manual.session.id });
  });

  it("enforces architect discovery and prototype checkout target rules", async () => {
    const { config, store, operations } = createDeps();
    const rootPath = path.join(config.dataDir, "design-feature");
    const workspace = await operations.createWorkspace({
      mode: "structured",
      rootPath,
      name: "Design Feature",
      source: "scratch",
    });

    await expect(
      launchStructuredRoleAgent(
        { config, store, operations },
        { role: "architect", input: { workspaceId: workspace.workspaceId, planApprovalMode: "manual", actor: "mcp" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "discovery_not_ready" });

    store.database
      .prepare("UPDATE workspaces SET lifecycle_phase = 'architecture' WHERE id = ?")
      .run(workspace.workspaceId);
    const architect = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "architect", input: { workspaceId: workspace.workspaceId, planApprovalMode: "manual", actor: "mcp" } },
    );
    expect(architect).toMatchObject({ ok: true, checkoutId: null, session: { role: "architect" } });
    if (architect.ok) operations.stopWorkspaceSession({ sessionId: architect.session.id });

    await expect(
      launchStructuredRoleAgent(
        { config, store, operations },
        { role: "prototype", input: { cwd: rootPath, actor: "mcp" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "checkout_required" });

    const checkoutPath = path.join(rootPath, "prototype");
    fs.mkdirSync(checkoutPath, { recursive: true });
    store.insertRepo({
      id: "repo_proto",
      name: "Prototype",
      rootPath: path.join(config.dataDir, "repo-proto"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertWorkspaceCheckout({
      id: "co_proto",
      workspaceId: workspace.workspaceId,
      repoId: "repo_proto",
      name: "prototype",
      path: checkoutPath,
      branch: "feature/prototype",
      baseBranch: "main",
      issue: null,
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "prototype",
      gateStatus: "not_started",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      archivedAt: null,
    });
    const prototype = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "prototype", input: { checkoutId: "co_proto", actor: "mcp" } },
    );
    expect(prototype).toMatchObject({ ok: true, checkoutId: "co_proto", session: { role: "prototype" } });
    if (prototype.ok) operations.stopWorkspaceSession({ sessionId: prototype.session.id });
  });
});
