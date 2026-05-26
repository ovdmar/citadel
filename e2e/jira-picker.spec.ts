import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// E2E coverage for the native Jira picker introduced in
// apps/web/src/jira-picker.tsx. The local daemon doesn't have jtk
// installed (and we wouldn't want to talk to a real Jira from a smoke
// run anyway), so the /api/integrations/jira/search and
// /api/workspaces/:id/issue-transition endpoints are mocked at the
// browser-fetch layer via page.route(). The PATCH workspace endpoint
// hits the real daemon — that path is exercised by jira-routes tests.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test.describe("Jira picker", () => {
  test("opens picker, selects a recent issue, then unattaches via the hover affordance", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Picker interaction covered on desktop only");
    const fixture = createGitFixture();
    let workspaceId: string | null = null;
    try {
      const repo = await registerRepo(request, fixture, `Jira Picker ${Date.now().toString(36)}`);
      const workspaceName = `jira-picker-${Date.now().toString(36)}`;
      workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
      await waitForWorkspace(request, workspaceId, "ready");

      await page.route(/\/api\/integrations\/jira\/search/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "healthy",
            reason: null,
            results: [
              { key: "MS-101", summary: "Wire picker", status: "In Progress", url: null, updated: null },
              { key: "MS-102", summary: "Ship transitions", status: "To Do", url: null, updated: null },
            ],
          }),
        });
      });

      await page.goto("/");
      const navigator = page.locator("aside[aria-label='Navigator']");
      await expect(navigator).toBeVisible();
      const workspaceButton = navigator.getByRole("button", { name: new RegExp(workspaceName, "i") }).first();
      await expect(workspaceButton).toBeVisible();
      await workspaceButton.click();

      const inspector = page.locator("aside[aria-label='Inspector']");
      await expect(inspector).toBeVisible();
      const attachButton = inspector.getByRole("button", { name: /Attach Jira ticket/i });
      await expect(attachButton).toBeVisible();
      await attachButton.click();

      // Picker opens; recent-default results are visible.
      const pickerInput = inspector.getByRole("textbox", { name: /Jira issue search/i });
      await expect(pickerInput).toBeFocused();
      await expect(inspector.getByText("MS-101")).toBeVisible();
      await expect(inspector.getByText("Wire picker")).toBeVisible();

      // Click MS-101 — chip should swap to attached state.
      await inspector.getByRole("button", { name: /MS-101.*Wire picker/i }).click();
      await expect(inspector.getByText("MS-101")).toBeVisible();

      // Hover the chip; the × button becomes visible and clickable.
      const chip = inspector.locator(".cit-jira-attached");
      await chip.hover();
      const unattachBtn = chip.getByRole("button", { name: "Unattach issue" });
      await expect(unattachBtn).toBeVisible();
      await unattachBtn.click();

      // Picker returns to the "Attach Jira ticket" empty state.
      await expect(inspector.getByRole("button", { name: /Attach Jira ticket/i })).toBeVisible();
    } finally {
      if (workspaceId)
        await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("transition menu calls the issue-transition route and the pill updates optimistically", async ({
    page,
    request,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Picker interaction covered on desktop only");
    const fixture = createGitFixture();
    let workspaceId: string | null = null;
    try {
      const repo = await registerRepo(request, fixture, `Jira Transition ${Date.now().toString(36)}`);
      const workspaceName = `jira-transition-${Date.now().toString(36)}`;
      workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
      await waitForWorkspace(request, workspaceId, "ready");

      // Attach an issue up front via PATCH so the chip starts in the
      // attached state with a transitions list populated. The PATCH
      // returns 200 with the updated workspace; confirm issueKey is
      // persisted before navigating, so the page's initial /api/state
      // render already sees it.
      const patchResp = await request.patch(`${API_BASE}/api/workspaces/${workspaceId}`, {
        data: { issueKey: "T-1", issueTitle: "Transition demo", issueUrl: null },
      });
      expect(patchResp.ok()).toBe(true);
      const patched = (await patchResp.json()) as { workspace?: { issueKey?: string | null } };
      expect(patched.workspace?.issueKey).toBe("T-1");

      // Stateful issueStatus — flips when the transition route is hit so
      // the cockpit-summary refetch that follows onSettled reflects the
      // new state (otherwise the optimistic value gets clobbered by the
      // refetch).
      let issueStatus = "To Do";
      await page.route(/\/api\/workspaces\/[^/]+\/cockpit-summary/, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.issueTracker = {
          providerId: "jira-jtk",
          status: "healthy",
          reason: null,
          key: "T-1",
          summary: "Transition demo",
          issueStatus,
          assignee: null,
          updated: null,
          url: null,
          transitions: [{ id: "21", name: "Start Progress", toStatus: "In Progress" }],
          checkedAt: new Date().toISOString(),
        };
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      await page.route(/\/api\/workspaces\/[^/]+\/issue-transition/, async (route) => {
        issueStatus = "In Progress";
        await route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              providerId: "jira-jtk",
              status: "healthy",
              reason: null,
              key: "T-1",
              transition: "21",
              checkedAt: new Date().toISOString(),
            },
          }),
        });
      });

      await page.goto("/");
      const navigator = page.locator("aside[aria-label='Navigator']");
      await expect(navigator).toBeVisible({ timeout: 20_000 });
      const workspaceButton = navigator.getByRole("button", { name: new RegExp(workspaceName, "i") }).first();
      await expect(workspaceButton).toBeVisible({ timeout: 20_000 });
      await workspaceButton.click();
      const inspector = page.locator("aside[aria-label='Inspector']");
      await expect(inspector).toBeVisible();
      const chip = inspector.locator(".cit-jira-attached");
      await expect(chip).toBeVisible({ timeout: 20_000 });
      // The status pill is a button that opens the transition menu.
      const statusButton = chip.getByRole("button", { name: /To Do|Status/i });
      await statusButton.click();
      const transitionMenu = chip.getByRole("menu");
      await expect(transitionMenu).toBeVisible();
      await transitionMenu.getByRole("menuitem", { name: /Start Progress/i }).click();
      // Optimistic update — pill should show "In Progress" before the
      // (mocked) server response settles.
      await expect(chip.getByText(/In Progress/i)).toBeVisible();
    } finally {
      if (workspaceId)
        await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  test("manual-entry fallback still attaches an issue by key", async ({ page, request }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Picker interaction covered on desktop only");
    const fixture = createGitFixture();
    let workspaceId: string | null = null;
    try {
      const repo = await registerRepo(request, fixture, `Jira Manual ${Date.now().toString(36)}`);
      const workspaceName = `jira-manual-${Date.now().toString(36)}`;
      workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
      await waitForWorkspace(request, workspaceId, "ready");

      await page.route(/\/api\/integrations\/jira\/search/, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "healthy", reason: null, results: [] }),
        });
      });

      await page.goto("/");
      const navigator = page.locator("aside[aria-label='Navigator']");
      await expect(navigator).toBeVisible();
      const workspaceButton = navigator.getByRole("button", { name: new RegExp(workspaceName, "i") }).first();
      await expect(workspaceButton).toBeVisible();
      await workspaceButton.click();
      const inspector = page.locator("aside[aria-label='Inspector']");
      await expect(inspector).toBeVisible();
      const attachBtn = inspector.getByRole("button", { name: /Attach Jira ticket/i });
      await expect(attachBtn).toBeVisible();
      await attachBtn.click();
      await inspector.getByRole("button", { name: /Enter key manually/i }).click();
      await inspector.getByLabel(/Issue key/i).fill("AUTH-77");
      await inspector.getByRole("button", { name: /^Attach$/ }).click();
      await expect(inspector.getByText("AUTH-77")).toBeVisible();
    } finally {
      if (workspaceId)
        await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
});

// ─── helpers (mirrored from operator-cockpit.spec.ts) ─────────────────────────

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

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name?: string) {
  const repoResponse = await request.post(`${API_BASE}/api/repos`, {
    data: {
      rootPath: fixture.repoPath,
      name: name ?? `E2E ${Date.now().toString(36)}`,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-jira-e2e-"));
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

function run(cmd: string, args: string[], cwd: string) {
  execFileSync(cmd, args, { cwd, stdio: "pipe" });
}
