import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const managedApiPort = process.env.CITADEL_PERFORMANCE_DAEMON_PORT || "14110";
const managedWebPort = process.env.CITADEL_PERFORMANCE_WEB_PORT || "15173";
const managedTmuxSocket = `citadel-perf-${managedApiPort}`.replace(/[^A-Za-z0-9_.-]/g, "-");
const apiBaseUrl = process.env.CITADEL_BASE_URL || `http://127.0.0.1:${managedApiPort}`;
const webBaseUrl = process.env.CITADEL_WEB_URL || `http://127.0.0.1:${managedWebPort}`;
const managedProcesses: ChildProcess[] = [];
const managedDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-perf-runtime-"));
const webVisibleBudgetMs = readPositiveInt(
  process.env.CITADEL_PERF_WEB_VISIBLE_MAX_MS,
  process.env.CI === "true" ? 2500 : 2000,
);
const workspaceSwitchBudgetMs = readPositiveInt(
  process.env.CITADEL_PERF_WORKSPACE_SWITCH_MAX_MS,
  process.env.CI === "true" ? 1500 : 1000,
);

await ensureLocalServices();

const state = await time("api_state", 2000, async () => {
  const response = await fetch(`${apiBaseUrl}/api/state`);
  if (!response.ok) throw new Error(`/api/state returned ${response.status}`);
  return response.json() as Promise<{ repos: Array<{ id: string }> }>;
});

if (state.result.repos[0]) {
  await time("provider_summary", 5000, async () => {
    const response = await fetch(`${apiBaseUrl}/api/repos/${state.result.repos[0]?.id}/provider-summary`);
    if (!response.ok) throw new Error(`/api/repos/:id/provider-summary returned ${response.status}`);
    return response.json();
  });
}

const fixture = createGitFixture();
const workspaceIds: string[] = [];
try {
  const repo = await registerRepo(fixture);
  const first = await createWorkspace(repo.id, `perf-a-${Date.now().toString(36)}`);
  const second = await createWorkspace(repo.id, `perf-b-${Date.now().toString(36)}`);
  workspaceIds.push(first.workspaceId, second.workspaceId);
  await waitForWorkspace(first.workspaceId, "ready");
  await waitForWorkspace(second.workspaceId, "ready");
  const firstSession = await startSession(first.workspaceId, "Perf Shell A");
  const secondSession = await startSession(second.workspaceId, "Perf Shell B");
  await seedTerminal(firstSession.id);
  await seedTerminal(secondSession.id);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let legacyTerminalRequests = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && /^\/api\/agent-sessions\/[^/]+\/terminal$/.test(url.pathname)) {
        legacyTerminalRequests += 1;
      }
    });
    const selectWorkspaceAndSession = async (workspaceName: RegExp, sessionName: string) => {
      const navigator = page.locator("aside[aria-label='Navigator']");
      await navigator.getByRole("button", { name: workspaceName }).click();
      await navigator.locator(".workspace-card.active").filter({ hasText: workspaceName }).waitFor();
      await page.getByRole("button", { name: `Switch to ${sessionName}` }).click();
      await page
        .locator(`.terminal-active .terminal-xterm-host[aria-label="Terminal ${sessionName}"]`)
        .waitFor({ state: "visible" });
    };
    await time("web_ade_visible", webVisibleBudgetMs, async () => {
      await page.goto(webBaseUrl);
      // The current cockpit identifies itself via the cit-brand "Citadel"
      // and the agent-stage main element rather than the old ADE copy.
      await page.locator(".cit-brand").waitFor();
      await page.locator("main[aria-label='Agent stage']").waitFor();
    });
    await time("workspace_switch_long_buffers", workspaceSwitchBudgetMs, async () => {
      await selectWorkspaceAndSession(/perf-a-/i, "Perf Shell A");
      await selectWorkspaceAndSession(/perf-b-/i, "Perf Shell B");
      await selectWorkspaceAndSession(/perf-a-/i, "Perf Shell A");
    });
    await time("workspace_settings_switch", 1000, async () => {
      await page.getByRole("link", { name: "Settings" }).first().click();
      await page.waitForURL("**/settings");
      await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
      // The Settings redesign dropped the duplicate "Workspaces" top-right
      // link; the back-to-cockpit chip in the topbar is the canonical exit.
      await page.locator("a.set-back").click();
      await page.locator("main[aria-label='Agent stage']").waitFor();
    });
    if (legacyTerminalRequests > 0) {
      throw new Error(`Cockpit hit legacy terminal ensure ${legacyTerminalRequests} time(s) during smoke`);
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const workspaceId of workspaceIds) {
    await fetch(`${apiBaseUrl}/api/workspaces/${workspaceId}?archiveOnly=true`, { method: "DELETE" });
  }
  for (const child of managedProcesses) child.kill("SIGTERM");
  if (!process.env.CITADEL_BASE_URL) {
    try {
      execFileSync("tmux", ["-L", managedTmuxSocket, "kill-server"], { stdio: "ignore" });
    } catch {
      // The daemon may already have stopped its owned tmux server.
    }
  }
  fs.rmSync(managedDataDir, { recursive: true, force: true });
  fs.rmSync(fixture.dir, { recursive: true, force: true });
}

