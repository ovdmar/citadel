import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, listen, postJson } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-restore-routes-"));
  dirs.push(dir);
  const homeOverride = path.join(dir, "home");
  fs.mkdirSync(homeOverride, { recursive: true });
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  const ts = new Date().toISOString();
  store.insertRepo({
    id: "repo_1",
    name: "fake",
    rootPath: "/tmp/fake-repo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/fake-worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  });
  // Set workspace path to point at the temp HOME so claudeProjectsDir
  // resolves under our fixture instead of the host's ~/.claude.
  const workspacePath = path.join(homeOverride, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  store.insertWorkspace({
    id: "ws_1",
    repoId: "repo_1",
    name: "fake-ws",
    path: workspacePath,
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  });
  return { config, configPath, store, workspacePath, homeOverride };
}

// Write a Claude transcript JSONL under the host's actual ~/.claude/projects
// for `workspacePath`. (claudeProjectsDir resolves from os.homedir() unless
// overridden; we let absorb-empty-pane use the real path and just write into
// it for this test, cleaning up afterward.)
function writeTranscript(workspacePath: string, uuid: string, lines: string[]) {
  const dasherized = workspacePath.replace(/[^A-Za-z0-9]/g, "-");
  const dir = path.join(os.homedir(), ".claude", "projects", dasherized);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${uuid}.jsonl`);
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function fakeOps(fixture: { store: SqliteStore }): OperationService {
  // Minimal OperationService stub. createAgentSession inserts a row into the
  // store (so the absorb logic, which reads store.listSessions, sees both the
  // new and the candidate-empty session). stopAgentSession deletes the row.
  return {
    createAgentSession: async (input: { workspaceId: string; resumeRuntimeSessionId?: string | null }) => {
      const id = `sess_restored_${Date.now().toString(36)}`;
      const ts = new Date().toISOString();
      fixture.store.insertSession({
        id,
        workspaceId: input.workspaceId,
        runtimeId: "claude-code",
        displayName: "Claude Code",
        status: "running",
        statusReason: "launched",
        lastStatusAt: ts,
        lastOutputAt: ts,
        endedAt: null,
        exitCode: null,
        transport: "connected",
        tmuxSessionName: `citadel_${input.workspaceId}_${id.slice(-8)}`,
        tmuxSessionId: "$99",
        runtimeSessionId: input.resumeRuntimeSessionId ?? null,
        createdAt: ts,
        updatedAt: ts,
      });
      return fixture.store.listSessions(input.workspaceId).find((s) => s.id === id);
    },
    stopAgentSession: (input: { sessionId: string }) => {
      fixture.store.deleteSession(input.sessionId);
      return { stopped: true, removed: true, reason: "ok" as const };
    },
  } as unknown as OperationService;
}

describe("restore routes — absorb empty Claude pane", () => {
  it("stops a sibling claude pane whose transcript has zero user prompts", async () => {
    const fixture = makeFixture();
    const ts = new Date().toISOString();
    // The candidate to be restored.
    fixture.store.insertSession({
      id: "sess_dead",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "stopped",
      statusReason: "exit_code_0",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: ts,
      exitCode: 0,
      transport: "disconnected",
      tmuxSessionName: "citadel_ws_1_dead",
      tmuxSessionId: null,
      runtimeSessionId: "uuid-restore",
      createdAt: ts,
      updatedAt: ts,
    });
    // The empty sibling pane the user already opened — runs claude-code, has
    // a UUID, but no user prompts in its transcript.
    fixture.store.insertSession({
      id: "sess_empty",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code (empty)",
      status: "idle",
      statusReason: "pane:active:idle",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: null,
      exitCode: null,
      transport: "connected",
      tmuxSessionName: "citadel_ws_1_empty",
      tmuxSessionId: "$1",
      runtimeSessionId: "uuid-empty",
      createdAt: ts,
      updatedAt: ts,
    });
    // Empty transcript: only system-style entries, no user prompts.
    const transcriptFile = writeTranscript(fixture.workspacePath, "uuid-empty", [
      `{"type":"permission-mode","permissionMode":"auto","sessionId":"uuid-empty"}`,
    ]);

    const { server } = await createDaemonApp({ ...fixture, operations: fakeOps(fixture) });
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{ absorbed: string[]; restoredFrom: string }>(`${baseUrl}/api/restore/run`, {
        workspaceId: "ws_1",
        runtimeSessionId: "uuid-restore",
      });
      expect(result.restoredFrom).toBe("sess_dead");
      expect(result.absorbed).toEqual(["sess_empty"]);
      // sess_empty deleted; sess_dead still around (the restored session is new).
      const remaining = fixture.store.listSessions("ws_1").map((s) => s.id);
      expect(remaining).not.toContain("sess_empty");
    } finally {
      await closeServer(server);
      fs.rmSync(transcriptFile, { force: true });
    }
  });

  it("does NOT absorb a sibling whose transcript shows a real user prompt", async () => {
    const fixture = makeFixture();
    const ts = new Date().toISOString();
    fixture.store.insertSession({
      id: "sess_dead",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "stopped",
      statusReason: "exit_code_0",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: ts,
      exitCode: 0,
      transport: "disconnected",
      tmuxSessionName: "citadel_ws_1_dead",
      tmuxSessionId: null,
      runtimeSessionId: "uuid-restore",
      createdAt: ts,
      updatedAt: ts,
    });
    fixture.store.insertSession({
      id: "sess_real",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code (active)",
      status: "idle",
      statusReason: "pane:active:idle",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: null,
      exitCode: null,
      transport: "connected",
      tmuxSessionName: "citadel_ws_1_real",
      tmuxSessionId: "$1",
      runtimeSessionId: "uuid-real",
      createdAt: ts,
      updatedAt: ts,
    });
    // Transcript with one real user-authored prompt.
    const transcriptFile = writeTranscript(fixture.workspacePath, "uuid-real", [
      `{"type":"permission-mode","permissionMode":"auto","sessionId":"uuid-real"}`,
      `{"parentUuid":null,"isSidechain":false,"promptId":"p1","type":"user","message":{"role":"user","content":"hello"},"uuid":"u1","timestamp":"${ts}"}`,
    ]);

    const { server } = await createDaemonApp({ ...fixture, operations: fakeOps(fixture) });
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{ absorbed: string[] }>(`${baseUrl}/api/restore/run`, {
        workspaceId: "ws_1",
        runtimeSessionId: "uuid-restore",
      });
      expect(result.absorbed).toEqual([]);
      const remaining = fixture.store.listSessions("ws_1").map((s) => s.id);
      expect(remaining).toContain("sess_real");
    } finally {
      await closeServer(server);
      fs.rmSync(transcriptFile, { force: true });
    }
  });
});
