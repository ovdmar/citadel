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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-manager-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const service = new OperationService(store);
  const rootPath = path.join(dir, "feature");
  fs.mkdirSync(path.join(rootPath, "api"), { recursive: true });
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
    id: "ws_manager",
    repoId: null,
    name: "Manager Workspace",
    path: rootPath,
    rootPath,
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
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
  store.insertWorkspaceCheckout({
    id: "co_api",
    workspaceId: "ws_manager",
    repoId: "repo_api",
    name: "api",
    path: path.join(rootPath, "api"),
    branch: "feature/api",
    baseBranch: "main",
    issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
    intendedPr: {
      provider: "github",
      number: 42,
      url: "https://example.test/pull/42",
      headSha: "abc123",
      baseRef: "main",
      fetchedAt: null,
    },
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  const planPath = path.join(rootPath, "plan.md");
  fs.writeFileSync(planPath, "# Plan\n");
  service.registerWorkspacePlan({
    workspaceId: "ws_manager",
    path: planPath,
    status: "approved",
    approvalMode: "manual",
  });
  return { store, service };
}

describe("workspace manager operations", () => {
  it("starts, pauses, and resumes one durable manager per structured workspace", () => {
    const { store, service } = setup();

    const started = service.startWorkspaceManager({ workspaceId: "ws_manager" });
    expect(started).toMatchObject({ ok: true, created: true, manager: { pauseState: "running" } });
    if (!started.ok) throw new Error("manager did not start");
    const again = service.startWorkspaceManager({ workspaceId: "ws_manager" });
    expect(again).toMatchObject({ ok: true, created: false, manager: { id: started.manager.id } });
    expect(service.pauseWorkspaceManager({ workspaceId: "ws_manager" })).toMatchObject({
      ok: true,
      manager: { pauseState: "paused" },
    });
    expect(service.resumeWorkspaceManager({ workspaceId: "ws_manager" })).toMatchObject({
      ok: true,
      manager: { pauseState: "running" },
    });
    expect(store.listActivity().map((event) => event.type)).toContain("workspace.manager.paused");
  });

  it("evaluates PR review gates and records idempotent ready notifications", () => {
    const { store, service } = setup();
    service.startWorkspaceManager({ workspaceId: "ws_manager" });

    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "review_required",
      reasons: ["review_pr_artifact_required"],
    });

    const marked = service.markCheckoutReadyForReview({ checkoutId: "co_api", notes: "review-pr passed" });
    expect(marked).toMatchObject({ ok: true, gate: { ok: true, status: "ready_for_human_review" } });
    expect(store.findWorkspaceCheckout("co_api")).toMatchObject({ gateStatus: "ready_for_human_review" });
    expect(store.listReviewArtifacts("co_api")).toHaveLength(1);
    expect(store.listManagerEvents("ws_manager")).toHaveLength(1);

    service.markCheckoutReadyForReview({ checkoutId: "co_api", notes: "retry" });
    expect(store.listReviewArtifacts("co_api")).toHaveLength(1);
    expect(store.listManagerEvents("ws_manager")).toHaveLength(1);
  });

  it("updates provider-neutral checkout ticket status locally", () => {
    const { store, service } = setup();

    expect(
      service.updateTicketStatus({
        workspaceId: "ws_manager",
        checkoutId: "co_api",
        issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
        targetState: "in_review",
      }),
    ).toMatchObject({ ok: true, issue: { status: "in_review" }, externalUpdate: "not_configured" });
    expect(store.findWorkspaceCheckout("co_api")?.issue).toMatchObject({ key: "CIT-2", status: "in_review" });
  });
});