async function ensureLocalServices() {
  const externalApi = Boolean(process.env.CITADEL_BASE_URL);
  const externalWeb = Boolean(process.env.CITADEL_WEB_URL);
  if (!externalApi && !(await canFetch(`${apiBaseUrl}/api/health`))) {
    managedProcesses.push(
      spawn("pnpm", ["--filter", "@citadel/daemon", "dev"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CITADEL_PORT: managedApiPort,
          CITADEL_DATA_DIR: managedDataDir,
          CITADEL_CONFIG: path.join(managedDataDir, "citadel.config.json"),
          CITADEL_TMUX_SOCKET: managedTmuxSocket,
          CITADEL_OWN_TMUX_SOCKET: "1",
          CITADEL_DISABLE_BOOT_RESTORE: "1",
          CITADEL_DISABLE_REAPER: "1",
          CITADEL_DISABLE_STATUS_MONITOR: "1",
          CITADEL_DISABLE_SCHEDULER: "1",
          CITADEL_AUTO_RECOVERY_DISABLED: "1",
          CITADEL_DISABLE_AUTO_RESUME: "1",
          CITADEL_DISABLE_FS_WATCHERS: "1",
          CITADEL_DISABLE_TERMINAL_REAPER: "1",
          CITADEL_GH_SCHEDULER_DISABLED: "1",
          CITADEL_MAIN_WATCHER_DISABLED: "1",
        },
        stdio: "ignore",
      }),
    );
  }
  if (!externalWeb && !(await canFetch(webBaseUrl))) {
    managedProcesses.push(
      spawn("pnpm", ["--filter", "@citadel/web", "dev", "--", "--host", "127.0.0.1", "--port", managedWebPort], {
        cwd: process.cwd(),
        env: { ...process.env, CITADEL_DAEMON_URL: apiBaseUrl, CITADEL_WEB_PORT: managedWebPort },
        stdio: "ignore",
      }),
    );
  }
  await waitForHttp(`${apiBaseUrl}/api/health`, 15_000);
  await waitForHttp(webBaseUrl, 15_000);
}

async function canFetch(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForHttp(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canFetch(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function time<T>(name: string, maxMs: number, fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  console.log(`${name} ${durationMs}ms`);
  if (durationMs > maxMs) throw new Error(`${name} exceeded ${maxMs}ms`);
  return { durationMs, result };
}

function readPositiveInt(raw: string | undefined, fallback: number) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function registerRepo(fixture: ReturnType<typeof createGitFixture>) {
  const response = await fetch(`${apiBaseUrl}/api/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rootPath: fixture.repoPath,
      name: `Perf ${Date.now().toString(36)}`,
      worktreeParent: path.join(fixture.dir, "worktrees"),
    }),
  });
  if (!response.ok) throw new Error(`repo registration returned ${response.status}`);
  return ((await response.json()) as { repo: { id: string } }).repo;
}

async function createWorkspace(repoId: string, name: string) {
  const response = await fetch(`${apiBaseUrl}/api/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId, name, source: "scratch" }),
  });
  if (!response.ok) throw new Error(`workspace create returned ${response.status}`);
  return (await response.json()) as { workspaceId: string };
}

async function startSession(workspaceId: string, displayName: string) {
  const response = await fetch(`${apiBaseUrl}/api/agent-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, runtimeId: "shell", displayName }),
  });
  if (!response.ok) throw new Error(`session create returned ${response.status}`);
  return ((await response.json()) as { session: { id: string } }).session;
}

async function waitForWorkspace(workspaceId: string, lifecycle: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${apiBaseUrl}/api/workspaces`);
    const body = (await response.json()) as { workspaces: Array<{ id: string; lifecycle: string }> };
    if (body.workspaces.find((workspace) => workspace.id === workspaceId)?.lifecycle === lifecycle) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for workspace ${workspaceId}`);
}

async function seedTerminal(sessionId: string) {
  const ws = new WebSocket(`${apiBaseUrl.replace(/^http/, "ws")}/terminal/${sessionId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.send(Buffer.from(`printf '${"terminal-buffer-line\\n".repeat(600)}'\\r`, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  ws.close();
}

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-perf-"));
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel Perf"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# perf\n");
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
