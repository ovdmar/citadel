import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import WebSocket from "ws";

test("operator cockpit renders key local-first views", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtime Launch" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Terminal" })).toBeVisible();
  await expect(page.getByLabel("Repo path")).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-cockpit.png`, fullPage: true });
});

test("settings renders runtime and MCP visibility", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Local Config" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtimes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save config" })).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-settings.png`, fullPage: true });
});

test("desktop smoke creates a workspace and reaches its terminal", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "workflow smoke runs once against the shared local daemon");
  const fixture = createGitFixture();
  let workspaceId: string | null = null;
  try {
    const repoResponse = await request.post("http://127.0.0.1:4337/api/repos", {
      data: {
        rootPath: fixture.repoPath,
        name: `E2E ${Date.now().toString(36)}`,
        worktreeParent: path.join(fixture.dir, "worktrees"),
      },
    });
    expect(repoResponse.ok()).toBe(true);
    const repo = ((await repoResponse.json()) as { repo: { id: string } }).repo;

    const workspaceResponse = await request.post("http://127.0.0.1:4337/api/workspaces", {
      data: { repoId: repo.id, name: `e2e-${Date.now().toString(36)}`, source: "scratch" },
    });
    expect(workspaceResponse.ok()).toBe(true);
    workspaceId = ((await workspaceResponse.json()) as { workspaceId: string }).workspaceId;
    await waitForWorkspace(request, workspaceId, "ready");

    const sessionResponse = await request.post("http://127.0.0.1:4337/api/agent-sessions", {
      data: { workspaceId, runtimeId: "shell", displayName: "E2E Shell" },
    });
    expect(sessionResponse.ok()).toBe(true);
    const session = ((await sessionResponse.json()) as { session: { id: string } }).session;

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
