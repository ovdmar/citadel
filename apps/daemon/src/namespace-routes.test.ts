import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

type Namespace = { id: string; name: string; archivedAt: string | null; color: string | null };
type Workspace = { id: string; name: string; namespaceId: string | null };
const SLOW_DAEMON_TEST_TIMEOUT = 30_000;

describe("namespace routes + MCP integration", { timeout: SLOW_DAEMON_TEST_TIMEOUT }, () => {
  it("creates a namespace, creates a workspace in it, lists, and reassigns through the MCP tool surface", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_ns",
      name: "NS Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });

    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      // 1. Empty list to start.
      const initial = await getJson<{ namespaces: Namespace[] }>(`${baseUrl}/api/namespaces`);
      expect(initial.namespaces).toEqual([]);

      // 2. Create namespace via MCP RPC (so a main agent could do the same).
      const createRpc = await postJson<{
        result: { structuredContent: { namespace: Namespace; created: boolean } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_namespace", arguments: { name: "MS-100 epic" } },
      });
      const namespace = createRpc.result.structuredContent.namespace;
      expect(namespace.name).toBe("MS-100 epic");
      expect(createRpc.result.structuredContent.created).toBe(true);

      // 2b. Idempotent re-create returns created=false and the same id.
      const idempotent = await postJson<{
        result: { structuredContent: { namespace: Namespace; created: boolean } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "create_namespace", arguments: { name: "MS-100 epic" } },
      });
      expect(idempotent.result.structuredContent.created).toBe(false);
      expect(idempotent.result.structuredContent.namespace.id).toBe(namespace.id);

      // 3. list_namespaces via MCP returns the new one.
      const listRpc = await postJson<{
        result: { structuredContent: { namespaces: Namespace[] } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_namespaces" },
      });
      expect(listRpc.result.structuredContent.namespaces.map((entry) => entry.id)).toContain(namespace.id);

      // 4. create_workspace via MCP, tagged with the namespaceId.
      const createWs = await postJson<{
        result: { structuredContent: { workspaceId: string } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "create_workspace",
          arguments: { repoId: "repo_ns", name: "task-a", namespaceId: namespace.id },
        },
      });
      const workspaceId = createWs.result.structuredContent.workspaceId;
      expect(workspaceId).toBeTruthy();

      // 5. list_workspaces should annotate with namespaceName.
      const listWs = await postJson<{
        result: { structuredContent: { workspaces: Array<Workspace & { namespaceName: string | null }> } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: { namespaceId: namespace.id } },
      });
      const inNamespace = listWs.result.structuredContent.workspaces.find((ws) => ws.id === workspaceId);
      expect(inNamespace).toBeDefined();
      expect(inNamespace?.namespaceId).toBe(namespace.id);
      expect(inNamespace?.namespaceName).toBe("MS-100 epic");

      // 6. Reassign to null (Uncategorized) via assign_workspace_to_namespace.
      const reassign = await postJson<{
        result: { structuredContent: { assigned: boolean; namespaceId: string | null } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "assign_workspace_to_namespace",
          arguments: { workspaceId, namespaceId: null },
        },
      });
      expect(reassign.result.structuredContent.assigned).toBe(true);
      expect(reassign.result.structuredContent.namespaceId).toBeNull();

      // 7. REST mirror also reports the workspace as unassigned.
      const restState = await getJson<{ workspaces: Workspace[] }>(`${baseUrl}/api/workspaces`);
      expect(restState.workspaces.find((ws) => ws.id === workspaceId)?.namespaceId).toBeNull();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects archiving an unknown namespace, supports restore + MCP includeArchived", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_ns2",
      name: "NS2",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const missing = await fetch(`${baseUrl}/api/namespaces/ns_missing`, { method: "DELETE" });
      expect(missing.status).toBe(404);

      const created = await postJson<{ namespace: Namespace; created: boolean }>(`${baseUrl}/api/namespaces`, {
        name: "ephemeral",
      });
      expect(created.created).toBe(true);

      // Empty PATCH body is rejected as 400.
      const emptyPatch = await fetch(`${baseUrl}/api/namespaces/${created.namespace.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(emptyPatch.status).toBe(400);

      const archive = await fetch(`${baseUrl}/api/namespaces/${created.namespace.id}`, { method: "DELETE" });
      expect(archive.status).toBe(202);

      // Default REST list hides it, includeArchived shows it.
      const archived = await getJson<{ namespaces: Namespace[] }>(`${baseUrl}/api/namespaces?includeArchived=true`);
      expect(archived.namespaces.find((entry) => entry.id === created.namespace.id)?.archivedAt).not.toBeNull();

      // MCP tool also honors includeArchived now.
      const mcpArchived = await postJson<{
        result: { structuredContent: { namespaces: Namespace[] } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: { name: "list_namespaces", arguments: { includeArchived: true } },
      });
      expect(
        mcpArchived.result.structuredContent.namespaces.find((entry) => entry.id === created.namespace.id)?.archivedAt,
      ).not.toBeNull();
      const mcpDefault = await postJson<{
        result: { structuredContent: { namespaces: Namespace[] } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "list_namespaces" },
      });
      expect(
        mcpDefault.result.structuredContent.namespaces.find((entry) => entry.id === created.namespace.id),
      ).toBeUndefined();

      // Trying to assign a workspace to the archived namespace returns 409.
      const workspaceCreate = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces`, {
        repoId: "repo_ns2",
        name: "task-d",
        source: "scratch",
      });
      const conflict = await fetch(`${baseUrl}/api/namespaces/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: workspaceCreate.workspaceId, namespaceId: created.namespace.id }),
      });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ reason: "namespace_archived" });

      // Restore via REST endpoint.
      const restore = await postJson<{ namespace: Namespace }>(
        `${baseUrl}/api/namespaces/${created.namespace.id}/restore`,
        {},
      );
      expect(restore.namespace.archivedAt).toBeNull();

      // Re-creating with the same name reactivates instead of UNIQUE-throwing.
      await fetch(`${baseUrl}/api/namespaces/${created.namespace.id}`, { method: "DELETE" });
      const recreate = await postJson<{ namespace: Namespace; created: boolean }>(`${baseUrl}/api/namespaces`, {
        name: "ephemeral",
        color: "#445566",
      });
      expect(recreate.created).toBe(true);
      expect(recreate.namespace.id).toBe(created.namespace.id);
      expect(recreate.namespace.archivedAt).toBeNull();
      expect(recreate.namespace.color).toBe("#445566");

      // assign_workspace_to_namespace via MCP without namespaceId is rejected
      // by the daemon (Zod parse), surfacing a JSON-RPC error to the caller.
      const missingArgResponse = await fetch(`${baseUrl}/api/mcp/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 40,
          method: "tools/call",
          params: { name: "assign_workspace_to_namespace", arguments: { workspaceId: workspaceCreate.workspaceId } },
        }),
      });
      expect(missingArgResponse.status).toBe(200);
      const missingArgBody = (await missingArgResponse.json()) as {
        error?: { message?: string };
      };
      expect(missingArgBody.error?.message).toContain("namespaceId");
    } finally {
      await closeServer(server);
    }
  });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-ns-routes-"));
  dirs.push(dir);
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      databasePath: path.join(dir, "citadel.sqlite"),
      dataDir: dir,
      mcp: { enabled: true },
    }),
  );
  const config = loadConfig(configPath);
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.dataDir = dir;
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store };
}

function createGitRepo(dir: string) {
  const repoPath = path.join(dir, `repo-${Date.now().toString(36)}`);
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  return { repoPath };
}

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}
