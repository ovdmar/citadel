import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// PR display & management — focused E2E coverage.
//
// The workspace card itself only carries the PR status icon (tone applied to
// the branch-icon chip in the card head). PR identity (number, title, base ←
// head, merge action) lives in the inspector. Real GitHub PRs aren't feasible
// in CI, so PR-populated inspector states are validated manually per
// CLAUDE.md; we just guard that the inspector PR section renders.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("inspector PR section renders even when the workspace has no PR", async ({ page, request }, testInfo) => {
  // Mobile collapses to one column; the inspector isn't directly visible without
  // switching the layout. Skip there — desktop/tablet still guards the regression.
  test.skip(testInfo.project.name === "mobile", "mobile layout collapses to one column");
  const fixture = createGitFixture();
  try {
    const repo = await registerRepo(request, fixture);
    const workspace = await createWorkspace(request, repo.id, `pr-inspector-${Date.now().toString(36)}`);

    await page.goto("/");
    // Open the workspace.
    const card = page.locator(".workspace-card").filter({ hasText: "pr-inspector-" }).first();
    await card.click();

    // The inspector's "Pull request" section should be present with the
    // empty-state hint.
    const prSection = page.locator(".ins-section").filter({ has: page.getByText("Pull request") });
    await expect(prSection).toBeVisible();
    await expect(prSection.getByText(/No PR for this branch yet\./)).toBeVisible();

    // The force-refresh button is always present on the Checks section head —
    // even with no PR, the operator should be able to ask the daemon to
    // re-check.
    const checksSection = page.locator(".ins-section").filter({ has: page.getByText("Checks") });
    await expect(checksSection.locator(".ins-pr-refresh")).toBeVisible();

    void workspace;
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name?: string) {
  const repoResponse = await request.post(`${API_BASE}/api/repos`, {
    data: {
      rootPath: fixture.repoPath,
      name: name ?? `E2E PR ${Date.now().toString(36)}`,
      worktreeParent: path.join(fixture.dir, "worktrees"),
    },
  });
  expect(repoResponse.ok()).toBe(true);
  return ((await repoResponse.json()) as { repo: { id: string } }).repo;
}

async function createWorkspace(request: APIRequestContext, repoId: string, name: string) {
  const workspaceResponse = await request.post(`${API_BASE}/api/workspaces`, {
    data: { repoId, name, source: "scratch" },
  });
  expect(workspaceResponse.ok()).toBe(true);
  return (await workspaceResponse.json()) as { workspaceId: string };
}

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-e2e-pr-"));
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel E2E"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  run("git", ["add", "."], repoPath);
  run("git", ["commit", "-m", "initial"], repoPath);
  run("git", ["push", "origin", "HEAD:main"], repoPath);
  return { dir, repoPath, remotePath };
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
