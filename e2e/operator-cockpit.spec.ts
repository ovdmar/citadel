import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import WebSocket, { type RawData } from "ws";
import { apiDelete, apiGet, apiPost } from "./helpers/api-request.js";

// These tests target the current ADE cockpit shell. They were rewritten in the
// 2026-05-22 feedback round when the older spec drifted from the redesigned UI
// (the previous suite looked for "Agent Development Environment" text and
// ".workspace-navigator" selectors that no longer exist).

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "14012"}`;

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
      await apiDelete(request, `${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
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
    if (workspaceId) await apiDelete(request, `${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
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
    if (repoId) await apiDelete(request, `${API_BASE}/api/repos/${repoId}?force=true`).catch(() => {});
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("settings sidebar exposes all configured sections", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const sidebar = page.locator(".set-nav");
  // Scheduled agents has its own top-level nav entry (not a settings section).
  // Advanced was folded into other surfaces during the settings redesign.
  for (const label of ["Overview", "Integrations", "Agent runtimes", "Repositories", "MCP"]) {
    await expect(sidebar.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await sidebar.getByRole("button", { name: "Integrations", exact: true }).click();
  await expect(page.locator("#settings-section-title")).toContainText("Integrations");
  await sidebar.getByRole("button", { name: "Agent runtimes", exact: true }).click();
  await expect(page.locator("#settings-section-title")).toContainText("Agent runtimes");
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-settings.png`, fullPage: true });
});

