import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("review-comments can be created, resolved, and deleted via the API surface", async ({ request }, testInfo) => {
  // Backend-only flow: keeps the test independent of inspector tab DOM that may
  // change. The same daemon endpoints the cockpit uses are exercised here.
  const fixture = createGitFixture();
  const workspaceIds: string[] = [];
  try {
    const repo = await registerRepo(request, fixture, `e2e-review-${testInfo.project.name}`);
    const ws = await createWorkspace(request, repo.id, `e2e-review-${Date.now().toString(36)}`);
    workspaceIds.push(ws.workspaceId);
    await waitForWorkspace(request, ws.workspaceId, "ready");

    const empty = await request.get(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-comments`);
    expect(empty.ok()).toBe(true);
    expect((await empty.json()).comments).toEqual([]);

    const add = await request.post(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-comments`, {
      data: { body: "first e2e comment" },
    });
    expect(add.status()).toBe(201);
    const created = (await add.json()) as { comment: { id: string; updatedAt: string; status: string } };
    expect(created.comment.status).toBe("open");

    const list = await request.get(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-comments`);
    expect((await list.json()).comments).toHaveLength(1);

    // Stale token → 409
    const stale = await request.patch(`${API_BASE}/api/review-comments/${created.comment.id}`, {
      data: { status: "resolved", ifUpdatedAtMatches: "1970-01-01T00:00:00.000Z" },
    });
    expect(stale.status()).toBe(409);

    // Fresh token → 200, marks resolved
    const resolve = await request.patch(`${API_BASE}/api/review-comments/${created.comment.id}`, {
      data: { status: "resolved", ifUpdatedAtMatches: created.comment.updatedAt },
    });
    expect(resolve.status()).toBe(200);
    const resolved = (await resolve.json()) as { comment: { status: string; updatedAt: string } };
    expect(resolved.comment.status).toBe("resolved");

    // Delete with fresh token
    const del = await request.delete(`${API_BASE}/api/review-comments/${created.comment.id}`, {
      data: { ifUpdatedAtMatches: resolved.comment.updatedAt },
    });
    expect(del.status()).toBe(204);

    const after = await request.get(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-comments`);
    expect((await after.json()).comments).toHaveLength(0);

    const withDeleted = await request.get(
      `${API_BASE}/api/workspaces/${ws.workspaceId}/review-comments?includeDeleted=true`,
    );
    expect((await withDeleted.json()).comments).toHaveLength(1);
  } finally {
    for (const workspaceId of workspaceIds) {
      await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    }
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("request_review returns no-hook when no hook is configured", async ({ request }, testInfo) => {
  const fixture = createGitFixture();
  const workspaceIds: string[] = [];
  try {
    const repo = await registerRepo(request, fixture, `e2e-nohook-${testInfo.project.name}`);
    const ws = await createWorkspace(request, repo.id, `e2e-nohook-${Date.now().toString(36)}`);
    workspaceIds.push(ws.workspaceId);
    await waitForWorkspace(request, ws.workspaceId, "ready");

    const resp = await request.post(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-requests`, {
      data: {},
    });
    expect(resp.status()).toBe(400);
    expect((await resp.json()).error).toBe("no-hook");

    const latest = await request.get(`${API_BASE}/api/workspaces/${ws.workspaceId}/review-suggestions`);
    expect(latest.ok()).toBe(true);
    expect((await latest.json()).run).toBeNull();
  } finally {
    for (const workspaceId of workspaceIds) {
      await request.delete(`${API_BASE}/api/workspaces/${workspaceId}?archiveOnly=true`);
    }
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

async function registerRepo(request: APIRequestContext, fixture: ReturnType<typeof createGitFixture>, name: string) {
  const repoResponse = await request.post(`${API_BASE}/api/repos`, {
    data: { rootPath: fixture.repoPath, name, worktreeParent: path.join(fixture.dir, "worktrees") },
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

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-e2e-review-"));
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel E2E"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# e2e review\n");
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
