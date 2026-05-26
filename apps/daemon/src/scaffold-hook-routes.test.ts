import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asyncRoute } from "./app-helpers.js";
import {
  buildHookScaffoldPrompt,
  findInFlightScaffold,
  registerScaffoldHookRoutes,
} from "./scaffold-hook-routes.js";

const TEST_TEMPLATE = "#!/usr/bin/env bash\n# canonical citadel deploy template\necho stub\n";

function fakeRepo(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    name: "demo",
    rootPath: "/abs/path/demo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/abs/path",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function fakeWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws1",
    repoId: "r1",
    name: "hook-scaffold-abc",
    branch: "hook-scaffold-abc",
    path: "/abs/path/hook-scaffold-abc",
    lifecycle: "ready",
    source: "scratch",
    kind: "worktree",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    ...overrides,
  };
}

function fakeConfig() {
  return {
    runtimes: [
      {
        id: "claude-code",
        displayName: "Claude Code",
        command: "claude",
        args: [],
      },
    ],
  } as unknown as Parameters<typeof registerScaffoldHookRoutes>[0]["config"];
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function bootApp(opts: {
  repos: ReturnType<typeof fakeRepo>[];
  workspaces?: ReturnType<typeof fakeWorkspace>[];
  sessions?: Array<{ id: string; status: string }>;
  launchAgent?: ReturnType<typeof vi.fn>;
}) {
  const app = express();
  app.use(express.json());
  const store = {
    listRepos: () => opts.repos,
    listWorkspaces: () => opts.workspaces ?? [],
    listSessions: () => opts.sessions ?? [],
  } as unknown as Parameters<typeof registerScaffoldHookRoutes>[0]["store"];

  const launchAgent =
    opts.launchAgent ??
    vi.fn().mockResolvedValue({
      workspaceId: "ws_new",
      sessionId: "sess_new",
      branchName: "hook-scaffold-xyz",
      workspacePath: "/abs/path/hook-scaffold-xyz",
      operationId: "op_new",
    });

  const operations = {
    launchAgent,
  } as unknown as Parameters<typeof registerScaffoldHookRoutes>[0]["operations"];

  registerScaffoldHookRoutes({
    app,
    config: fakeConfig(),
    store,
    operations,
    asyncRoute,
    loadTemplate: () => TEST_TEMPLATE,
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push({ close: () => server.close() });
  return { port, launchAgent };
}

async function postScaffold(port: number, repoId: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/repos/${repoId}/scaffold-hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return { status: res.status, body: await res.json() };
}

describe("buildHookScaffoldPrompt", () => {
  it("includes the repo's name and root path", () => {
    const repo = fakeRepo({ name: "demo-repo", rootPath: "/x/y/demo-repo" });
    const prompt = buildHookScaffoldPrompt({ repo, template: TEST_TEMPLATE });
    expect(prompt).toContain("demo-repo");
    expect(prompt).toContain("/x/y/demo-repo");
  });

  it("embeds the canonical template inside a bash code fence", () => {
    const repo = fakeRepo();
    const prompt = buildHookScaffoldPrompt({ repo, template: TEST_TEMPLATE });
    expect(prompt).toContain(TEST_TEMPLATE.trim());
    expect(prompt).toMatch(/```bash[\s\S]*canonical citadel deploy template[\s\S]*```/);
  });

  it("instructs validation via `./.citadel/hooks/deploy list`", () => {
    const prompt = buildHookScaffoldPrompt({ repo: fakeRepo(), template: TEST_TEMPLATE });
    expect(prompt).toMatch(/\.\/\.citadel\/hooks\/deploy list/);
  });

  it("instructs the agent to chmod +x", () => {
    const prompt = buildHookScaffoldPrompt({ repo: fakeRepo(), template: TEST_TEMPLATE });
    expect(prompt).toMatch(/chmod \+x .*\.citadel\/hooks\/deploy/);
  });
});

describe("findInFlightScaffold", () => {
  it("finds an in-flight hook-scaffold-* workspace for the repo", () => {
    const ws = fakeWorkspace({ branch: "hook-scaffold-abc123", lifecycle: "ready" });
    const result = findInFlightScaffold({
      store: {
        listWorkspaces: () => [ws],
        listSessions: () => [{ id: "sess_run", status: "running" }],
      } as unknown as Parameters<typeof findInFlightScaffold>[0]["store"],
      repoId: ws.repoId,
    });
    expect(result?.workspaceId).toBe(ws.id);
    expect(result?.sessionId).toBe("sess_run");
  });

  it("returns null when there is no matching workspace", () => {
    const result = findInFlightScaffold({
      store: {
        listWorkspaces: () => [],
        listSessions: () => [],
      } as unknown as Parameters<typeof findInFlightScaffold>[0]["store"],
      repoId: "r1",
    });
    expect(result).toBeNull();
  });

  it("ignores workspaces whose branch doesn't start with hook-scaffold-", () => {
    const ws = fakeWorkspace({ branch: "feature/something" });
    const result = findInFlightScaffold({
      store: {
        listWorkspaces: () => [ws],
        listSessions: () => [],
      } as unknown as Parameters<typeof findInFlightScaffold>[0]["store"],
      repoId: ws.repoId,
    });
    expect(result).toBeNull();
  });

  it("ignores workspaces that aren't lifecycle=ready", () => {
    const ws = fakeWorkspace({ branch: "hook-scaffold-x", lifecycle: "creating" });
    const result = findInFlightScaffold({
      store: {
        listWorkspaces: () => [ws],
        listSessions: () => [],
      } as unknown as Parameters<typeof findInFlightScaffold>[0]["store"],
      repoId: ws.repoId,
    });
    expect(result).toBeNull();
  });
});

describe("POST /api/repos/:repoId/scaffold-hook", () => {
  it("returns 404 when the repo id is unknown", async () => {
    const { port } = await bootApp({ repos: [] });
    const { status, body } = await postScaffold(port, "nope");
    expect(status).toBe(404);
    expect(body).toEqual({ error: "repo_not_found" });
  });

  it("creates a new scaffold workspace with reused=false when no in-flight exists", async () => {
    const repo = fakeRepo();
    const launchAgent = vi.fn().mockResolvedValue({
      workspaceId: "ws_new",
      sessionId: "sess_new",
      branchName: "hook-scaffold-xyz",
      workspacePath: "/abs/x",
      operationId: "op",
    });
    const { port } = await bootApp({ repos: [repo], launchAgent });
    const { status, body } = await postScaffold(port, repo.id);
    expect(status).toBe(201);
    expect(body.reused).toBe(false);
    expect(body.workspaceId).toBe("ws_new");

    expect(launchAgent).toHaveBeenCalledTimes(1);
    const call = launchAgent.mock.calls[0];
    if (!call) throw new Error("expected launchAgent call");
    const [launchInput, runtime] = call;
    expect(launchInput.repoId).toBe(repo.id);
    expect(launchInput.runtimeId).toBe("claude-code");
    expect((launchInput.branchName as string).startsWith("hook-scaffold-")).toBe(true);
    expect(launchInput.prompt).toContain("canonical citadel deploy template");
    expect(runtime.displayName).toBe("Claude Code");
  });

  it("reuses an in-flight scaffold workspace on a second click", async () => {
    const repo = fakeRepo();
    const inFlight = fakeWorkspace({ branch: "hook-scaffold-abc", lifecycle: "ready", repoId: repo.id });
    const launchAgent = vi.fn();
    const { port } = await bootApp({
      repos: [repo],
      workspaces: [inFlight],
      sessions: [{ id: "sess_run", status: "running" }],
      launchAgent,
    });
    const { status, body } = await postScaffold(port, repo.id);
    expect(status).toBe(200);
    expect(body.reused).toBe(true);
    expect(body.workspaceId).toBe(inFlight.id);
    expect(body.sessionId).toBe("sess_run");
    expect(launchAgent).not.toHaveBeenCalled();
  });

  it("surfaces launchAgent.error as 409", async () => {
    const repo = fakeRepo();
    const launchAgent = vi.fn().mockResolvedValue({
      workspaceId: "ws_x",
      sessionId: null,
      branchName: "hook-scaffold-y",
      workspacePath: "/x",
      operationId: "op_y",
      error: "git_clone_failed",
    });
    const { port } = await bootApp({ repos: [repo], launchAgent });
    const { status, body } = await postScaffold(port, repo.id);
    expect(status).toBe(409);
    expect(body.error).toBe("scaffold_failed");
    expect(body.detail).toBe("git_clone_failed");
  });
});

describe("hook template file (drift guard)", () => {
  it("on-disk template contains the canonical contract", async () => {
    // Read directly from the file the scaffolder ships — protects against
    // accidental removal of the canonical contract markers.
    const { loadHookTemplate } = await import("./scaffold-hook-routes.js");
    const content = loadHookTemplate();
    expect(content).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(content).toContain("Citadel deploy hook");
    expect(content).toMatch(/case "\${1:-}"/);
    expect(content).toContain("list)");
    expect(content).toContain("redeploy)");
  });
});
