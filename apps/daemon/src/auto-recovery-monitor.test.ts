import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type { CiProviderSummary, VersionControlSummary, Workspace } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { type AutoRecoveryMonitorDeps, runAutoRecoveryTick } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { FIX_CI_PROMPT, decideAutoRecoveryAction } from "./auto-recovery.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(): SqliteStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-recovery-test-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  return store;
}

function seedRepoAndWorkspace(store: SqliteStore, workspaceId = "ws_test") {
  const now = new Date().toISOString();
  store.insertRepo({
    id: "repo_test",
    name: "Repo",
    rootPath: "/tmp/fake",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/fake/wt",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  const workspace: Workspace = {
    id: workspaceId,
    repoId: "repo_test",
    name: "Test Workspace",
    path: "/tmp/fake/wt/test",
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
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  store.insertWorkspace(workspace);
  return workspace;
}

function makeConfig(): CitadelConfig {
  return {
    dataDir: "/tmp/fake",
    databasePath: "/tmp/fake/db",
    providers: { github: { enabled: false, command: "gh" }, jira: { enabled: false, command: "jtk" } },
    runtimes: [{ id: "claude-code", displayName: "Claude Code", command: "claude", args: [] }],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    hooks: [],
    commandPolicy: { hookTimeoutMs: 120_000 },
  } as unknown as CitadelConfig;
}

const FAILING_VC: VersionControlSummary = {
  providerId: "github-gh",
  status: "healthy",
  reason: null,
  defaultBranch: "main",
  currentBranch: "feature",
  remotes: ["origin"],
  pullRequest: {
    number: 1,
    title: "PR",
    url: "https://example.test/pr/1",
    state: "OPEN",
    draft: false,
    reviewDecision: null,
    additions: 0,
    deletions: 0,
    reviewers: [],
    checks: [{ name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null }],
    commits: [],
    headRefName: "feature",
    parentPr: null,
    mergeable: "mergeable",
    allowedMergeStrategies: [],
    mergeStateStatus: "CLEAN",
    headSha: "sha_one",
  },
  checkedAt: "2026-05-25T12:00:00.000Z",
};

const FAILING_CI: CiProviderSummary = {
  providerId: "github-gh",
  status: "healthy",
  reason: null,
  runs: [
    {
      providerId: "github-gh",
      id: "100",
      name: "CI",
      status: "completed",
      conclusion: "failure",
      branch: "feature",
      event: "push",
      url: "https://example.test/run/100",
      createdAt: "2026-05-25T11:55:00.000Z",
    },
  ],
  checkedAt: "2026-05-25T12:00:00.000Z",
};

function makeDeps(
  store: SqliteStore,
  spawn: AutoRecoveryMonitorDeps["spawnAutoRecoveryAgent"],
): AutoRecoveryMonitorDeps {
  return {
    store,
    config: makeConfig(),
    decide: decideAutoRecoveryAction,
    fetchVersionControl: async () => FAILING_VC,
    fetchCi: async () => FAILING_CI,
    spawnAutoRecoveryAgent: spawn,
    prompt: FIX_CI_PROMPT,
    idleThresholdMs: 300_000,
    debounceMs: 1_800_000,
    disabled: false,
  };
}

describe("runAutoRecoveryTick (integration via in-memory store)", () => {
  it("fires once on the first tick, persists the SHA, and skips the second same-SHA tick", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_one");
    let spawnCount = 0;
    const spawn: AutoRecoveryMonitorDeps["spawnAutoRecoveryAgent"] = async () => {
      spawnCount += 1;
      return { id: `sess_${spawnCount}` };
    };
    const deps = makeDeps(store, spawn);

    // Tick 1 — should fire.
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(spawnCount).toBe(1);
    const state = store.getWorkspaceAutoRecoveryState("ws_one");
    expect(state?.lastCiSha).toBe("sha_one");
    expect(state?.lastAttemptAt).toBe("2026-05-25T12:00:00.000Z");

    // Tick 2 (same SHA, within debounce) — must NOT fire again.
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:05:00.000Z"));
    expect(spawnCount).toBe(1);
  });

  it("atomic UPDATE prevents the second concurrent tick from spawning", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_race");
    let spawnCount = 0;
    const deps = makeDeps(store, async () => {
      spawnCount += 1;
      return { id: `sess_${spawnCount}` };
    });

    // Manually simulate "concurrent tick A already claimed the slot":
    // pre-populate the row as if the prior attempt happened 1 ms ago. The
    // second tick should see the row in the debounce window AND with the
    // same SHA, and skip — that's the dedupe path.
    store.tryRecordAutoRecoveryAttempt({
      workspaceId: "ws_race",
      sha: "sha_one",
      now: "2026-05-25T11:59:59.999Z",
      debounceCutoff: "2026-05-25T11:30:00.000Z",
    });

    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    // Decide returns sha_dedupe_and_debounced; spawn must not be called.
    expect(spawnCount).toBe(0);
  });

  it("does not spawn when CITADEL_AUTO_RECOVERY_DISABLED equivalent (disabled flag) is set", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_disabled");
    let spawnCount = 0;
    const deps = makeDeps(store, async () => {
      spawnCount += 1;
      return { id: "x" };
    });
    deps.disabled = true;
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(spawnCount).toBe(0);
  });

  it("does not spawn when no non-shell runtime is configured", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_no_runtime");
    let spawnCount = 0;
    const deps = makeDeps(store, async () => {
      spawnCount += 1;
      return { id: "x" };
    });
    deps.config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: [] }];
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(spawnCount).toBe(0);
  });

  it("skips workspaces with degraded provider data", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_degraded");
    let spawnCount = 0;
    const deps = makeDeps(store, async () => {
      spawnCount += 1;
      return { id: "x" };
    });
    deps.fetchVersionControl = async () => ({ ...FAILING_VC, status: "degraded" });
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(spawnCount).toBe(0);
  });

  it("does not fetch CI for workspaces without a PR", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_no_pr");
    let ciCalls = 0;
    const deps = makeDeps(store, async () => ({ id: "x" }));
    deps.fetchVersionControl = async () => ({ ...FAILING_VC, pullRequest: null });
    deps.fetchCi = async () => {
      ciCalls += 1;
      return FAILING_CI;
    };

    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));

    expect(ciCalls).toBe(0);
  });

  it("shouldRun=false short-circuits the tick (no provider calls, no spawn)", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_gated");
    let spawnCount = 0;
    let providerCalls = 0;
    const deps = makeDeps(store, async () => {
      spawnCount += 1;
      return { id: "x" };
    });
    deps.fetchVersionControl = async () => {
      providerCalls += 1;
      return FAILING_VC; // never reached when shouldRun=false; assertion on providerCalls.
    };
    deps.shouldRun = () => false;
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(spawnCount).toBe(0);
    expect(providerCalls).toBe(0);
  });

  it("shouldRun=true runs the tick normally", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_gated_open");
    let providerCalls = 0;
    const deps = makeDeps(store, async () => ({ id: "x" }));
    const originalFetch = deps.fetchVersionControl;
    deps.fetchVersionControl = async (path: string) => {
      providerCalls += 1;
      return originalFetch(path);
    };
    deps.shouldRun = () => true;
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(providerCalls).toBeGreaterThan(0);
  });

  it("omitting shouldRun preserves prior behavior (tick runs every call)", async () => {
    const store = makeStore();
    seedRepoAndWorkspace(store, "ws_no_gate");
    let providerCalls = 0;
    const deps = makeDeps(store, async () => ({ id: "x" }));
    const originalFetch = deps.fetchVersionControl;
    deps.fetchVersionControl = async (path: string) => {
      providerCalls += 1;
      return originalFetch(path);
    };
    // deps.shouldRun deliberately not set.
    await runAutoRecoveryTick(deps, new Date("2026-05-25T12:00:00.000Z"));
    expect(providerCalls).toBeGreaterThan(0);
  });
});
