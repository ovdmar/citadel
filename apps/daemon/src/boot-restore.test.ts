import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetBootRestoreSummaryForTests, runBootRestore } from "./boot-restore.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetBootRestoreSummaryForTests();
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-boot-restore-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  // Repo + workspace scaffolding so collectRestoreCandidates has something
  // to walk. Tests insert sessions onto this workspace directly.
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_1",
    repoId: "repo_1",
    name: "fake-ws",
    path: "/tmp/fake-workspace",
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archivedAt: null,
  });
  return { config, store };
}

function insertStoppedSession(
  store: SqliteStore,
  args: { id: string; uuid: string; ageMs: number; runtimeId?: string },
) {
  const ts = new Date(Date.now() - args.ageMs).toISOString();
  store.insertSession({
    id: args.id,
    workspaceId: "ws_1",
    runtimeId: args.runtimeId ?? "claude-code",
    displayName: "Claude Code",
    status: "stopped",
    statusReason: "exit_code_0",
    lastStatusAt: ts,
    lastOutputAt: ts,
    endedAt: ts,
    exitCode: 0,
    transport: "disconnected",
    tmuxSessionName: `citadel_ws_1_${args.id.slice(-8)}`,
    tmuxSessionId: null,
    runtimeSessionId: args.uuid,
    createdAt: ts,
    updatedAt: ts,
  });
}

function fakeOps(
  spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }>,
) {
  return {
    createAgentSession: async (input: {
      workspaceId: string;
      resumeRuntimeSessionId?: string | null;
      tabId?: string | null;
    }) => {
      spawned.push({
        workspaceId: input.workspaceId,
        resumeRuntimeSessionId: input.resumeRuntimeSessionId ?? null,
        tabId: input.tabId ?? null,
      });
      return {
        id: `sess_new_${spawned.length}`,
        workspaceId: input.workspaceId,
        runtimeId: "claude-code",
      };
    },
  } as unknown as OperationService;
}

