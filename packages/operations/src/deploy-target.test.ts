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

describe("deploy targets", () => {
  it("resolves structured workspace deploy hooks from the selected checkout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-deploy-target-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const now = "2026-06-05T00:00:00.000Z";
    const repoPath = path.join(dir, "repo");
    const workspacePath = path.join(dir, "workspace");
    const checkoutPath = path.join(workspacePath, "api");
    fs.mkdirSync(path.join(checkoutPath, ".citadel", "hooks"), { recursive: true });
    const hookPath = path.join(checkoutPath, ".citadel", "hooks", "deploy");
    fs.writeFileSync(
      hookPath,
      '#!/usr/bin/env sh\nprintf \'%s\\n\' \'{"apps":[{"name":"api","url":"http://127.0.0.1:1"}]}\'\n',
    );
    fs.chmodSync(hookPath, 0o755);
    const undeployLog = path.join(dir, "undeploy.log");
    const undeployHookPath = path.join(checkoutPath, ".citadel", "hooks", "undeploy");
    fs.writeFileSync(undeployHookPath, `#!/usr/bin/env sh\nprintf '%s\\n' "\${1:-all}" > ${undeployLog}\n`);
    fs.chmodSync(undeployHookPath, 0o755);

    store.insertRepo({
      id: "repo_api",
      name: "API",
      rootPath: repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      providerRepositoryKey: "owner/api",
      showMainWorkspace: false,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    store.insertWorkspace({
      id: "ws_structured",
      repoId: null,
      name: "Structured",
      path: workspacePath,
      rootPath: workspacePath,
      mode: "structured",
      branch: "home",
      baseBranch: "main",
      source: "scratch",
      kind: "root",
      lifecyclePhase: "implementation",
      parentIssue: null,
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    store.insertWorkspaceCheckout({
      id: "co_api",
      workspaceId: "ws_structured",
      repoId: "repo_api",
      name: "api",
      displayName: "API card",
      path: checkoutPath,
      branch: "feature/api",
      baseBranch: "main",
      issue: null,
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    const service = new OperationService(store);
    const summary = await service.listDeployedApps({ workspaceId: "ws_structured", checkoutId: "co_api" });

    expect(summary.resolution).toMatchObject({ source: "repo-file", filePath: hookPath });
    expect(summary.undeployResolution).toMatchObject({ source: "repo-file", filePath: undeployHookPath });
    expect(summary.apps).toMatchObject([{ name: "api", url: "http://127.0.0.1:1" }]);
    expect(summary.error).toBeNull();

    const undeploy = await service.undeployApp({ workspaceId: "ws_structured", checkoutId: "co_api", appName: "api" });
    expect(undeploy.status).toBe("succeeded");
    expect(fs.readFileSync(undeployLog, "utf8").trim()).toBe("api");
  });
});
