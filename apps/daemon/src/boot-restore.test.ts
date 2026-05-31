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
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

function insertLiveSession(
  store: SqliteStore,
  args: { id: string; uuid: string; ageMs: number; runtimeId?: string; tabId?: string },
) {
  const ts = new Date(Date.now() - args.ageMs).toISOString();
  store.insertSession({
    id: args.id,
    workspaceId: "ws_1",
    runtimeId: args.runtimeId ?? "claude-code",
    displayName: "Claude Code",
    status: "running",
    statusReason: "launched",
    lastStatusAt: ts,
    lastOutputAt: ts,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    tmuxSessionName: `citadel_ws_1_${args.id.slice(-8)}`,
    tmuxSessionId: "$1",
    runtimeSessionId: args.uuid,
    tabId: args.tabId,
    createdAt: ts,
    updatedAt: ts,
  });
}

function fakeOps(
  spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }>,
  stopped: string[] = [],
  store?: SqliteStore,
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
    stopAgentSession: (input: { sessionId: string }) => {
      stopped.push(input.sessionId);
      if (store) store.deleteSession(input.sessionId);
      return { stopped: true, removed: true, reason: "ok" as const };
    },
  } as unknown as OperationService;
}

describe("runBootRestore", () => {
  it("resumes every recent fresh-boot candidate sequentially, skips ones older than 24h", async () => {
    const { config, store } = fixture();
    insertLiveSession(store, { id: "sess_recent_1", uuid: "uuid-aaaa", ageMs: 5 * 60_000 });
    insertLiveSession(store, { id: "sess_recent_2", uuid: "uuid-bbbb", ageMs: 60 * 60_000 });
    insertLiveSession(store, { id: "sess_old", uuid: "uuid-cccc", ageMs: 48 * 60 * 60_000 });

    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Server reachable but empty: models a machine reboot / tmux loss.
      listTmuxSessions: () => new Set<string>(),
      tmuxReadinessTimeoutMs: 0,
    });

    expect(summary.entries).toHaveLength(2);
    expect(summary.skippedOlder).toBe(1);
    expect(summary.finishedAt).not.toBeNull();
    expect(spawned.map((s) => s.resumeRuntimeSessionId).sort()).toEqual(["uuid-aaaa", "uuid-bbbb"]);
    expect(summary.entries.every((e) => e.sessionId !== null && e.error === null)).toBe(true);
  });

  it("leaves pre-existing restore candidates for manual restore on routine daemon restart", async () => {
    const { config, store } = fixture();
    insertStoppedSession(store, { id: "sess_existing", uuid: "uuid-existing", ageMs: 5 * 60_000 });

    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      listTmuxSessions: () => new Set<string>(),
      tmuxReadinessTimeoutMs: 0,
    });

    expect(summary.entries).toHaveLength(0);
    expect(summary.skippedOlder).toBe(0);
    expect(summary.finishedAt).not.toBeNull();
    expect(spawned).toHaveLength(0);
    expect(store.listSessions("ws_1").map((s) => s.id)).toContain("sess_existing");
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
    config.agentRuntimes = [];
    insertLiveSession(store, { id: "sess_a", uuid: "uuid-aaaa", ageMs: 5 * 60_000 });
    insertLiveSession(store, { id: "sess_b", uuid: "uuid-bbbb", ageMs: 5 * 60_000 });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      listTmuxSessions: () => new Set<string>(),
      tmuxReadinessTimeoutMs: 0,
    });
    expect(summary.entries).toHaveLength(2);
    expect(summary.entries.every((e) => e.sessionId === null && e.error?.startsWith("runtime_not_found:"))).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it("stops the source row after a successful restore so it doesn't surface as a duplicate tab", async () => {
    const { config, store } = fixture();
    insertLiveSession(store, { id: "sess_to_restore", uuid: "uuid-cleanup", ageMs: 5 * 60_000 });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const stopped: string[] = [];
    await runBootRestore({
      store,
      operations: fakeOps(spawned, stopped, store),
      config,
      emit: () => {},
      listTmuxSessions: () => new Set<string>(),
      tmuxReadinessTimeoutMs: 0,
    });
    expect(spawned).toHaveLength(1);
    expect(stopped).toEqual(["sess_to_restore"]);
    // DB no longer holds the source row — only the fakeOps-created "live"
    // one would remain in a real flow, but fakeOps doesn't insert one, so
    // the workspace ends up empty. Either way, no duplicate row.
    const remaining = store.listSessions("ws_1").map((s) => s.id);
    expect(remaining).not.toContain("sess_to_restore");
  });

  it("propagates the source row's tabId so the restored session reuses its tab slot", async () => {
    const { config, store } = fixture();
    // Insert a live row WITH an explicit tab_id. Boot-restore should pass
    // that tabId into createAgentSession so the cockpit places the restored
    // session in the same tab the original lived in.
    insertLiveSession(store, {
      id: "sess_recent_tab",
      uuid: "uuid-tabprop",
      ageMs: 5 * 60_000,
      tabId: "tab_explicit_42",
    });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      listTmuxSessions: () => new Set<string>(),
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

  it("does not flip a live row whose name is missing from list-sessions when has-session confirms it's alive", async () => {
    // Models the partial-read failure mode: list-sessions returns a Set
    // that's missing one of our tmux names (we've observed this in the
    // journal under load — `tmuxActivities failed: Command failed: tmux
    // list-sessions ...`), but `has-session -t <name>` confirms the pane
    // is still there. Pre-fix, boot-restore flipped the row to "unknown"
    // and the cockpit popped a Restore banner for a session whose tmux +
    // terminal viewer path was perfectly fine. With the double-check, the row stays in
    // its live status and no restore work happens.
    const { config, store } = fixture();
    const ts = new Date().toISOString();
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
      transport: "disconnected",
      tmuxSessionName: "citadel_ws_alive",
      tmuxSessionId: "$1",
      runtimeSessionId: "uuid-alive",
      createdAt: ts,
      updatedAt: ts,
    });
    const spawned: Array<{ workspaceId: string; resumeRuntimeSessionId: string | null; tabId: string | null }> = [];
    const summary = await runBootRestore({
      store,
      operations: fakeOps(spawned),
      config,
      emit: () => {},
      // Empty Set: list-sessions returned no entries (partial read).
      listTmuxSessions: () => new Set<string>(),
      // …but has-session says citadel_ws_alive is up. Don't flip.
      hasTmuxSession: (name) => name === "citadel_ws_alive",
      tmuxReadinessTimeoutMs: 0,
    });
    expect(summary.entries).toHaveLength(0);
    expect(spawned).toHaveLength(0);
    const row = store.listSessions("ws_1").find((s) => s.id === "sess_alive");
    expect(row?.status).toBe("running");
  });
});
