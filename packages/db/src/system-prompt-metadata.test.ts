import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeStore(): SqliteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-system-prompts-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  store.insertRepo({
    id: "repo_test",
    name: "Repo",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_test",
    repoId: "repo_test",
    name: "Workspace",
    path: path.join(dir, "worktrees", "workspace"),
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
    dirty: false,
    namespaceId: null,
    createdAt: "2026-05-17T00:01:00.000Z",
    updatedAt: "2026-05-17T00:01:00.000Z",
    archivedAt: null,
  });
  return store;
}

describe("system prompt metadata persistence", () => {
  it("round-trips public metadata and keeps the snapshot internal", () => {
    const store = makeStore();
    store.insertSession({
      id: "sess_test",
      kind: "agent",
      workspaceId: "ws_test",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "running",
      statusReason: null,
      lastStatusAt: "2026-05-17T00:02:00.000Z",
      lastOutputAt: null,
      endedAt: null,
      exitCode: null,
      transport: "connected",
      tmuxSessionName: "citadel_test",
      tmuxSessionId: "$1",
      systemPromptSnapshot: "Base prompt\n\nRole prompt",
      systemPromptSources: ["settings_base", "role_template"],
      systemPromptDelivery: { mode: "native_argv", runtimeId: "claude-code" },
      systemPromptLastDelivery: { mode: "native_argv", runtimeId: "claude-code" },
      createdAt: "2026-05-17T00:02:00.000Z",
      updatedAt: "2026-05-17T00:02:00.000Z",
    });

    expect(store.listSessions("ws_test")).toMatchObject([
      {
        id: "sess_test",
        systemPromptSources: ["settings_base", "role_template"],
        systemPromptDelivery: { mode: "native_argv", runtimeId: "claude-code" },
        systemPromptLastDelivery: { mode: "native_argv", runtimeId: "claude-code" },
      },
    ]);
    expect(store.getWorkspaceSessionSystemPromptSnapshot("sess_test")).toBe("Base prompt\n\nRole prompt");
  });
});