describe("runBootRestore", () => {
  it("resumes every recent candidate sequentially, skips ones older than 24h", async () => {
    const { config, store } = fixture();
    insertStoppedSession(store, { id: "sess_recent_1", uuid: "uuid-aaaa", ageMs: 5 * 60_000 });
    insertStoppedSession(store, { id: "sess_recent_2", uuid: "uuid-bbbb", ageMs: 60 * 60_000 });
    insertStoppedSession(store, { id: "sess_old", uuid: "uuid-cccc", ageMs: 48 * 60 * 60_000 });

    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Suppress fresh-boot reconciliation: tests fabricate DB rows whose
      // tmuxSessionName intentionally does not exist on the host tmux.
      listTmuxSessions: () => null,
      tmuxReadinessTimeoutMs: 0,
    });

    expect(summary.entries).toHaveLength(2);
    expect(summary.skippedOlder).toBe(1);
    expect(summary.finishedAt).not.toBeNull();
    expect(spawned.map((s) => s.resumeRuntimeSessionId).sort()).toEqual(["uuid-aaaa", "uuid-bbbb"]);
    expect(summary.entries.every((e) => e.sessionId !== null && e.error === null)).toBe(true);
  });

  it("returns an empty summary when there are no candidates at all", async () => {
    const { config, store } = fixture();
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Suppress fresh-boot reconciliation: tests fabricate DB rows whose
      // tmuxSessionName intentionally does not exist on the host tmux.
      listTmuxSessions: () => null,
      tmuxReadinessTimeoutMs: 0,
    });
    expect(summary.entries).toHaveLength(0);
    expect(summary.skippedOlder).toBe(0);
    expect(summary.finishedAt).not.toBeNull();
    expect(spawned).toHaveLength(0);
  });

  it("records errors on entries when the runtime is missing without aborting the rest of the batch", async () => {
    const { config, store } = fixture();
    // Wipe runtimes so the lookup fails for our claude-code candidate;
    // the loop should mark it failed and continue.
    config.runtimes = [];
    insertStoppedSession(store, { id: "sess_a", uuid: "uuid-aaaa", ageMs: 5 * 60_000 });
    insertStoppedSession(store, { id: "sess_b", uuid: "uuid-bbbb", ageMs: 5 * 60_000 });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Suppress fresh-boot reconciliation: tests fabricate DB rows whose
      // tmuxSessionName intentionally does not exist on the host tmux.
      listTmuxSessions: () => null,
      tmuxReadinessTimeoutMs: 0,
    });
    expect(summary.entries).toHaveLength(2);
    expect(summary.entries.every((e) => e.sessionId === null && e.error?.startsWith("runtime_not_found:"))).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it("propagates the source row's tabId so the restored session reuses its tab slot", async () => {
    const { config, store } = fixture();
    // Insert a stopped row WITH an explicit tab_id. Boot-restore should pass
    // that tabId into createAgentSession so the cockpit places the restored
    // session in the same tab the original lived in.
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    store.insertSession({
      id: "sess_recent_tab",
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
      tmuxSessionName: "citadel_ws_1_tab",
      tmuxSessionId: null,
      tabId: "tab_explicit_42",
      runtimeSessionId: "uuid-tabprop",
      createdAt: ts,
      updatedAt: ts,
    });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      listTmuxSessions: () => null,
      tmuxReadinessTimeoutMs: 0,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.tabId).toBe("tab_explicit_42");
  });

  it("retries the tmux probe when it initially returns null (systemd race)", async () => {
    const { config, store } = fixture();
    // Insert a live row whose tmux session is missing — the post-readiness
    // reconcile should flip it. If we treated the first null as definitive
    // (the pre-fix behavior), this row stays in `running` and boot-restore
    // would skip it as live.
    const ts = new Date().toISOString();
    store.insertSession({
      id: "sess_race",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "running",
      statusReason: "launched",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: null,
      exitCode: null,
      transport: "disconnected",
      tmuxSessionName: "citadel_ws_1_race",
      tmuxSessionId: "$1",
      runtimeSessionId: "uuid-race",
      createdAt: ts,
      updatedAt: ts,
    });
    let calls = 0;
    const probe = () => {
      calls += 1;
      // First two calls model "tmux socket not yet ready"; third call returns
      // an empty Set ("server up, no sessions") — race resolved.
      return calls >= 3 ? new Set<string>() : null;
    };
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      listTmuxSessions: probe,
      // Keep the test fast — the production default is 5s with 250ms polls.
      tmuxReadinessTimeoutMs: 500,
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(summary.entries).toHaveLength(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.resumeRuntimeSessionId).toBe("uuid-race");
  });

  it("skips a candidate whose UUID is already live (e.g. manual restore raced us)", async () => {
    const { config, store } = fixture();
    const ts = new Date().toISOString();
    // Stopped row with the UUID — this is the "candidate".
    insertStoppedSession(store, { id: "sess_dead", uuid: "uuid-live", ageMs: 5 * 60_000 });
    // Live row already holds that same UUID.
    store.insertSession({
      id: "sess_alive",
      workspaceId: "ws_1",
      runtimeId: "claude-code",
      displayName: "Claude Code",
      status: "running",
      statusReason: "launched",
      lastStatusAt: ts,
      lastOutputAt: ts,
      endedAt: null,
      exitCode: null,
      transport: "connected",
      tmuxSessionName: "citadel_ws_1_alive",
      tmuxSessionId: "$1",
      runtimeSessionId: "uuid-live",
      createdAt: ts,
      updatedAt: ts,
    });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Suppress fresh-boot reconciliation: tests fabricate DB rows whose
      // tmuxSessionName intentionally does not exist on the host tmux.
      listTmuxSessions: () => null,
      tmuxReadinessTimeoutMs: 0,
    });
    // collectRestoreCandidates already drops UUIDs that have a live owner,
    // so the candidate doesn't even reach the loop. Either way: no spawn.
    expect(summary.entries).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });
});
