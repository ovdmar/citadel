import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  getJson,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

function createFixture() {
  return createFixtureBase(dirs);
}

describe("registerJiraRoutes", () => {
  it("GET /api/integrations/jira/search returns IssueSearchResponse from the provider", async () => {
    const fixture = createFixture();
    let observed: string | null = "<unset>";
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        searchJiraIssues: async (query) => {
          observed = query;
          return {
            status: "healthy",
            reason: null,
            results: [{ key: "MS-1", summary: "Wire picker", status: "In Progress", url: null, updated: null }],
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      const response = await getJson<{
        status: string;
        results: Array<{ key: string }>;
      }>(`${baseUrl}/api/integrations/jira/search?q=AUTH-1`);
      expect(observed).toBe("AUTH-1");
      expect(response.status).toBe("healthy");
      expect(response.results).toHaveLength(1);
      expect(response.results[0]?.key).toBe("MS-1");
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/integrations/jira/search with no q forwards null (recent-default path)", async () => {
    const fixture = createFixture();
    let observed: string | null | undefined;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        searchJiraIssues: async (query) => {
          observed = query;
          return { status: "healthy", reason: null, results: [] };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      await getJson(`${baseUrl}/api/integrations/jira/search`);
      // Express omits absent query strings entirely; the route must pass
      // null (not undefined) to the provider so the recent-default JQL
      // path runs.
      expect(observed).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("GET /api/integrations/jira/search returns 200 with a degraded payload when the provider fails", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        searchJiraIssues: async () => ({
          status: "degraded",
          reason: "jtk not authenticated",
          results: [],
        }),
      },
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/integrations/jira/search?q=x`);
      // Degraded provider responses are still 200 — the picker UI
      // distinguishes "search failed" from "no matches" by inspecting
      // `status`, and we don't want fetch-thrown errors derailing the
      // popover.
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "degraded",
        reason: "jtk not authenticated",
        results: [],
      });
    } finally {
      await closeServer(server);
    }
  });

  it("PATCH /api/workspaces/:id fires workspace.issue_attached when issueKey transitions null → value", async () => {
    const fixture = createFixture();
    fixture.config.providers.jira.autoTransitions = [
      { event: "workspace.issue_attached", transition: "In Progress" },
    ];
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_p",
      name: "Patch Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: `${fixture.config.dataDir}/worktrees`,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_p",
      repoId: "repo_p",
      name: "ws-p",
      path: `${fixture.config.dataDir}/ws-p`,
      branch: "ws-p",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "in-progress",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    const summary = {
      providerId: "jira-jtk" as const,
      status: "healthy" as const,
      reason: null,
      key: "AUTH-9",
      summary: null,
      issueStatus: "To Do",
      assignee: null,
      updated: null,
      url: null,
      transitions: [{ id: "21", name: "Start Progress", toStatus: "In Progress" }],
      checkedAt: now,
    };
    let transitionCalls = 0;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        collectJiraIssueSummary: async () => summary,
        transitionJiraIssue: async (input) => {
          transitionCalls += 1;
          return {
            providerId: "jira-jtk",
            status: "healthy",
            reason: null,
            key: input.issueKey,
            transition: input.transition,
            checkedAt: now,
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      // Attach: null → value MUST fire.
      const attachResp = await fetch(`${baseUrl}/api/workspaces/ws_p`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: "AUTH-9", issueTitle: null, issueUrl: null }),
      });
      expect(attachResp.status).toBe(200);
      // Wait one tick — the auto-transition is awaited inside the PATCH
      // handler, so a successful 200 means the fire-and-await has
      // completed. transitionCalls reflects the actual fire.
      expect(transitionCalls).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it("PATCH /api/workspaces/:id does NOT fire workspace.issue_attached on unattach or no-op", async () => {
    const fixture = createFixture();
    fixture.config.providers.jira.autoTransitions = [
      { event: "workspace.issue_attached", transition: "In Progress" },
    ];
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_q",
      name: "Patch Repo Q",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: `${fixture.config.dataDir}/worktrees`,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_q",
      repoId: "repo_q",
      name: "ws-q",
      path: `${fixture.config.dataDir}/ws-q`,
      branch: "ws-q",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: "AUTH-1",
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "in-progress",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    let transitionCalls = 0;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        transitionJiraIssue: async (input) => {
          transitionCalls += 1;
          return {
            providerId: "jira-jtk",
            status: "healthy",
            reason: null,
            key: input.issueKey,
            transition: input.transition,
            checkedAt: now,
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      // Unattach (value → null) MUST NOT fire.
      const unattachResp = await fetch(`${baseUrl}/api/workspaces/ws_q`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: null, issueTitle: null, issueUrl: null }),
      });
      expect(unattachResp.status).toBe(200);
      expect(transitionCalls).toBe(0);

      // No-op rename MUST NOT fire (issueKey stays null after unattach).
      const renameResp = await fetch(`${baseUrl}/api/workspaces/ws_q`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "ws-q-renamed" }),
      });
      expect(renameResp.status).toBe(200);
      expect(transitionCalls).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/workspaces/:id/issue-transition still works after extraction (regression)", async () => {
    const fixture = createFixture();
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_jt",
      name: "Jira Test Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: `${fixture.config.dataDir}/worktrees`,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_jt",
      repoId: "repo_jt",
      name: "ws-jt",
      path: `${fixture.config.dataDir}/ws-jt`,
      branch: "ws-jt",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: "MS-9",
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "in-progress",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    let observed: { issueKey: string; transition: string } | null = null;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        transitionJiraIssue: async (input) => {
          observed = { issueKey: input.issueKey, transition: input.transition };
          return {
            providerId: "jira-jtk",
            status: "healthy",
            reason: null,
            key: input.issueKey,
            transition: input.transition,
            checkedAt: new Date().toISOString(),
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{ result: { status: string; key: string } }>(
        `${baseUrl}/api/workspaces/ws_jt/issue-transition`,
        { transition: "31" },
      );
      expect(observed).toEqual({ issueKey: "MS-9", transition: "31" });
      expect(result.result.status).toBe("healthy");
      expect(result.result.key).toBe("MS-9");
    } finally {
      await closeServer(server);
    }
  });
});
