import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

// These tests target the current ADE cockpit shell. They were rewritten in the
// 2026-05-22 feedback round when the older spec drifted from the redesigned UI
// (the previous suite looked for "Agent Development Environment" text and
// ".workspace-navigator" selectors that no longer exist).

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("cockpit renders top bar, navigator, stage, and inspector", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.locator(".cit-brand")).toContainText("Citadel");
  await expect(page.getByRole("button", { name: "Search workspaces" })).toBeVisible();
  if (testInfo.project.name === "mobile") {
    // Mobile collapses to one column at a time and exposes a switcher.
    const switcher = page.getByRole("navigation", { name: "Workspace layout" });
    await expect(switcher).toBeVisible();
    await switcher.getByRole("button", { name: "Navigator" }).click();
    await expect(page.locator("aside[aria-label='Navigator']")).toBeVisible();
  } else {
    await expect(page.locator("aside[aria-label='Navigator']")).toBeVisible();
    await expect(page.locator("aside[aria-label='Inspector']")).toBeVisible();
    await expect(page.locator("main[aria-label='Agent stage']")).toBeVisible();
  }
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-cockpit.png`, fullPage: true });
});

test("cockpit lists registered workspaces in the navigator", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop/tablet cover the multi-column navigator");
  const fixture = createGitFixture();
  const workspaceIds: string[] = [];
  try {
    const repo = await registerRepo(request, fixture);
    const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
    const firstName = `ade-a-${suffix}`;
    const secondName = `ade-b-${suffix}`;
    const first = await createWorkspace(request, repo.id, firstName);
    const second = await createWorkspace(request, repo.id, secondName);
    workspaceIds.push(first.workspaceId, second.workspaceId);
    await waitForWorkspace(request, first.workspaceId, "ready");
    await waitForWorkspace(request, second.workspaceId, "ready");

    await page.goto("/");
    const navigator = page.locator("aside[aria-label='Navigator']");
    await expect(navigator.getByRole("button", { name: new RegExp(firstName, "i") })).toBeVisible();
    await expect(navigator.getByRole("button", { name: new RegExp(secondName, "i") })).toBeVisible();
    // Selecting a workspace card focuses it (active class) — sanity check the click target works.
    await navigator.getByRole("button", { name: new RegExp(secondName, "i") }).click();
    await expect(navigator.locator(".workspace-card.active").filter({ hasText: secondName })).toBeVisible();
  } finally {
    for (const workspaceId of workspaceIds) {
      await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    }
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("mobile cockpit toggles between navigator/stage/inspector", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-specific switcher coverage");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    const workspaceName = `mobile-${Date.now().toString(36)}`;
    workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");

    await page.goto("/");
    const switcher = page.getByRole("navigation", { name: "Workspace layout" });
    await switcher.getByRole("button", { name: "Navigator" }).click();
    await expect(page.getByRole("button", { name: new RegExp(workspaceName, "i") })).toBeVisible();
    await switcher.getByRole("button", { name: "Inspector" }).click();
    // The inspector is empty until a workspace is focused — at minimum the aria-labelled aside must render.
    await expect(page.locator("aside[aria-label='Inspector']")).toBeVisible();
  } finally {
    if (workspaceId) await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("onboarding page renders the three step checklist", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Onboarding" })).toBeVisible();
  // Steps are rendered as buttons inside the step list; they're clickable and revisitable.
  await expect(page.getByRole("button", { name: /Verify providers/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Register a repo/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Create a workspace/ })).toBeVisible();
});

test("operations route renders the operations list", async ({ page }) => {
  await page.goto("/operations");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
});

test("desktop repo settings page renders identity and provider toggles", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "repo settings UI coverage");
  const fixture = createGitFixture();
  let repoId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture, `Repo Settings ${Date.now().toString(36)}`);
    repoId = repo.id;
    await page.goto(`/repos/${repo.id}`);
    await expect(page.getByRole("heading", { name: "Identity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hooks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Actions" })).toBeVisible();
    await page.getByRole("button", { name: "Save providers" }).click();
  } finally {
    if (repoId) await request.delete(`${API_BASE}/api/repos/${repoId}?force=true`).catch(() => {});
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("settings sidebar exposes all configured sections", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const sidebar = page.locator(".settings-sidebar");
  // Scheduled agents has its own top-level nav entry (not a settings section).
  for (const label of ["Overview", "Providers", "Agents", "Repositories", "MCP", "Advanced"]) {
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await sidebar.getByRole("button", { name: "Providers", exact: true }).click();
  await expect(page.locator("#settings-section-title")).toContainText("Providers");
  await sidebar.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator("#settings-section-title")).toContainText("Agents");
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-settings.png`, fullPage: true });
});

