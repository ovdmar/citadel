import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture, createGitFixtureWithRemote, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

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
});
