import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];
const validPlan = (title: string) => `# ${title}

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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-plans-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const service = new OperationService(store);
  const rootPath = path.join(dir, "feature");
  fs.mkdirSync(rootPath, { recursive: true });
  const timestamp = "2026-06-01T00:00:00.000Z";
  store.insertRepo({
    id: "repo_api",
    name: "API",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_plan",
    repoId: null,
    name: "Plan Workspace",
    path: rootPath,
    rootPath,
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "architecture",
    parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Parent", status: "To Do", fetchedAt: null },
    prUrl: null,
    issueKey: "CIT-1",
    issueTitle: "Parent",
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  return { dir, store, service, rootPath };
}

describe("workspace plan operations", () => {
  it("registers approved plan versions and supersedes the previous active plan", () => {
    const { store, service, rootPath } = setup();
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, validPlan("Plan v1"));

    const first = service.registerWorkspacePlan({
      workspaceId: "ws_plan",
      path: planPath,
      status: "approved",
      approvalMode: "manual",
    });

    expect(first).toMatchObject({ ok: true, planVersion: { version: 1, active: true, status: "approved" } });
    if (!first.ok) throw new Error("expected first plan registration to succeed");
    expect(store.listWorkspacePlanDeliveryUnits(first.planVersion.id)).toMatchObject([
      { key: "api", repoName: "API", checkoutName: "api", branch: "feature/api" },
    ]);
    expect(store.listWorkspacePlanDecisions((first as Extract<typeof first, { ok: true }>).planVersion.id)).toEqual([
      expect.objectContaining({ decision: "approve", actor: "human" }),
    ]);

    fs.writeFileSync(planPath, validPlan("Plan v2"));
    const second = service.registerWorkspacePlan({
      workspaceId: "ws_plan",
      path: planPath,
      status: "approved",
      approvalMode: "auto",
    });

    expect(second).toMatchObject({ ok: true, planVersion: { version: 2, active: true, approvalMode: "auto" } });
    expect(store.findActiveWorkspacePlan("ws_plan")).toMatchObject({ version: 2 });
    expect(store.listWorkspacePlanVersions("ws_plan").find((plan) => plan.version === 1)).toMatchObject({
      active: false,
      status: "superseded",
    });
  });

  it("rejects plan artifacts outside the workspace root", () => {
    const { dir, service } = setup();
    const outside = path.join(dir, "outside.md");
    fs.writeFileSync(outside, "# Outside\n");

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        path: outside,
        status: "draft",
        approvalMode: "manual",
      }),
    ).toMatchObject({ ok: false, error: "plan_path_outside_workspace" });
  });

  it("rejects approved plans without required manager handoff sections", () => {
    const { service, rootPath } = setup();
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, "# Thin plan\n");

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        path: planPath,
        status: "approved",
        approvalMode: "manual",
      }),
    ).toMatchObject({ ok: false, error: "plan_structure_invalid" });
  });

  it("rejects approved plans without a machine-readable delivery-unit block", () => {
    const { service, rootPath } = setup();
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(
      planPath,
      `# Missing block

## Delivery Units
API work.

## Dependencies / Timeline
None.

## Manager Handoff
Launch implementation.

## Plan Version Notes
Initial.
`,
    );

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        path: planPath,
        status: "approved",
        approvalMode: "manual",
      }),
    ).toMatchObject({ ok: false, error: "plan_delivery_units_required" });
  });

  it("rejects approved plans with invalid delivery-unit semantics", () => {
    const { service, rootPath } = setup();
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(
      planPath,
      `# Bad block

## Delivery Units
API work.

\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "Missing",
      "checkoutName": "api",
      "branch": "feature/api",
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
`,
    );

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        path: planPath,
        status: "approved",
        approvalMode: "manual",
      }),
    ).toMatchObject({ ok: false, error: "plan_delivery_units_invalid" });
  });

  it("resolves relative plan paths from a validated cwd", () => {
    const { service, rootPath } = setup();
    const plansDir = path.join(rootPath, ".agents", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "feature.md"), validPlan("Feature"));

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        cwd: plansDir,
        path: "feature.md",
        status: "approved",
        approvalMode: "manual",
      }),
    ).toMatchObject({ ok: true, planVersion: { path: path.join(plansDir, "feature.md") } });
  });

  it("does not let agent sessions record manual approval decisions", () => {
    const { service, rootPath } = setup();
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, validPlan("Agent Plan"));

    expect(
      service.registerWorkspacePlan({
        workspaceId: "ws_plan",
        path: planPath,
        status: "approved",
        approvalMode: "manual",
        createdBySessionId: "sess_architect",
      }),
    ).toMatchObject({ ok: false, error: "plan_approval_required" });
  });

  it("resolves cwd context and reports deviations against the active plan", () => {
    const { store, service, rootPath } = setup();
    const checkoutPath = path.join(rootPath, "api");
    fs.mkdirSync(path.join(checkoutPath, "src"), { recursive: true });
    store.insertWorkspaceCheckout({
      id: "co_api",
      workspaceId: "ws_plan",
      repoId: "repo_api",
      name: "api",
      path: checkoutPath,
      branch: "feature/api",
      baseBranch: "main",
      issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
      archivedAt: null,
    });
    const planPath = path.join(rootPath, "plan.md");
    fs.writeFileSync(planPath, validPlan("Plan"));
    const plan = service.registerWorkspacePlan({
      cwd: checkoutPath,
      path: planPath,
      status: "approved",
      approvalMode: "manual",
    });
    expect(plan.ok).toBe(true);

    const context = service.getCitadelContext({ cwd: path.join(checkoutPath, "src") });
    expect(context).toMatchObject({
      ok: true,
      target: { type: "worktree_checkout", checkoutId: "co_api" },
      deliveryUnits: [expect.objectContaining({ key: "api" })],
    });

    const deviation = service.reportPlanDeviation({
      cwd: path.join(checkoutPath, "src"),
      description: "Ticket scope changed",
    });
    expect(deviation).toMatchObject({
      ok: true,
      deviation: { workspaceId: "ws_plan", checkoutId: "co_api", severity: "blocking" },
    });
    expect(store.listPlanDeviationReports("ws_plan")).toHaveLength(1);
  });
});
