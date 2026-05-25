import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock @citadel/terminal so reconcileStore's tmux-side calls are observable
// without spawning real tmux processes. Vitest hoists the factory; refs live
// on module-scoped state to keep tests independent.
const tmuxState = {
  sessionExists: new Map<string, boolean>(),
  paneDead: new Map<string, boolean>(),
  agentLive: new Map<string, boolean>(),
  killed: [] as string[],
  pipeStops: [] as string[],
};

vi.mock("@citadel/terminal", () => ({
  tmuxSessionExists: vi.fn((name: string) => tmuxState.sessionExists.get(name) ?? false),
  tmuxPaneDead: vi.fn((name: string) => tmuxState.paneDead.get(name) ?? true),
  isAgentLive: vi.fn((name: string) => tmuxState.agentLive.get(name) ?? true),
  killTmuxSession: vi.fn((name: string) => {
    tmuxState.killed.push(name);
  }),
  stopBackgroundSessionPipe: vi.fn((name: string) => {
    tmuxState.pipeStops.push(name);
  }),
}));

const dirs: string[] = [];

beforeEach(() => {
  tmuxState.sessionExists.clear();
  tmuxState.paneDead.clear();
  tmuxState.agentLive.clear();
  tmuxState.killed.splice(0);
  tmuxState.pipeStops.splice(0);
});

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("reconcileStore — background sessions", () => {
  it("closes the in-flight run and marks the bg session stopped when the pane is dead AND session is gone", async () => {
    const { reconcileStore } = await import("./helpers.js");
    const { store, repoId, agentId, logPath } = createFixture();
    seedBackground(store, agentId, "bg_a", "citadel_bg_a", logPath);
    fs.writeFileSync(logPath, "ran-output"); // non-empty → succeeded inference
    // Session gone (default state of tmuxSessionExists is false).
    const out = reconcileStore(store, () => {});
    expect(out.backgroundSessions).toBe(1);
    expect(store.findBackgroundSession("bg_a")?.status).toBe("stopped");
    const run = store.findInFlightScheduledAgentRun(agentId);
    expect(run).toBeNull(); // in-flight closed
    expect(tmuxState.killed).toEqual([]); // no need to kill, already gone
    // Outcome inferred from log size > 0.
    void repoId;
  });

  it("infers 'failed/session_ended_no_output' when log file is empty and stops the pipe + kills the surviving pane", async () => {
    const { reconcileStore } = await import("./helpers.js");
    const { store, agentId, logPath } = createFixture();
    seedBackground(store, agentId, "bg_b", "citadel_bg_b", logPath);
    fs.writeFileSync(logPath, ""); // empty
    // Pane survives (remain-on-exit) — sessionExists true, pane dead true.
    tmuxState.sessionExists.set("citadel_bg_b", true);
    tmuxState.paneDead.set("citadel_bg_b", true);
    reconcileStore(store, () => {});
    expect(tmuxState.pipeStops).toEqual(["citadel_bg_b"]);
    expect(tmuxState.killed).toEqual(["citadel_bg_b"]);
    expect(store.findBackgroundSession("bg_b")?.status).toBe("stopped");
    const recent = store.listScheduledAgentRuns(agentId, { limit: 1 })[0];
    expect(recent?.status).toBe("failed");
    expect(recent?.message).toBe("session_ended_no_output");
  });

  it("does NOT close in-flight rows that point at a different background session id", async () => {
    const { reconcileStore } = await import("./helpers.js");
    const { store, agentId, logPath } = createFixture();
    // Seed bg_dead AND a current in-flight run row that points at bg_current.
    seedBackground(store, agentId, "bg_dead", "citadel_bg_dead", logPath);
    // Overwrite the in-flight run row's backgroundSessionId so it no longer
    // matches the dead background session (e.g. a re-fire replaced the run).
    store.recordScheduledAgentRunOutcome("inflight_run", {
      status: "running",
      endedAt: new Date().toISOString(),
      message: null,
      backgroundSessionId: "bg_current_other",
    });
    // recordScheduledAgentRunOutcome sets status to whatever passed; reset to running:
    const conn = store as unknown as { exec: (sql: string) => void };
    conn.exec("UPDATE scheduled_agent_runs SET status = 'running', ended_at = NULL WHERE id = 'inflight_run'");

    reconcileStore(store, () => {});
    // bg_dead row flipped to stopped but the in-flight run row was NOT touched
    // because backgroundSessionId points at bg_current_other.
    expect(store.findBackgroundSession("bg_dead")?.status).toBe("stopped");
    expect(store.findScheduledAgentRun("inflight_run")?.status).toBe("running");
  });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-reconcile-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  store.insertRepo({
    id: "repo_x",
    name: "X",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "wt"),
    setupHookIds: [],
    teardownHookIds: [],
    requestReviewHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    archivedAt: null,
  });
  fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
  store.insertScheduledAgent({
    id: "sched_x",
    name: "x",
    description: null,
    scheduleType: "recurring",
    cron: "0 9 * * *",
    runAt: null,
    repoId: "repo_x",
    runtimeId: "shell",
    prompt: null,
    workspaceStrategy: "new",
    workspaceName: "x",
    baseBranch: null,
    runMode: "background",
    backgroundCwd: null,
    overlapPolicy: "skip",
    enabled: true,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunMessage: null,
    lastWorkspaceId: null,
    lastSessionId: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  });
  const logPath = path.join(dir, "run.log");
  return { store, dir, repoId: "repo_x", agentId: "sched_x", logPath };
}

function seedBackground(store: SqliteStore, agentId: string, bgId: string, tmuxName: string, logPath: string) {
  store.insertBackgroundSession({
    id: bgId,
    scheduledAgentId: agentId,
    cwd: "/tmp",
    logFilePath: logPath,
    tmuxSessionName: tmuxName,
    tmuxSessionId: "$1",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  store.insertScheduledAgentRun({
    id: "inflight_run",
    scheduledAgentId: agentId,
    status: "running",
    enqueuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
    message: null,
    workspaceId: null,
    sessionId: null,
    backgroundSessionId: bgId,
    logFilePath: logPath,
  });
}
