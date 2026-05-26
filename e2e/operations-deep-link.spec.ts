import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// E2E coverage for the /operations?id=<operationId> deep-link surface
// that the redeploy chip's "View log" link routes to. Creates a workspace
// that produces an operation (via redeploy), then navigates the browser
// to /operations?id=<op> and asserts the matching row is highlighted.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("operations route highlights the row matching ?id=", async ({ page, request }) => {
  const fixture = createGitFixture();
  try {
    const repo = await registerRepo(request, fixture, `Ops Link ${Date.now().toString(36)}`);
    const created = await createWorkspace(request, repo.id, `op-${Date.now().toString(36)}`);
    await waitForWorkspace(request, created.workspaceId, "ready");

    // Trigger a redeploy with no deploy hook configured — this produces a
    // failed operation row (deploy_hook_not_configured) which is enough to
    // exercise the deep-link UI without standing up a real hook.
    const redeploy = await request.post(`${API_BASE}/api/workspaces/${created.workspaceId}/deployed-apps/redeploy`, {
      data: {},
    });
    expect([202, 424]).toContain(redeploy.status());
    const body = (await redeploy.json()) as { operationId?: string };
    expect(body.operationId).toBeTruthy();

    await page.goto(`/operations?id=${body.operationId}`);
    await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
    const highlighted = page.locator(`[data-testid="operation-${body.operationId}"]`);
    await expect(highlighted).toHaveClass(/highlighted/);
    // Highlighted rows auto-expand their <details> on mount.
    await expect(highlighted).toHaveJSProperty("open", true);

    // Navigating to a missing id shows the not-found note.
    await page.goto("/operations?id=op_missing_ghost");
    await expect(page.getByText(/Operation op_missing_ghost not found/)).toBeVisible();
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function waitForWorkspace(request: APIRequestContext, workspaceId: string, lifecycle: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get(`${API_BASE}/api/workspaces`);
    const body = (await response.json()) as { workspaces: Array<{ id: string; lifecycle: string }> };
    const workspace = body.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for workspace ${workspaceId} to become ${lifecycle}`);
}

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name: string) {
  const repoResponse = await request.post(`${API_BASE}/api/repos`, {
    data: { rootPath: fixture.repoPath, name, worktreeParent: path.join(fixture.dir, "worktrees") },
  });
  expect(repoResponse.ok()).toBe(true);
  return ((await repoResponse.json()) as { repo: { id: string } }).repo;
}

async function createWorkspace(request: APIRequestContext, repoId: string, name: string) {
  const response = await request.post(`${API_BASE}/api/workspaces`, {
    data: { repoId, name, source: "scratch" },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { workspaceId: string };
}

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-e2e-"));
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel E2E"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# e2e\n");
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
