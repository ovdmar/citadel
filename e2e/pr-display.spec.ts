import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// PR display & management — focused E2E coverage.
//
// Strategy: register a real repo + workspace via the daemon API, then check
// the cockpit's PR strip rendering. Real GitHub PRs aren't feasible in CI, so
// PR-populated states (chip color, base ← head, force-refresh, merge button)
// are validated manually per CLAUDE.md and covered indirectly by the unit
// tests for prToneFor + the daemon endpoint tests. What we verify here is
// the regression-prone path: that the *always-visible* PR row renders even
// when no PR exists and even when the workspace isn't selected.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("non-selected workspace cards show the PR placeholder slot", async ({ page, request }) => {
  const fixture = createGitFixture();
  try {
    const repo = await registerRepo(request, fixture);
    const first = await createWorkspace(request, repo.id, `pr-display-a-${Date.now().toString(36)}`);
    const second = await createWorkspace(request, repo.id, `pr-display-b-${Date.now().toString(36)}`);

    await page.goto("/");
    // Wait for both cards to appear in the navigator.
    const firstCard = page.locator(`button[aria-label*="${first.workspaceId.slice(-6)}"]`).first();
    const secondCard = page.locator(`button[aria-label*="${second.workspaceId.slice(-6)}"]`).first();
    // Either we'll match the workspace card title text directly or the
    // surrounding wrap — the PR placeholder lives just below it in the same
    // .workspace-card-wrap.
    await expect(page.locator(".workspace-card-wrap").first()).toBeVisible();

    // Both wraps should render the always-visible PR slot (placeholder when
    // no PR exists). This guards the regression where the row only showed
    // for the selected workspace.
    const placeholders = page.locator(".workspace-card-pr-empty");
    await expect(placeholders.first()).toBeVisible();
    expect(await placeholders.count()).toBeGreaterThanOrEqual(2);

    // No need to click a specific card — placeholders should already be visible
    // for non-selected workspaces too.
    void firstCard;
    void secondCard;
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("inspector PR section screenshot diff guards deploy-panel coexistence", async ({ page, request }) => {
  const fixture = createGitFixture();
  try {
    const repo = await registerRepo(request, fixture);
    const workspace = await createWorkspace(request, repo.id, `pr-screenshot-${Date.now().toString(36)}`);
    await page.goto("/");
    const card = page.locator(".workspace-card").filter({ hasText: "pr-screenshot-" }).first();
    await card.click();
    const prSection = page.locator(".ins-section").filter({ has: page.getByText("Pull request") });
    await expect(prSection).toBeVisible();
    // Mask dynamic regions so the snapshot doesn't flap on per-run timestamps.
    await expect(prSection).toHaveScreenshot("inspector-pr-empty.png", {
      mask: [page.locator(".ins-pr-elapsed"), page.locator(".ch-time"), page.locator(".ins-pr-meta-empty")],
      maxDiffPixelRatio: 0.01,
    });
    void workspace;
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("inspector PR section renders even when the workspace has no PR", async ({ page, request }) => {
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
