import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// E2E coverage for the file-based teardown hook contract. The test
// builds a fresh git fixture, ships an executable `.citadel/hooks/teardown`
// that writes a sentinel file, removes the workspace via the daemon API,
// and asserts the sentinel appears BEFORE the worktree directory is pruned.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("file-based teardown hook runs before worktree prune", async ({ request }) => {
  const fixture = createGitFixture();
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-teardown-sentinel-"));
  const sentinelPath = path.join(sentinelDir, "teardown-ran");

  try {
    const repo = await registerRepo(request, fixture, `Teardown ${Date.now().toString(36)}`);
    const workspaceName = `td-${Date.now().toString(36)}`;
    const created = await createWorkspace(request, repo.id, workspaceName);
    await waitForWorkspace(request, created.workspaceId, "ready");

    // Inspect the workspace path so we can ship the teardown hook into it.
    const workspaces = await fetchWorkspaces(request);
    const workspace = workspaces.find((w) => w.id === created.workspaceId);
    expect(workspace?.path).toBeTruthy();
    const hookPath = path.join(workspace?.path ?? "", ".citadel", "hooks", "teardown");
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(
      hookPath,
      `#!/bin/sh\nprintf 'teardown ran for %s\\n' "$CITADEL_WORKSPACE_ID" > ${JSON.stringify(sentinelPath)}\nexit 0\n`,
    );
    fs.chmodSync(hookPath, 0o755);
    // Commit + push so workspaceIsDirty doesn't block removal.
    execFileSync("git", ["add", ".citadel/hooks/teardown"], { cwd: workspace?.path ?? "", stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "e2e: teardown hook"], { cwd: workspace?.path ?? "", stdio: "pipe" });
    execFileSync("git", ["push", "-u", "origin", "HEAD"], { cwd: workspace?.path ?? "", stdio: "pipe" });

    const workspacePath = workspace?.path ?? "";
    expect(fs.existsSync(workspacePath)).toBe(true);

    const response = await request.delete(`${API_BASE}/api/workspaces/${created.workspaceId}`);
    expect(response.ok()).toBe(true);

    // Sentinel must exist (proves teardown ran), worktree must be gone
    // (proves cleanup proceeded after teardown returned 0).
    expect(fs.existsSync(sentinelPath)).toBe(true);
    expect(fs.existsSync(workspacePath)).toBe(false);
    expect(fs.readFileSync(sentinelPath, "utf8")).toContain("teardown ran for");
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
});

async function fetchWorkspaces(request: APIRequestContext): Promise<Array<{ id: string; path: string }>> {
  const response = await request.get(`${API_BASE}/api/workspaces`);
  const body = (await response.json()) as { workspaces: Array<{ id: string; path: string }> };
  return body.workspaces;
}

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
