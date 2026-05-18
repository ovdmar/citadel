import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import WebSocket from "ws";

test("ADE shell renders workspace-first regions", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("Agent Development Environment")).toBeVisible();
  await expect(page.getByTestId("terminal-stage").or(page.getByText("Start with a workspace"))).toBeVisible();
  if (testInfo.project.name === "mobile") {
    await expect(page.getByLabel("Workspace layout").getByRole("button", { name: "Inspector" })).toBeVisible();
    await page.getByLabel("Workspace layout").getByRole("button", { name: "Navigator" }).click();
    await expect(page.getByText("Workspaces").first()).toBeVisible();
  } else {
    await expect(page.getByText("Workspaces").first()).toBeVisible();
    await expect(page.locator(".workspace-inspector")).toBeVisible();
  }
  await expect(page.getByRole("button", { name: "Quick open" })).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-cockpit.png`, fullPage: true });
});

test("ADE workflow switches workspaces, preserves sessions, and toggles regions", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "desktop and tablet validate full multi-column shell controls");
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
    await startSession(request, first.workspaceId, "ADE Shell A");
    await startSession(request, first.workspaceId, "ADE Shell B");
    await startSession(request, second.workspaceId, "ADE Shell C");

    await page.goto("/");
    await expect(page.getByRole("button", { name: new RegExp(firstName, "i") })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(firstName, "i") }).click();
    await expect(page.getByLabel("Active session")).toContainText("ADE Shell");
    await expect(page.getByText("Next action")).toBeVisible();
    await expect(page.getByText("Workspace state")).toBeVisible();

    await page.getByRole("button", { name: "Diff" }).click();
    await expect(page.getByText("Workspace is clean").or(page.getByText("changed files"))).toBeVisible();
    await page.getByRole("button", { name: "Terminal" }).click();
    await expect(page.getByTestId("terminal-surface").first()).toBeVisible();

    await page.getByRole("button", { name: new RegExp(secondName, "i") }).click();
    await expect(page.getByRole("heading", { name: new RegExp(secondName, "i") })).toBeVisible();
    if (testInfo.project.name === "desktop") {
      await page.getByRole("button", { name: "Collapse navigator" }).click();
      await expect(page.locator(".workspace-navigator")).toBeHidden();
      await page.locator(".edge-toggle.left").click();
      await expect(page.locator(".workspace-navigator")).toBeVisible();
      await page.getByRole("button", { name: "Collapse inspector" }).click();
      await expect(page.locator(".workspace-inspector")).toBeHidden();
      await page.locator(".edge-toggle.right").click();
      await expect(page.locator(".workspace-inspector")).toBeVisible();
    }

    await page.getByRole("button", { name: "Quick open" }).click();
    await expect(page.getByPlaceholder("Switch workspace or run command")).toBeVisible();
  } finally {
    for (const workspaceId of workspaceIds) {
      await request.delete(`http://127.0.0.1:4337/api/workspaces/${workspaceId}?archiveOnly=true`);
    }
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("mobile ADE uses stage and inspector navigation", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-specific navigation coverage");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    const workspaceName = `mobile-${Date.now().toString(36)}`;
    workspaceId = (await createWorkspace(request, repo.id, workspaceName)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    await startSession(request, workspaceId, "Mobile Shell");

    await page.goto("/");
    await page.getByRole("button", { name: "Navigator" }).click();
    await expect(page.getByRole("button", { name: new RegExp(workspaceName, "i") })).toBeVisible();
    await page.getByRole("button", { name: new RegExp(workspaceName, "i") }).click();
    await expect(page.getByTestId("terminal-stage")).toBeVisible();
    await page.getByRole("button", { name: "Inspector" }).click();
    await expect(page.getByText("Next action")).toBeVisible();
    await expect(page.getByText("Workspace state")).toBeVisible();
  } finally {
    if (workspaceId) await request.delete(`http://127.0.0.1:4337/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("settings renders runtime and MCP visibility", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local Config" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Setup Status" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtimes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Repositories" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save config" }).or(page.getByText("Loading config"))).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-settings.png`, fullPage: true });
});

test("desktop settings removes repository tracking with active-work confirmation", async ({
  page,
  request,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "repo removal UI coverage runs once against the shared daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  const repoName = `Remove ${Date.now().toString(36)}`;
  try {
    const repo = await registerRepo(request, fixture, repoName);
    workspaceId = (await createWorkspace(request, repo.id, `remove-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");
    await startSession(request, workspaceId, "Remove Shell");

    await page.goto("/settings");
    const repoRow = page.locator(".repo-row").filter({ hasText: repoName });
    await expect(repoRow).toContainText("1 active sessions");
    await repoRow.getByRole("button", { name: "Remove tracking" }).click();
    await expect(repoRow.getByRole("button", { name: "Confirm remove" })).toBeVisible();
    await repoRow.getByRole("button", { name: "Confirm remove" }).click();
    await expect(repoRow).toBeHidden();
    workspaceId = null;
  } finally {
    if (workspaceId) await request.delete(`http://127.0.0.1:4337/api/workspaces/${workspaceId}?archiveOnly=true`);
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("desktop smoke creates a workspace and reaches its terminal", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "workflow smoke runs once against the shared local daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repo = await registerRepo(request, fixture);
    workspaceId = (await createWorkspace(request, repo.id, `e2e-${Date.now().toString(36)}`)).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");

    const session = await startSession(request, workspaceId, "E2E Shell");

    const ws = new WebSocket(`ws://127.0.0.1:4337/terminal/${session.id}`);
    try {
      await waitForOpen(ws);
      ws.send(JSON.stringify({ type: "input", data: "pwd" }));
      ws.send(JSON.stringify({ type: "input", data: "\r" }));
      await waitForWebSocketOutput(ws, fixture.dir);
    } finally {
      ws.close();
      await waitForClose(ws);
    }
  } finally {
    if (workspaceId) {
      await request.delete(`http://127.0.0.1:4337/api/workspaces/${workspaceId}?archiveOnly=true`);
    }
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function waitForWorkspace(request: APIRequestContext, workspaceId: string, lifecycle: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await request.get("http://127.0.0.1:4337/api/workspaces");
    const body = (await response.json()) as { workspaces: Array<{ id: string; lifecycle: string }> };
    const workspace = body.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace?.lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for workspace ${workspaceId} to become ${lifecycle}`);
}

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name?: string) {
  const repoResponse = await request.post("http://127.0.0.1:4337/api/repos", {
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
  const workspaceResponse = await request.post("http://127.0.0.1:4337/api/workspaces", {
    data: { repoId, name, source: "scratch" },
  });
  expect(workspaceResponse.ok()).toBe(true);
  return (await workspaceResponse.json()) as { workspaceId: string };
}

async function startSession(request: APIRequestContext, workspaceId: string, displayName: string) {
  const sessionResponse = await request.post("http://127.0.0.1:4337/api/agent-sessions", {
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

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket) {
  return new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", () => resolve());
  });
}

function waitForWebSocketOutput(ws: WebSocket, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${expected}`));
    }, 10_000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: string };
      if (message.type === "output" && message.data?.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  });
}
