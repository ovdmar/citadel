import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitFixtureWithRemote as createGitFixtureWithRemoteBase,
  createGitRepo as createGitRepoBase,
  getJson,
  listen,
  postJson,
  putJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeFixtureDir(dir);
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("createDaemonApp", () => {
  it("keeps HTTP sockets alive across normal browser interaction gaps", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);

    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(125_000);
  });

  it("serves config, runtime, MCP, and error endpoints without starting the production listener", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const configResponse = await getJson<{ configPath: string; config: { mcp: { enabled: boolean } } }>(
        `${baseUrl}/api/config`,
      );
      expect(configResponse.configPath).toBe(fixture.configPath);
      expect(configResponse.config.mcp.enabled).toBe(true);

      const updated = await putJson<{
        config: { mcp: { enabled: boolean }; providers: { jira: { enabled: boolean } } };
      }>(`${baseUrl}/api/config`, {
        mcp: { enabled: false },
        providers: { github: { enabled: false }, jira: { enabled: false } },
      });
      expect(updated.config.mcp.enabled).toBe(false);
      expect(updated.config.providers.jira.enabled).toBe(false);
      expect(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).mcp.enabled).toBe(false);
      expect(
        (await getJson<{ activity: Array<{ type: string }> }>(`${baseUrl}/api/activity`)).activity[0],
      ).toMatchObject({
        type: "settings.updated",
      });

      const invalidConfig = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hooks: [{ id: "setup", event: "workspace.setup", command: "true", cwd: "relative" }],
        }),
      });
      expect(invalidConfig.status).toBe(400);
      expect(await invalidConfig.json()).toMatchObject({
        error: "validation_failed",
        issues: [expect.objectContaining({ path: "hooks.0.cwd" })],
      });

      const mcpStatus = await getJson<{ enabled: boolean }>(`${baseUrl}/api/mcp/status`);
      expect(mcpStatus.enabled).toBe(false);

      const disabledToolCall = await fetch(`${baseUrl}/api/mcp/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "inspect_status" }),
      });
      expect(disabledToolCall.status).toBe(503);

      const missingRuntime = await fetch(`${baseUrl}/api/agent-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_missing", runtimeId: "missing" }),
      });
      expect(missingRuntime.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("serves read-only state resources and normalized API errors", async () => {
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      expect(await getJson<{ ok: boolean; degradedProviders: number }>(`${baseUrl}/api/health`)).toMatchObject({
        ok: true,
        degradedProviders: 2,
      });
      expect(
        await getJson<{ repos: unknown[]; workspaces: unknown[]; sessions: unknown[] }>(`${baseUrl}/api/state`),
      ).toMatchObject({
        repos: [],
        workspaces: [],
        sessions: [],
      });
      expect(await getJson<{ repos: unknown[] }>(`${baseUrl}/api/repos`)).toEqual({ repos: [] });
      expect(await getJson<{ workspaces: unknown[] }>(`${baseUrl}/api/workspaces`)).toEqual({ workspaces: [] });
      expect(await getJson<{ repos: unknown[] }>(`${baseUrl}/api/mcp/resources/repos`)).toEqual({ repos: [] });
      expect(
        await getJson<{ providerHealth: unknown[] }>(`${baseUrl}/api/mcp/resources/provider-health`),
      ).toMatchObject({
        providerHealth: [expect.objectContaining({ id: "github-gh" }), expect.objectContaining({ id: "jira-jtk" })],
      });
      expect(await getJson<{ agentRuntimes: unknown[] }>(`${baseUrl}/api/agent-runtimes`)).toMatchObject({
        agentRuntimes: [expect.objectContaining({ id: "test-agent" })],
      });
      expect(
        await getJson<{ usage: { runtimeId: string; status: string } }>(`${baseUrl}/api/runtimes/test-agent/usage`),
      ).toMatchObject({
        usage: { runtimeId: "test-agent", status: "unavailable" },
      });
      expect(await getJson<{ activity: unknown[] }>(`${baseUrl}/api/activity`)).toEqual({ activity: [] });
      expect(await getJson<{ activity: unknown[] }>(`${baseUrl}/api/mcp/resources/activity`)).toEqual({
        activity: [],
      });
      expect(
        await getJson<{ repos: unknown[]; workspaces: unknown[]; sessions: unknown[] }>(
          `${baseUrl}/api/mcp/resources/workspaces`,
        ),
      ).toEqual({ repos: [], workspaces: [], sessions: [] });
      expect(
        await postJson<{ result: { repos: number; workspaces: number; sessions: number } }>(
          `${baseUrl}/api/mcp/tools/call`,
          {
            name: "inspect_status",
          },
        ),
      ).toMatchObject({ result: { repos: 0, workspaces: 0, sessions: 0 } });
      expect(
        await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      ).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "create_workspace" }),
            expect.objectContaining({ name: "list_workspace_links" }),
          ]),
        },
      });
      expect(
        await postJson<{ result: { protocolVersion: string } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        }),
      ).toMatchObject({ result: { protocolVersion: "2024-11-05" } });
      expect(
        (
          await fetch(`${baseUrl}/api/mcp/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          })
        ).status,
      ).toBe(202);
      expect(
        await postJson<{ result: { content: Array<{ text: string }>; structuredContent: { repos: number } } }>(
          `${baseUrl}/api/mcp/rpc`,
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "inspect_status" },
          },
        ),
      ).toMatchObject({
        result: {
          content: [expect.objectContaining({ type: "text" })],
          structuredContent: expect.objectContaining({ repos: 0 }),
        },
      });
      expect(
        await postJson<{ error: { code: number; message: string } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: "tool-error",
          method: "tools/call",
          params: {
            name: "start_agent_session",
            arguments: { workspaceId: "ws_test", runtimeId: "missing" },
          },
        }),
      ).toMatchObject({
        jsonrpc: "2.0",
        id: "tool-error",
        error: { code: -32000, message: "Unknown runtime: missing" },
      });
      expect(
        await postJson<{ result: Record<string, never> }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: "ping",
          method: "ping",
        }),
      ).toEqual({ jsonrpc: "2.0", id: "ping", result: {} });
      expect(
        await postJson<{ result: { contents: Array<{ text: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "citadel://workspaces" },
        }),
      ).toMatchObject({
        result: {
          contents: [
            expect.objectContaining({
              mimeType: "application/json",
              text: JSON.stringify({ repos: [], workspaces: [], sessions: [] }),
            }),
          ],
        },
      });
      expect(
        await postJson<{ result: { contents: Array<{ text: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 4,
          method: "resources/read",
          params: { uri: "citadel://provider-health" },
        }),
      ).toMatchObject({
        result: {
          contents: [
            expect.objectContaining({
              text: expect.stringContaining("github-gh"),
            }),
          ],
        },
      });
      expect(
        await postJson<{ result: { contents: Array<{ text: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 5,
          method: "resources/read",
          params: { uri: "citadel://activity" },
        }),
      ).toMatchObject({
        result: { contents: [expect.objectContaining({ text: JSON.stringify({ activity: [] }) })] },
      });

      expect((await fetch(`${baseUrl}/api/repos/repo_missing/provider-summary`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/workspaces/ws_missing/diff`)).status).toBe(404);
      expect(
        (
          await fetch(`${baseUrl}/api/repos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoId: "bad id", name: "" }),
          })
        ).status,
      ).toBe(400);
    } finally {
      await closeServer(server);
    }
  }, 15_000);

  it("rehydrates provider cache on boot and serves /provider-summary without invoking providers", async () => {
    // Central regression guard for the persistent-cache PR's headline AC:
    // after daemon restart, cockpit pills must render immediately from cache.
    // The provider collector is mocked to THROW — if the route serves a body
    // anyway, hydration is working.
    const fixture = createFixture();
    const now = new Date().toISOString();
    const repoId = "repo_warm_boot";
    fixture.store.insertRepo({
      id: repoId,
      name: "Warm Boot Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    // Need the repo's actual updatedAt for the cache key (the store may
    // normalize it at insert time).
    const repos = fixture.store.listRepos();
    const repoUpdatedAt = repos.find((r) => r.id === repoId)?.updatedAt ?? now;

    // Seed provider-cache.json BEFORE the daemon boots so load() hydrates it.
    fs.writeFileSync(
      path.join(fixture.config.dataDir, "provider-cache.json"),
      JSON.stringify({
        version: 1,
        savedAt: now,
        entries: [
          [
            `vc:${repoId}:${repoUpdatedAt}`,
            {
              expiresAt: Date.now() + 60_000,
              cachedAt: Date.now(),
              value: {
                providerId: "github-gh",
                status: "healthy",
                reason: null,
                defaultBranch: "main",
                currentBranch: "main",
                remotes: ["origin"],
                pullRequest: null,
                checkedAt: now,
              },
            },
          ],
        ],
      }),
    );

    let providerCalls = 0;
    const { server } = await createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => {
          providerCalls += 1;
          throw new Error("provider should not be invoked when cache is warm");
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{ versionControl: { status: string; defaultBranch: string | null } }>(
        `${baseUrl}/api/repos/${repoId}/provider-summary`,
      );
      // Cached value flowed through; provider was never called.
      expect(providerCalls).toBe(0);
      expect(body.versionControl.status).toBe("healthy");
      expect(body.versionControl.defaultBranch).toBe("main");
    } finally {
      await closeServer(server);
    }
  });

  it("caches provider summaries and clears them on config updates", async () => {
    const fixture = createFixture();
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_cache",
      name: "Cache Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    let calls = 0;
    const { server } = await createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => {
          calls += 1;
          return {
            providerId: "github-gh",
            status: "healthy",
            reason: null,
            defaultBranch: "main",
            currentBranch: "main",
            remotes: ["origin"],
            pullRequest: null,
            checkedAt: new Date().toISOString(),
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      expect(calls).toBe(1);

      await putJson(`${baseUrl}/api/config`, {
        providers: { github: { enabled: true }, jira: { enabled: false } },
      });
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      expect(calls).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("starts agent sessions through the MCP JSON-RPC tool surface", async () => {
    const fixture = createFixture();
    let runtimeCommand = "";
    const operations = {
      createAgentSession: async (
        input: { workspaceId: string; runtimeId: string; displayName?: string },
        runtime: { command: string },
      ) => {
        runtimeCommand = runtime.command;
        return {
          id: "sess_mcp",
          workspaceId: input.workspaceId,
          kind: "agent",
          runtimeId: input.runtimeId,
          displayName: input.displayName ?? "MCP Agent",
          status: "running",
          transport: "disconnected",
          tmuxSessionName: "citadel_mcp",
          tmuxSessionId: "$mcp",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    } as unknown as OperationService;
    const { server } = await createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const response = await postJson<{ result: { structuredContent: { session: { id: string } } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "start_agent_session",
            arguments: { workspaceId: "ws_test", runtimeId: "test-agent", displayName: "MCP Agent" },
          },
        },
      );

      expect(response.result.structuredContent.session.id).toBe("sess_mcp");
      expect(runtimeCommand).toBe("bash");
    } finally {
      await closeServer(server);
    }
  });

  it("serves workspace cockpit summaries with readiness, git status, apps, and hook diagnostics", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.config.hooks = [
      {
        id: "apps",
        kind: "command",
        event: "workspace.apps",
        command: "node",
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({applications:[{id:'preview',label:'Preview',kind:'preview',url:'https://example.test/preview',status:'healthy'}],links:[{label:'Docs',url:'https://example.test/docs',kind:'docs'}],actions:[{id:'redeploy',label:'Redeploy',kind:'redeploy',executable:true}]}))",
        ],
        blocking: false,
      },
    ];
    fixture.config.repoDefaults.appHookIds = ["apps"];
    fixture.store.insertRepo({
      id: "repo_cockpit",
      name: "Cockpit Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_cockpit",
      repoId: "repo_cockpit",
      name: "Cockpit Workspace",
      path: git.repoPath,
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: true,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fs.writeFileSync(path.join(git.repoPath, "dirty.txt"), "dirty\n");
    const { server } = await createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => ({
          providerId: "github-gh",
          status: "healthy",
          reason: null,
          defaultBranch: "main",
          currentBranch: "feature",
          remotes: ["origin"],
          pullRequest: {
            number: 42,
            title: "Cockpit PR",
            url: "https://example.test/pr/42",
            state: "OPEN",
            draft: false,
            reviewDecision: "REVIEW_REQUIRED",
            additions: 9,
            deletions: 2,
            checks: [
              {
                name: "unit",
                status: "COMPLETED",
                conclusion: "SUCCESS",
                url: "https://example.test/check",
                startedAt: null,
                completedAt: null,
              },
            ],
            reviewers: [],
            commits: [],
            headRefName: "feature",
            parentPr: null,
            mergeable: "unknown" as const,
            allowedMergeStrategies: [],
            mergeStateStatus: null,
            headSha: null,
          },
          checkedAt: now,
        }),
        collectGitHubCiRuns: async () => ({
          providerId: "github-gh",
          status: "healthy",
          reason: null,
          runs: [],
          checkedAt: now,
        }),
      },
    });
    const baseUrl = await listen(server);
    try {
      const summary = await getJson<{
        readiness: { state: string; nextAction: string };
        git: { clean: boolean; untracked: number };
        versionControl: { pullRequest: { number: number; additions: number; deletions: number } };
        apps: { applications: unknown[]; actions: Array<{ id: string; executable: boolean }> };
      }>(`${baseUrl}/api/workspaces/ws_cockpit/cockpit-summary`);

      expect(summary.readiness.state).toBe("dirty");
      expect(summary.git.clean).toBe(false);
      expect(summary.git.untracked).toBe(1);
      expect(summary.versionControl.pullRequest).toMatchObject({ number: 42, additions: 9, deletions: 2 });
      expect(summary.apps.applications).toHaveLength(1);
      expect(summary.apps.actions[0]).toMatchObject({ id: "redeploy", executable: true });

      const diagnostics = await getJson<{ diagnostics: Array<{ hookId: string }>; sample: unknown }>(
        `${baseUrl}/api/repos/repo_cockpit/hook-diagnostics`,
      );
      expect(diagnostics.diagnostics).toEqual([expect.objectContaining({ hookId: "apps" })]);
      expect(diagnostics.sample).toMatchObject({ applications: expect.any(Array), actions: expect.any(Array) });
    } finally {
      await closeServer(server);
    }
  });

  it("PATCH /api/repos/:id updates name and worktree parent", async () => {
    const fixture = createFixture();
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const repoResp = await postJson<{ repo: { id: string; name: string } }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "Before",
      });
      const patched = await fetch(`${baseUrl}/api/repos/${repoResp.repo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "After", worktreeParent: "/tmp/citadel-wt-test" }),
      });
      expect(patched.status).toBe(200);
      const body = (await patched.json()) as { repo: { name: string; worktreeParent: string } };
      expect(body.repo.name).toBe("After");
      expect(body.repo.worktreeParent).toBe("/tmp/citadel-wt-test");
    } finally {
      await closeServer(server);
    }
  });

  it("inspects a path, lists branches, refreshes provider caches, and reconciles ghost state", async () => {
    const fixture = createFixture();
    const { repoPath } = createGitRepo(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const inspect = await postJson<{ isGit: boolean; defaultBranch: string | null; providerCandidates: unknown[] }>(
        `${baseUrl}/api/repos/inspect`,
        { rootPath: repoPath },
      );
      expect(inspect.isGit).toBe(true);
      expect(inspect.providerCandidates.length).toBeGreaterThan(0);

      const repoResp = await postJson<{ repo: { id: string } }>(`${baseUrl}/api/repos`, { rootPath: repoPath });
      const repoId = repoResp.repo.id;

      const branches = await getJson<{ defaultBranch: string; local: string[]; remote: string[] }>(
        `${baseUrl}/api/repos/${repoId}/branches`,
      );
      expect(branches.local.length).toBeGreaterThan(0);

      const refresh = await fetch(`${baseUrl}/api/repos/${repoId}/refresh`, { method: "POST" });
      expect(refresh.status).toBe(200);

      const reconcile = await fetch(`${baseUrl}/api/reconcile`, { method: "POST" });
      expect(reconcile.status).toBe(200);
      const body = (await reconcile.json()) as { sessions: number };
      expect(typeof body.sessions).toBe("number");
    } finally {
      await closeServer(server);
    }
  });

  it("stops and removes an agent session through DELETE /api/agent-sessions/:id", async () => {
    const fixture = createFixture();
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const repoResp = await postJson<{ repo: { id: string } }>(`${baseUrl}/api/repos`, { rootPath: repoPath });
      const workspaceResp = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces`, {
        repoId: repoResp.repo.id,
        name: "stop-target",
        source: "scratch",
      });
      // Wait for workspace.create to land.
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = await getJson<{ workspaces: Array<{ id: string; lifecycle: string }> }>(
          `${baseUrl}/api/workspaces`,
        );
        if (state.workspaces.find((w) => w.id === workspaceResp.workspaceId)?.lifecycle === "ready") {
          ready = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(ready).toBe(true);
      const sessionResp = await postJson<{ session: { id: string } }>(`${baseUrl}/api/agent-sessions`, {
        workspaceId: workspaceResp.workspaceId,
        runtimeId: "test-agent",
      });
      const stop = await fetch(`${baseUrl}/api/agent-sessions/${sessionResp.session.id}`, { method: "DELETE" });
      expect(stop.status).toBe(202);
      const state = await getJson<{ sessions: Array<{ id: string; status: string }> }>(`${baseUrl}/api/state`);
      const updated = state.sessions.find((s) => s.id === sessionResp.session.id);
      expect(updated).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  }, 20_000);

  it("removes repositories through a tracked operation with explicit active-session confirmation", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_remove",
      name: "Remove Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_remove",
      repoId: "repo_remove",
      name: "Remove Workspace",
      path: git.repoPath,
      branch: "main",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertSession({
      id: "sess_remove",
      workspaceId: "ws_remove",
      runtimeId: "test-agent",
      displayName: "Test Agent",
      status: "running",
      transport: "disconnected",
      tmuxSessionName: null,
      tmuxSessionId: null,
      createdAt: now,
      updatedAt: now,
    });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const blocked = await fetch(`${baseUrl}/api/repos/repo_remove`, { method: "DELETE" });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ removed: false, activeSessions: 1 });
      expect((await getJson<{ repos: unknown[] }>(`${baseUrl}/api/repos`)).repos).toHaveLength(1);

      const removed = await fetch(`${baseUrl}/api/repos/repo_remove?force=true`, { method: "DELETE" });
      expect(removed.status).toBe(202);
      expect(await removed.json()).toMatchObject({ removed: true, archivedWorkspaces: 1, cleanupWorktrees: false });
      expect((await getJson<{ repos: unknown[] }>(`${baseUrl}/api/repos`)).repos).toEqual([]);
      expect((await getJson<{ workspaces: unknown[] }>(`${baseUrl}/api/workspaces`)).workspaces).toEqual([]);
      expect(
        (await getJson<{ activity: Array<{ type: string }> }>(`${baseUrl}/api/activity`)).activity[0],
      ).toMatchObject({
        type: "repo.removed",
      });
    } finally {
      await closeServer(server);
    }
  });
});

// Local sugar: pre-bind the `dirs` array shared across this test file so
// individual `it()` blocks can keep calling `createFixture()` without
// threading the cleanup list through every helper site.
const createFixture = () => createFixtureBase(dirs);
const createGitFixtureWithRemote = (parent: string) => createGitFixtureWithRemoteBase(parent);
const createGitRepo = (dir: string) => createGitRepoBase(dir);

async function removeFixtureDir(dir: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(code ?? "") || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
