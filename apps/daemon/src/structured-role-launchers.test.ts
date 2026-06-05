import fs from "node:fs";
import path from "node:path";
import { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { agentTemplateDefaultsFromRuntimes, listAgentTemplates, updateRoleTemplate } from "./agent-templates.js";
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
        input: { idea: "Coordinate a checkout workflow", workspaceName: "Checkout Workflow" },
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

  it("launches structured roles with the configured agent runtime and launch settings", async () => {
    const { config, store, operations } = createDeps();
    config.agentRuntimes = [
      {
        id: "codex",
        displayName: "Codex",
        command: "codex",
        args: ["--yolo"],
        resumeArg: "resume",
        launchOptions: {
          models: [{ id: "gpt-5.4", label: "GPT-5.4", default: true, deprecated: false }],
          defaultModel: "gpt-5.4",
          effortValues: ["low", "medium", "high"],
          supportsFastMode: false,
          contextModes: ["standard", "max"],
          modelArgv: { argv: ["-m", "{value}"] },
          effortArgv: { argv: ["-c", "model_reasoning_effort={value}"] },
          contextArgv: { argv: ["-c", "model_context_window={value}"] },
        },
      },
      { id: "claude-code", displayName: "Claude Code", command: "claude", args: [] },
    ];
    const workspace = await operations.createWorkspace({
      mode: "structured",
      rootPath: path.join(config.dataDir, "runtime-feature"),
      name: "Runtime Feature",
      source: "scratch",
    });
    const template = (
      await listAgentTemplates(config.dataDir, agentTemplateDefaultsFromRuntimes(config.agentRuntimes))
    ).find((entry) => entry.role === "pm");
    if (!template) throw new Error("expected PM template");
    const launchSettings = {
      runtimeId: "codex",
      model: "gpt-5.4",
      effort: "high",
      fastMode: null,
      contextMode: "max",
    };
    await updateRoleTemplate(
      config.dataDir,
      "pm",
      { launchSettings, updatedAt: template.updatedAt ?? "" },
      agentTemplateDefaultsFromRuntimes(config.agentRuntimes),
    );
    const calls: Array<{ input: Record<string, unknown>; runtime: Record<string, unknown> }> = [];
    const fakeOperations = {
      createAgentSession: async (input: Record<string, unknown>, runtime: Record<string, unknown>) => {
        calls.push({ input, runtime });
        return {
          id: "sess_codex",
          kind: "agent",
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          displayName: input.displayName,
          targetType: input.targetType,
          checkoutId: null,
          role: input.role,
          actionId: null,
          managed: input.managed,
          parentSessionId: null,
          planVersionId: null,
          managerActionId: null,
          status: "running",
          statusReason: "launched",
          lastStatusAt: "2026-06-01T00:00:00.000Z",
          lastOutputAt: null,
          endedAt: null,
          exitCode: null,
          transport: "disconnected",
          tmuxSessionName: null,
          tmuxSessionId: null,
          tmuxSocketName: null,
          tabId: "tab_codex",
          runtimeSessionId: null,
          launchWarnings: [],
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        };
      },
    } as unknown as OperationService;

    const result = await launchStructuredRoleAgent(
      { config, store, operations: fakeOperations },
      { role: "pm", input: { workspaceId: workspace.workspaceId } },
      { actor: "human" },
    );

    expect(result).toMatchObject({ ok: true, session: { runtimeId: "codex" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      runtimeId: "codex",
      role: "pm",
      targetType: "workspace_home",
      launchSettings,
    });
    expect(calls[0]?.runtime).toMatchObject({
      id: "codex",
      command: "codex",
      args: ["--yolo"],
      displayName: "Codex",
      resumeArg: "resume",
      launchOptions: expect.objectContaining({ defaultModel: "gpt-5.4" }),
    });
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
        { role: "implementation", input: { checkoutId: "co_api" } },
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
      { role: "implementation", input: { checkoutId: "co_api" } },
    );

    expect(launched).toMatchObject({
      ok: true,
      checkoutId: "co_api",
      session: { role: "implementation", targetType: "worktree_checkout", checkoutId: "co_api", managed: true },
    });
    if (launched.ok) operations.stopWorkspaceSession({ sessionId: launched.session.id });
  });

  it("rejects structured implementation launches with a mismatched child issue provider", async () => {
    const { config, store, operations } = createDeps();
    const rootPath = path.join(config.dataDir, "mixed-provider-feature");
    const workspace = await operations.createWorkspace({
      mode: "structured",
      rootPath,
      name: "Mixed Provider Feature",
      source: "scratch",
      parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Feature", status: "To Do", fetchedAt: null },
    });
    const timestamp = "2026-06-01T00:00:00.000Z";
    store.insertRepo({
      id: "repo_mixed",
      name: "API",
      rootPath: path.join(config.dataDir, "repo-mixed"),
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
      id: "co_mixed",
      workspaceId: workspace.workspaceId,
      repoId: "repo_mixed",
      name: "api",
      path: path.join(rootPath, "api"),
      branch: "feature/api",
      baseBranch: "main",
      issue: { provider: "github", key: "12", url: null, title: "API", status: "To Do", fetchedAt: null },
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    fs.mkdirSync(path.join(rootPath, "api"), { recursive: true });
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, validPlan);
    operations.registerWorkspacePlan({
      workspaceId: workspace.workspaceId,
      path: planPath,
      status: "approved",
      approvalMode: "manual",
    });

    await expect(
      launchStructuredRoleAgent(
        { config, store, operations },
        { role: "implementation", input: { checkoutId: "co_mixed" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "ticket_provider_mismatch" });
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
        { role: "pm", input: { workspaceId: workspace.workspaceId } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "automation_paused" });

    const manual = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "pm", input: { workspaceId: workspace.workspaceId } },
      { actor: "human" },
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
        { role: "architect", input: { workspaceId: workspace.workspaceId, planApprovalMode: "manual" } },
      ),
    ).resolves.toMatchObject({ ok: false, error: "discovery_not_ready" });

    store.database
      .prepare("UPDATE workspaces SET lifecycle_phase = 'architecture' WHERE id = ?")
      .run(workspace.workspaceId);
    const architect = await launchStructuredRoleAgent(
      { config, store, operations },
      { role: "architect", input: { workspaceId: workspace.workspaceId, planApprovalMode: "manual" } },
    );
    expect(architect).toMatchObject({ ok: true, checkoutId: null, session: { role: "architect" } });
    if (architect.ok) operations.stopWorkspaceSession({ sessionId: architect.session.id });

    await expect(
      launchStructuredRoleAgent({ config, store, operations }, { role: "prototype", input: { cwd: rootPath } }),
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
      { role: "prototype", input: { checkoutId: "co_proto" } },
    );
    expect(prototype).toMatchObject({ ok: true, checkoutId: "co_proto", session: { role: "prototype" } });
    if (prototype.ok) operations.stopWorkspaceSession({ sessionId: prototype.session.id });
  });
});
