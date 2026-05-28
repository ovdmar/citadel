import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plan registration store", () => {
  it("persists plan_registrations rows and cascades with their workspace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();

    store.insertRepo({
      id: "repo_plan",
      name: "Plan",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertWorkspace({
      id: "ws_plan",
      repoId: "repo_plan",
      name: "plan-ws",
      branch: "fb-plan-ws",
      baseBranch: "main",
      path: path.join(dir, "worktrees", "plan-ws"),
      kind: "worktree",
      lifecycle: "ready",
      dirty: false,
      source: "scratch",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      namespaceId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertPlanRegistration({
      id: "plan-1",
      workspaceId: "ws_plan",
      path: "/tmp/plan/ws/.agents/plans/foo.md",
      summary: "Foo plan",
      registeredAt: "2026-05-17T00:00:00.000Z",
      registeredBySessionId: null,
    });

    const list = store.listPlanRegistrationsForWorkspace("ws_plan");
    expect(list).toHaveLength(1);
    expect(list[0]?.summary).toBe("Foo plan");
    expect(store.findPlanRegistration("plan-1")?.path).toBe("/tmp/plan/ws/.agents/plans/foo.md");

    store.deleteWorkspace("ws_plan");
    expect(store.listPlanRegistrationsForWorkspace("ws_plan")).toEqual([]);
    expect(store.findPlanRegistration("plan-1")).toBeNull();
    expect(store.deletePlanRegistration("missing")).toBe(false);
  });
});
