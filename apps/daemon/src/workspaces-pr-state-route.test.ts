import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture, createGitFixtureWithRemote, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";
import { checkoutVcCacheKey } from "./provider-cache.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function registerWorkspaces(baseUrl: string, repoId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const resp = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId, name: `ws-${i}`, source: "scratch" }),
    });
    expect([200, 202]).toContain(resp.status);
    const body = (await resp.json()) as { workspaceId: string };
    ids.push(body.workspaceId);
  }
  return ids;
}

describe("GET /api/workspaces/pr-state", () => {
  it("returns an empty map when cache holds no per-workspace entries", async () => {
    const fixture = createFixture(dirs);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{ workspacePrState: Record<string, unknown> }>(`${baseUrl}/api/workspaces/pr-state`);
      expect(body.workspacePrState).toEqual({});
    } finally {
      await closeServer(server);
    }
  });

  it("omits archived workspaces and workspaces with no cached entry", { timeout: 30_000 }, async () => {
    const fixture = createFixture(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const repoResp = await fetch(`${baseUrl}/api/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: repoPath, name: "fixture" }),
      });
      expect(repoResp.ok).toBe(true);
      const repo = (await repoResp.json()) as { repo: { id: string } };
      const [, wsId2] = await registerWorkspaces(baseUrl, repo.repo.id, 2);
      // Without any provider call, the cache is empty — both workspaces are omitted.
      const empty = await getJson<{ workspacePrState: Record<string, unknown> }>(`${baseUrl}/api/workspaces/pr-state`);
      expect(empty.workspacePrState).toEqual({});
      // Archive the second workspace; even if we later populated cache for it,
      // the route's iteration starts from store.listWorkspaces() and skips
      // archived entries.
      const delResp = await fetch(`${baseUrl}/api/workspaces/${wsId2}?archiveOnly=true`, { method: "DELETE" });
      expect([200, 202]).toContain(delResp.status);
      const afterArchive = await getJson<{ workspacePrState: Record<string, unknown> }>(
        `${baseUrl}/api/workspaces/pr-state`,
      );
      expect(afterArchive.workspacePrState[wsId2 ?? ""]).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("serializes cachedAt as ISO-8601 string when an entry is present", { timeout: 30_000 }, async () => {
    // Boot a fresh daemon and pre-seed provider-cache.json so the workspace's
    // vc:* key is hydrated. Then the route serializes cachedAt as ISO.
    const fixture = createFixture(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    // First boot: create repo + workspace.
    const boot1 = await createDaemonApp(fixture);
    const baseUrl1 = await listen(boot1.server);
    let workspaceId = "";
    let workspaceUpdatedAt = "";
    try {
      const repoResp = await fetch(`${baseUrl1}/api/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: repoPath, name: "iso-fixture" }),
      });
      const repo = (await repoResp.json()) as { repo: { id: string } };
      const ids = await registerWorkspaces(baseUrl1, repo.repo.id, 1);
      workspaceId = ids[0] ?? "";
      const stateResp = await getJson<{ workspaces: Array<{ id: string; updatedAt: string }> }>(
        `${baseUrl1}/api/state`,
      );
      const ws = stateResp.workspaces.find((w) => w.id === workspaceId);
      workspaceUpdatedAt = ws?.updatedAt ?? "";
    } finally {
      await closeServer(boot1.server);
    }
    // Seed the cache file directly so the next boot hydrates it.
    const cachedAtMs = Date.now();
    fs.writeFileSync(
      `${fixture.config.dataDir}/provider-cache.json`,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [
          [
            `vc:${workspaceId}:${workspaceUpdatedAt}`,
            {
              expiresAt: Date.now() + 60_000,
              value: {
                providerId: "github-gh",
                status: "healthy",
                reason: null,
                checkedAt: new Date(cachedAtMs).toISOString(),
                defaultBranch: "main",
                currentBranch: "main",
                remotes: [],
                pullRequest: null,
              },
              cachedAt: cachedAtMs,
            },
          ],
        ],
      }),
    );
    const boot2 = await createDaemonApp(fixture);
    const baseUrl2 = await listen(boot2.server);
    try {
      const body = await getJson<{ workspacePrState: Record<string, { cachedAt: string | null }> }>(
        `${baseUrl2}/api/workspaces/pr-state`,
      );
      const entry = body.workspacePrState[workspaceId];
      expect(entry).toBeDefined();
      expect(typeof entry?.cachedAt).toBe("string");
      // ISO-8601 zulu shape.
      expect(entry?.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      await closeServer(boot2.server);
    }
  });

  it("returns full cached checkout PR summaries keyed by checkout id", { timeout: 30_000 }, async () => {
    const fixture = createFixture(dirs);
    const timestamp = "2026-06-04T00:00:00.000Z";
    fixture.store.insertRepo({
      id: "repo_1",
      name: "Repo",
      rootPath: path.join(fixture.config.dataDir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_structured",
      repoId: null,
      name: "Structured",
      path: path.join(fixture.config.dataDir, "structured"),
      rootPath: path.join(fixture.config.dataDir, "structured"),
      mode: "structured",
      branch: "home",
      baseBranch: "main",
      source: "scratch",
      kind: "root",
      lifecyclePhase: "implementation",
      parentIssue: null,
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
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    for (const checkoutId of ["co_api", "co_web"]) {
      fixture.store.insertWorkspaceCheckout({
        id: checkoutId,
        workspaceId: "ws_structured",
        repoId: "repo_1",
        name: checkoutId === "co_api" ? "api" : "web",
        path: path.join(fixture.config.dataDir, "structured", checkoutId),
        branch: `feature/${checkoutId}`,
        baseBranch: "main",
        issue: null,
        intendedPr: null,
        stackParentCheckoutId: null,
        inferredPurpose: "implementation",
        gateStatus: "not_started",
        createdAt: timestamp,
        updatedAt: timestamp,
        archivedAt: null,
      });
    }
    const cachedAtMs = Date.now();
    fs.writeFileSync(
      `${fixture.config.dataDir}/provider-cache.json`,
      JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        entries: [
          [
            checkoutVcCacheKey("ws_structured", "co_api", timestamp),
            {
              expiresAt: Date.now() + 60_000,
              cachedAt: cachedAtMs,
              value: {
                providerId: "github-gh",
                status: "healthy",
                reason: null,
                checkedAt: timestamp,
                defaultBranch: "main",
                currentBranch: "feature/co_api",
                remotes: [],
                pullRequest: {
                  number: 42,
                  title: "Ship API",
                  url: "https://github.example.test/org/repo/pull/42",
                  state: "OPEN",
                  draft: false,
                  reviewDecision: "APPROVED",
                  checks: [],
                  additions: 123,
                  deletions: 45,
                  reviewers: [{ login: "reviewer", name: null, state: "approved" }],
                  commits: [],
                  headRefName: "feature/co_api",
                  parentPr: null,
                  mergeable: "mergeable",
                  allowedMergeStrategies: [],
                  mergeStateStatus: "CLEAN",
                  headSha: "abc123",
                },
              },
            },
          ],
        ],
      }),
    );
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{
        workspacePrState: Record<string, unknown>;
        checkoutPrState: Record<
          string,
          Record<
            string,
            {
              pullRequest: { additions: number | null; deletions: number | null; reviewDecision: string | null } | null;
              cachedAt: string | null;
            }
          >
        >;
      }>(`${baseUrl}/api/workspaces/pr-state`);
      expect(body.workspacePrState).toEqual({});
      expect(body.checkoutPrState.ws_structured?.co_api?.pullRequest).toMatchObject({
        number: 42,
        reviewDecision: "APPROVED",
        additions: 123,
        deletions: 45,
      });
      expect(body.checkoutPrState.ws_structured?.co_api?.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.checkoutPrState.ws_structured?.co_web?.pullRequest).toBeNull();
    } finally {
      await closeServer(server);
    }
  });
});