test("dialogs render near viewport center on desktop and tablet", async ({ page, request }, testInfo) => {
  // Mobile collapses the navigator into a column switcher and reorders some
  // controls behind a tap; the centering math itself is identical on every
  // viewport, so we cover desktop and tablet (different widths exercise the
  // `width: min(560px, 100%)` clamp differently) and skip Pixel-7.
  test.skip(testInfo.project.name === "mobile", "mobile rearranges the trigger buttons; centering math is identical");

  const fixture = createGitFixture();
  const workspaceIds: string[] = [];
  try {
    const repo = await registerRepo(request, fixture, `Centering ${Date.now().toString(36)}`);
    const workspaceName = `centering-${Date.now().toString(36)}`;
    const created = await createWorkspace(request, repo.id, workspaceName);
    workspaceIds.push(created.workspaceId);
    await waitForWorkspace(request, created.workspaceId, "ready");

    await page.goto("/");
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("viewport size missing");
    const viewportCenterX = viewport.width / 2;
    const viewportCenterY = viewport.height / 2;

    // Tolerances: a properly grid-centered dialog lands within ~1px of viewport
    // center on Chromium, so any value above single-digit pixels means the fix
    // regressed. Per-dialog overrides cover content that legitimately moves the
    // centerpoint (e.g. the create-workspace modal is capped at `max-height:
    // 90vh` and the backdrop has 20px padding on small viewports).
    const assertCentered = async (
      locator: import("@playwright/test").Locator,
      label: string,
      options: { horizontalSlack?: number; verticalSlack?: number } = {},
    ) => {
      const horizontalSlack = options.horizontalSlack ?? 6;
      const verticalSlack = options.verticalSlack ?? 6;
      await expect(locator, `${label} should be visible`).toBeVisible();
      const box = await locator.boundingBox();
      if (!box) throw new Error(`${label} has no bounding box`);
      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      expect(
        Math.abs(centerX - viewportCenterX),
        `${label} should be horizontally centered (got centerX=${centerX}, viewportCenterX=${viewportCenterX})`,
      ).toBeLessThanOrEqual(horizontalSlack);
      expect(
        Math.abs(centerY - viewportCenterY),
        `${label} should be near vertical center (got centerY=${centerY}, viewportCenterY=${viewportCenterY})`,
      ).toBeLessThanOrEqual(verticalSlack);
    };

    // 1. Command palette (Search workspaces button in the top bar). Capped at
    // `max-height: 70vh`, so vertical center is close but not pixel-perfect.
    await page.getByRole("button", { name: "Search workspaces" }).click();
    await assertCentered(page.locator("dialog.command-palette"), "command palette");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.command-palette")).toHaveCount(0);

    // 2. Create-workspace modal (Plus button in navigator). Has more content
    // and a 90vh cap, so vertical slack is wider; horizontal must still be
    // tight to catch the original "drifted right" symptom.
    await page.getByRole("button", { name: "Create workspace" }).click();
    await assertCentered(page.locator("dialog.modal-frame"), "create-workspace modal", { verticalSlack: 32 });
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.modal-frame")).toHaveCount(0);

    // 3. Drop-workspace confirmation. The trash button only appears on hover,
    // so we force the hover state on the wrapping element first. Small fixed-
    // ish height: tight tolerances on both axes.
    const card = page.locator(".workspace-card-wrap").filter({ hasText: workspaceName }).first();
    await card.hover();
    await card.getByRole("button", { name: new RegExp(`Drop workspace ${workspaceName}`, "i") }).click();
    await assertCentered(page.locator("dialog.drop-workspace-dialog"), "drop-workspace dialog");
    // Dialog has no Escape handler today (tracked separately) — click the
    // backdrop to dismiss so the test cleanup isn't blocked by an open dialog.
    await page.locator(".drop-workspace-backdrop").click({ position: { x: 5, y: 5 } });
  } finally {
    for (const workspaceId of workspaceIds) {
      await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
    }
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop session stop endpoint removes the session", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "session lifecycle coverage runs once against the shared daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    workspaceId = (await createWorkspace(request, repo.id, `stop-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    const session = await startSession(request, workspaceId, "Stop Shell");
    const stop = await request.delete(`${API_BASE}/api/agent-sessions/${session.id}`);
    expect(stop.ok()).toBe(true);
    const state = await request.get(`${API_BASE}/api/state`);
    const body = (await state.json()) as { sessions: Array<{ id: string }> };
    // Stop is destructive: the session is deleted from the cockpit, not merely marked stopped.
    expect(body.sessions.find((entry) => entry.id === session.id)).toBeUndefined();
  } finally {
    if (workspaceId) await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop reconcile endpoint cleans orphan repos", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "reconcile coverage runs once against the shared daemon");
  const fixture = createGitFixture();
  let repoId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    repoId = repo.id;
    fs.rmSync(fixture.repoPath, { recursive: true, force: true });
    const response = await request.post(`${API_BASE}/api/reconcile`);
    expect(response.ok()).toBe(true);
    const state = await request.get(`${API_BASE}/api/state`);
    const body = (await state.json()) as { repos: Array<{ id: string }> };
    expect(body.repos.find((entry) => entry.id === repoId)).toBeUndefined();
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop terminal endpoint returns a ttyd proxy URL for a fresh session", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "terminal smoke runs once against the shared local daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    workspaceId = (await createWorkspace(request, repo.id, `e2e-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    const session = await startSession(request, workspaceId, "E2E Shell");

    // Citadel hands the ttyd-backed terminal URL out via this endpoint. If ttyd
    // is unavailable (e.g. binary missing on the CI runner) we accept 503 and
    // skip the rest — the smoke still proves the daemon wiring is intact.
    const response = await request.post(`${API_BASE}/api/agent-sessions/${session.id}/terminal`);
    if (response.status() === 503) {
      test.info().annotations.push({ type: "skip-reason", description: "ttyd unavailable on runner" });
      return;
    }
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as { terminal: { url: string; port: number } };
    expect(body.terminal.url).toMatch(/^\/terminals\//);
    expect(body.terminal.port).toBeGreaterThan(0);
  } finally {
    if (workspaceId) await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
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

async function startSession(request: APIRequestContext, workspaceId: string, displayName: string) {
  const sessionResponse = await request.post(`${API_BASE}/api/agent-sessions`, {
    data: { workspaceId, runtimeId: "shell", displayName },
  });
  expect(sessionResponse.ok()).toBe(true);
  return ((await sessionResponse.json()) as { session: { id: string } }).session;
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