test("desktop route overlays cover retained cockpit tabs", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "z-index regression is covered once on desktop");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    workspaceId = (await createWorkspace(request, repo.id, `overlay-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    await startSession(request, workspaceId, "Overlay Shell");

    await page.goto(`/?workspace=${workspaceId}`);
    const tab = page.locator(".stage-tab").filter({ hasText: "Overlay Shell" }).first();
    await expect(tab).toBeVisible();
    const point = await centerPoint(tab);

    await page.goto("/settings");
    await expect(page.locator(".set-app")).toBeVisible();
    await expectTopLayerAtPoint(page, point, { inside: ".set-app", outside: ".stage-tabbar" });

    await page.goto("/");
    await expect(tab).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    await expectTopLayerAtPoint(page, point, { inside: ".scratchpad-drawer", outside: ".stage-tabbar" });
  } finally {
    if (workspaceId) await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
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
    const createWorkspaceDialog = page.getByRole("dialog", { name: "New workspace" });
    await assertCentered(createWorkspaceDialog, "create-workspace modal", { verticalSlack: 32 });
    await page.keyboard.press("Escape");
    await expect(createWorkspaceDialog).toHaveCount(0);

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
      await apiDelete(request, `${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`).catch(() => {});
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
    const stop = await apiDelete(request, `${API_BASE}/api/workspace-sessions/${session.id}`);
    expect(stop.ok()).toBe(true);
    const state = await apiGet(request, `${API_BASE}/api/state`);
    const body = (await state.json()) as { sessions: Array<{ id: string }> };
    // Stop is destructive: the session is deleted from the cockpit, not merely marked stopped.
    expect(body.sessions.find((entry) => entry.id === session.id)).toBeUndefined();
  } finally {
    if (workspaceId) await apiDelete(request, `${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
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
    const response = await apiPost(request, `${API_BASE}/api/reconcile`);
    expect(response.ok()).toBe(true);
    const state = await apiGet(request, `${API_BASE}/api/state`);
    const body = (await state.json()) as { repos: Array<{ id: string }> };
    expect(body.repos.find((entry) => entry.id === repoId)).toBeUndefined();
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop primary terminal WebSocket streams a fresh shell session", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "primary terminal smoke runs once against the shared local daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    workspaceId = (await createWorkspace(request, repo.id, `e2e-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    const session = await startSession(request, workspaceId, "Primary WS Shell");
    const marker = `primary-ws-${Date.now().toString(36)}`;
    const ws = await openTerminalSocket(session.id);
    try {
      const output = waitForTerminalOutput(ws, marker);
      ws.send(Buffer.from(`printf '${marker}\\n'\r`, "utf8"));
      await output;
    } finally {
      ws.close();
    }
  } finally {
    if (workspaceId) await apiDelete(request, `${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop terminal surface is opaque and stable in the cockpit", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "terminal renderer coverage runs once against the desktop cockpit");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    const workspaceName = `render-${Date.now().toString(36)}`;
    workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    await startSession(request, workspaceId, "Render Shell");

    await page.goto("/");
    const navigator = page.locator("aside[aria-label='Navigator']");
    await navigator.getByRole("button", { name: new RegExp(workspaceName, "i") }).click();
    const sessionTab = page.getByRole("button", { name: "Switch to Render Shell" });
    await expect(sessionTab).toBeVisible();
    await sessionTab.click();

    const terminalHost = page.locator('.terminal-active .terminal-xterm-host[aria-label="Terminal Render Shell"]');
    await expect(terminalHost).toBeVisible();
    await expect(terminalHost.locator(".xterm")).toBeVisible();
    await expect(terminalHost.locator(".xterm-viewport")).toHaveCount(1);

    const beforeBox = await terminalHost.boundingBox();
    assertStableTerminalBox(beforeBox, "initial terminal host");
    const viewport = page.viewportSize();
    if (viewport) {
      await page.setViewportSize({ width: viewport.width - 1, height: viewport.height });
    }
    await page.waitForTimeout(150);
    const afterBox = await terminalHost.boundingBox();
    assertStableTerminalBox(afterBox, "terminal host after viewport nudge");
    if (!beforeBox || !afterBox) throw new Error("terminal host lost its bounding box");
    expect(Math.abs(afterBox.width - beforeBox.width)).toBeLessThanOrEqual(8);
    expect(Math.abs(afterBox.height - beforeBox.height)).toBeLessThanOrEqual(4);

    const stageUnderlay = await page.locator(".stage-body").evaluate((element) => {
      const before = getComputedStyle(element, "::before");
      return { backgroundImage: before.backgroundImage, content: before.content };
    });
    expect(stageUnderlay.backgroundImage).toBe("none");
    expect(["none", '""']).toContain(stageUnderlay.content);

    const backgrounds = await terminalHost.evaluate((element) => {
      const surface = element.closest(".terminal-surface");
      const viewportElement = element.querySelector(".xterm-viewport");
      if (!(surface instanceof HTMLElement) || !(viewportElement instanceof HTMLElement)) {
        throw new Error("terminal surface or viewport missing");
      }
      return {
        host: getComputedStyle(element).backgroundColor,
        surface: getComputedStyle(surface).backgroundColor,
        viewport: getComputedStyle(viewportElement).backgroundColor,
      };
    });
    for (const [name, color] of Object.entries(backgrounds)) {
      expect(isTransparentCssColor(color), `${name} background should be opaque, got ${color}`).toBe(false);
    }
  } finally {
    if (workspaceId) await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function centerPoint(locator: import("@playwright/test").Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected locator to have a bounding box");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function expectTopLayerAtPoint(
  page: import("@playwright/test").Page,
  point: { x: number; y: number },
  selectors: { inside: string; outside: string },
) {
  const hit = await page.evaluate(
    ({ x, y, inside, outside }) => {
      const element = document.elementFromPoint(x, y);
      return {
        tag: element?.tagName ?? null,
        className: element instanceof HTMLElement ? element.className : null,
        inside: Boolean(element?.closest(inside)),
        outside: Boolean(element?.closest(outside)),
      };
    },
    { ...point, ...selectors },
  );
  expect(
    hit.outside,
    `Expected top element at (${point.x}, ${point.y}) not to be inside ${selectors.outside}; got ${JSON.stringify(hit)}`,
  ).toBe(false);
  expect(
    hit.inside,
    `Expected top element at (${point.x}, ${point.y}) to be inside ${selectors.inside}; got ${JSON.stringify(hit)}`,
  ).toBe(true);
}

async function openTerminalSocket(sessionId: string) {
  const ws = new WebSocket(`${API_BASE.replace(/^http/, "ws")}/terminal/${encodeURIComponent(sessionId)}`);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out opening terminal WebSocket for ${sessionId}`)), 5000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

function waitForTerminalOutput(ws: WebSocket, expected: string) {
  return new Promise<void>((resolve, reject) => {
    let buffered = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for terminal output ${expected}`));
    }, 10_000);
    const onMessage = (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        buffered += raw.toString();
        if (buffered.includes(expected)) {
          cleanup();
          resolve();
        }
        return;
      }
      const message = parseTerminalSocketMessage(raw);
      if (!message) return;
      if (message.type === "error" || message.type === "exit") {
        cleanup();
        reject(new Error(`Terminal bridge returned ${message.type}: ${message.data ?? ""}`));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Terminal WebSocket closed before expected output arrived"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("close", onClose);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.once("close", onClose);
    ws.once("error", onError);
  });
}

function parseTerminalSocketMessage(raw: RawData): { type: string; data?: string } | null {
  try {
    const parsed = JSON.parse(raw.toString()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const message = parsed as { type?: unknown; data?: unknown };
    if (typeof message.type !== "string") return null;
    return { type: message.type, data: typeof message.data === "string" ? message.data : undefined };
  } catch {
    return null;
  }
}

function assertStableTerminalBox(box: { width: number; height: number } | null, label: string) {
  if (!box) throw new Error(`${label} has no bounding box`);
  expect(box.width, `${label} width`).toBeGreaterThan(240);
  expect(box.height, `${label} height`).toBeGreaterThan(180);
}

function isTransparentCssColor(color: string) {
  return color === "transparent" || color === "rgba(0, 0, 0, 0)";
}

async function waitForWorkspace(request: APIRequestContext, workspaceId: string, lifecycle: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await apiGet(request, `${API_BASE}/api/workspaces`);
    const body = (await response.json()) as { workspaces: Array<{ id: string; lifecycle: string }> };
    const workspace = body.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for workspace ${workspaceId} to become ${lifecycle}`);
}

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name?: string) {
  const repoName = name ?? `E2E ${Date.now().toString(36)}`;
  const rootPath = path.resolve(fixture.repoPath);
  const repoData = {
    rootPath,
    name: repoName,
    worktreeParent: path.join(fixture.dir, "worktrees"),
  };

  try {
    const repoResponse = await apiPost(request, `${API_BASE}/api/repos`, { data: repoData });
    expect(repoResponse.ok()).toBe(true);
    return ((await repoResponse.json()) as { repo: { id: string } }).repo;
  } catch (error) {
    const reposResponse = await apiGet(request, `${API_BASE}/api/repos`);
    if (reposResponse.ok()) {
      const body = (await reposResponse.json()) as { repos: Array<{ id: string; name: string; rootPath: string }> };
      const repo = body.repos.find((candidate) => candidate.name === repoName && candidate.rootPath === rootPath);
      if (repo) return { id: repo.id };
    }
    throw error;
  }
}

async function createWorkspace(request: APIRequestContext, repoId: string, name: string) {
  const workspaceResponse = await apiPost(request, `${API_BASE}/api/workspaces`, {
    data: { repoId, name, source: "scratch" },
  });
  expect(workspaceResponse.ok()).toBe(true);
  return (await workspaceResponse.json()) as { workspaceId: string };
}

async function startSession(request: APIRequestContext, workspaceId: string, displayName: string) {
  const sessionResponse = await request.post(`${API_BASE}/api/workspaces/${workspaceId}/terminal-sessions`, {
    data: { displayName },
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
