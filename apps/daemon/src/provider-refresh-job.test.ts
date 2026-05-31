import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type { AgentRuntime, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderCache } from "./provider-cache.js";
import { type ProviderRefreshDeps, startProviderRefreshJob } from "./provider-refresh-job.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.env.CITADEL_DISABLE_REFRESH_JOB = undefined;
});

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-refresh-job-"));
  dirs.push(dir);
  return dir;
}

function makeWorkspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoId: "repo",
    name: id,
    path: `/tmp/${id}`,
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
    archivedAt: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

function makeRuntime(id: string, healthy = true): AgentRuntime {
  return {
    id,
    displayName: id,
    command: "echo",
    args: [],
    health: healthy ? "healthy" : "unavailable",
    healthReason: healthy ? null : "missing",
    capabilities: {
      supportsPrompt: true,
      supportsResume: true,
      supportsModelSelection: false,
      supportsTranscript: false,
      supportsStatusDetection: false,
      supportsNonInteractiveGoal: false,
      supportsShell: false,
      supportsUsage: true,
      supportsTui: false,
    },
  };
}

function makeDeps(overrides: Partial<ProviderRefreshDeps> & { workspaces?: Workspace[]; runtimes?: AgentRuntime[] }) {
  const workspaces = overrides.workspaces ?? [makeWorkspace("w1")];
  const runtimes = overrides.runtimes ?? [];
  const config = {
    runtimes: runtimes.map((r) => ({ id: r.id, displayName: r.displayName, command: r.command, args: r.args })),
    usageProviders: [],
    providerRefresh: {
      enabled: true,
      workingHours: { startHour: 0, endHour: 24, weekdaysOnly: false },
      intervals: { prCiMs: 60_000, jiraMs: 5 * 60_000, usageMs: 5 * 60_000 },
      focusRefreshThresholdMs: 30_000,
      maxConcurrentRefreshes: 4,
    },
  } as unknown as CitadelConfig;
  const store = {
    listWorkspaces: () => workspaces,
  } as unknown as SqliteStore;
  const cache = createProviderCache({ dataDir: tempDataDir(), listLiveIds: () => workspaces.map((w) => w.id) });
  const checkedAt = () => new Date().toISOString();
  const providers = {
    collectGitHubVersionControlSummary: vi.fn(async () => ({
      providerId: "github-gh",
      status: "healthy" as const,
      reason: null,
      checkedAt: checkedAt(),
      defaultBranch: null,
      currentBranch: null,
      remotes: [],
      pullRequest: null,
    })),
    collectGitHubCiRuns: vi.fn(async () => ({
      providerId: "github-gh",
      status: "healthy" as const,
      reason: null,
      checkedAt: checkedAt(),
      runs: [],
    })),
    collectJiraIssueSummary: vi.fn(async () => ({
      providerId: "jira-jtk",
      status: "healthy" as const,
      reason: null,
      checkedAt: checkedAt(),
      key: "X-1",
      summary: null,
      issueStatus: null,
      assignee: null,
      updated: null,
      url: null,
      transitions: [],
    })),
    collectRuntimeUsage: vi.fn(async () => ({
      runtimeId: "x",
      providerId: "usage-x",
      source: "test",
      status: "healthy" as const,
      reason: null,
      categories: [],
      checkedAt: checkedAt(),
    })),
    listRuntimeHealth: () => runtimes,
  };
  return {
    config,
    store,
    cache,
    providers,
    ...overrides,
  } as ProviderRefreshDeps;
}

describe("startProviderRefreshJob", () => {
  it("skips when outside working hours", async () => {
    const deps = makeDeps({
      workspaces: [makeWorkspace("w1")],
    });
    (deps.config as CitadelConfig).providerRefresh.workingHours = {
      startHour: 9,
      endHour: 18,
      weekdaysOnly: false,
    };
    // Force "now" to be 04:00 local — outside the 9–18 window.
    const fourAm = new Date();
    fourAm.setHours(4, 0, 0, 0);
    const job = startProviderRefreshJob({ ...deps, now: () => fourAm.getTime(), tickIntervalMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).not.toHaveBeenCalled();
    job.stop();
  });

  it("skips when disabled in config", async () => {
    const deps = makeDeps({});
    (deps.config as CitadelConfig).providerRefresh.enabled = false;
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).not.toHaveBeenCalled();
    job.stop();
  });

  it("refreshes PR/CI for each workspace on a tick when cache is empty", async () => {
    const deps = makeDeps({ workspaces: [makeWorkspace("w1"), makeWorkspace("w2")] });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).toHaveBeenCalledTimes(2);
    expect(deps.providers.collectGitHubCiRuns).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("does not refresh PR/CI when entries are still fresh", async () => {
    const deps = makeDeps({ workspaces: [makeWorkspace("w1")] });
    deps.cache.set("vc:w1:2026-05-25T00:00:00Z", {
      expiresAt: Date.now() + 60_000,
      value: { fresh: true },
      cachedAt: Date.now() - 5_000,
    });
    deps.cache.set("ci:w1:2026-05-25T00:00:00Z", {
      expiresAt: Date.now() + 60_000,
      value: { fresh: true },
      cachedAt: Date.now() - 5_000,
    });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).not.toHaveBeenCalled();
    expect(deps.providers.collectGitHubCiRuns).not.toHaveBeenCalled();
    job.stop();
  });

  it("respects single-in-flight per cacheKey", async () => {
    const deps = makeDeps({ workspaces: [makeWorkspace("w1")] });
    let resolveVc: () => void = () => {};
    deps.providers.collectGitHubVersionControlSummary = vi.fn(
      (): Promise<VersionControlSummary> =>
        new Promise((resolve) => {
          resolveVc = () =>
            resolve({
              providerId: "github-gh",
              status: "healthy" as const,
              reason: null,
              checkedAt: new Date().toISOString(),
              defaultBranch: null,
              currentBranch: null,
              remotes: [],
              pullRequest: null,
            });
        }),
    );
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    // Two ticks while the first one is still in flight.
    void job.runTickForTest();
    void job.runTickForTest();
    await new Promise((r) => setTimeout(r, 50));
    expect(deps.providers.collectGitHubVersionControlSummary).toHaveBeenCalledTimes(1);
    resolveVc();
    job.stop();
  });

  it("respects global concurrency cap", async () => {
    const wss = [
      makeWorkspace("w1"),
      makeWorkspace("w2"),
      makeWorkspace("w3"),
      makeWorkspace("w4"),
      makeWorkspace("w5"),
    ];
    const deps = makeDeps({ workspaces: wss });
    (deps.config as CitadelConfig).providerRefresh.maxConcurrentRefreshes = 2;
    let inFlight = 0;
    let peak = 0;
    deps.providers.collectGitHubVersionControlSummary = vi.fn(async (): Promise<VersionControlSummary> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return {
        providerId: "github-gh",
        status: "healthy" as const,
        reason: null,
        checkedAt: new Date().toISOString(),
        defaultBranch: null,
        currentBranch: null,
        remotes: [],
        pullRequest: null,
      };
    });
    deps.providers.collectGitHubCiRuns = vi.fn(async () => {
      // CI runs are fast — only VC measures concurrency for this test.
      return {
        providerId: "github-gh",
        status: "healthy" as const,
        reason: null,
        checkedAt: new Date().toISOString(),
        runs: [],
      };
    });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    expect(peak).toBeLessThanOrEqual(2);
    job.stop();
  });

  it("re-checks workspace.archivedAt INSIDE executeItem (true TOCTOU)", async () => {
    // The real TOCTOU race: workspace is non-archived when the tick collects
    // items, then gets archived before executeItem dispatches the provider
    // call. The runTick-level pre-filter cannot catch this; only the re-check
    // inside executeItem can. A regression that removes the re-check would
    // let the provider call fire.
    //
    // We simulate the race by returning "non-archived" on the FIRST
    // listWorkspaces call (used by runTick's collect step) and "archived"
    // on every subsequent call (used by each executeItem's re-check).
    const ws = makeWorkspace("w1");
    const archivedWs = { ...ws, archivedAt: new Date().toISOString() };
    let listCalls = 0;
    const deps = makeDeps({ workspaces: [ws] });
    deps.store = {
      listWorkspaces: () => {
        listCalls += 1;
        return listCalls === 1 ? [ws] : [archivedWs];
      },
    } as unknown as SqliteStore;
    deps.providers.collectGitHubVersionControlSummary = vi.fn(async () => {
      throw new Error("vc provider must not be called after mid-tick archive");
    });
    deps.providers.collectGitHubCiRuns = vi.fn(async () => {
      throw new Error("ci provider must not be called after mid-tick archive");
    });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    // listWorkspaces was called >1 time: once by runTick + once per
    // executeItem re-check. That confirms the re-check actually fires.
    expect(listCalls).toBeGreaterThan(1);
    expect(deps.providers.collectGitHubVersionControlSummary).not.toHaveBeenCalled();
    expect(deps.providers.collectGitHubCiRuns).not.toHaveBeenCalled();
    job.stop();
  });

  it("re-checks runtime.health INSIDE executeItem (true TOCTOU)", async () => {
    const runtime = makeRuntime("r1", true);
    const unhealthyRuntime = { ...runtime, health: "unavailable" as const, healthReason: "flipped" };
    let listCalls = 0;
    const deps = makeDeps({ workspaces: [makeWorkspace("w1")], runtimes: [runtime] });
    // listRuntimeHealth returns "healthy" only on the first call (tick collect),
    // "unavailable" on every subsequent call (executeItem re-check). The
    // re-check inside executeItem must short-circuit before the provider call.
    deps.providers.listRuntimeHealth = () => {
      listCalls += 1;
      return listCalls === 1 ? [runtime] : [unhealthyRuntime];
    };
    deps.providers.collectRuntimeUsage = vi.fn(async () => {
      throw new Error("usage provider must not be called after mid-tick health flip");
    });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    expect(listCalls).toBeGreaterThan(1);
    expect(deps.providers.collectRuntimeUsage).not.toHaveBeenCalled();
    job.stop();
  });

  it("pauses usage refresh when no Citadel window is focused", async () => {
    const runtime = makeRuntime("r1", true);
    const deps = makeDeps({ workspaces: [], runtimes: [runtime], hasFocusedWindow: () => false });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectRuntimeUsage).not.toHaveBeenCalled();
    job.stop();
  });

  it("refreshes usage when a Citadel window is focused", async () => {
    const runtime = makeRuntime("r1", true);
    const deps = makeDeps({ workspaces: [], runtimes: [runtime], hasFocusedWindow: () => true });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectRuntimeUsage).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("pokeWorkspace queues an out-of-band refresh for one workspace", async () => {
    const deps = makeDeps({ workspaces: [makeWorkspace("w1"), makeWorkspace("w2")] });
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.pokeWorkspace("w2");
    // Only w2 was poked — w1 should be untouched.
    const callPaths = (deps.providers.collectGitHubVersionControlSummary as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(callPaths).toEqual(["/tmp/w2"]);
    job.stop();
  });

  it("does not bust cache on provider failure", async () => {
    const deps = makeDeps({ workspaces: [makeWorkspace("w1")] });
    deps.cache.set("vc:w1:2026-05-25T00:00:00Z", {
      expiresAt: Date.now() - 1, // stale
      value: "stale-value",
      cachedAt: Date.now() - 120_000,
    });
    deps.providers.collectGitHubVersionControlSummary = vi.fn(async () => {
      throw new Error("boom");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    // Cache value survived the failure.
    expect(deps.cache.get("vc:w1:2026-05-25T00:00:00Z")?.value).toBe("stale-value");
    errSpy.mockRestore();
    job.stop();
  });

  it("skips when CITADEL_DISABLE_REFRESH_JOB=1", async () => {
    process.env.CITADEL_DISABLE_REFRESH_JOB = "1";
    const deps = makeDeps({});
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).not.toHaveBeenCalled();
    job.stop();
  });

  it("does not consult process.env.VITEST for gating decisions (regression guard)", async () => {
    // Whatever VITEST is set to in this run, the job runs based on
    // config.providerRefresh.enabled + CITADEL_DISABLE_REFRESH_JOB ONLY.
    // VITEST being truthy must not silently disable the feature.
    const deps = makeDeps({});
    // Confirm VITEST is set in this vitest run (sanity).
    expect(process.env.VITEST).toBeTruthy();
    const job = startProviderRefreshJob({ ...deps, tickIntervalMs: 0, jitterMaxMs: 0 });
    await job.runTickForTest();
    expect(deps.providers.collectGitHubVersionControlSummary).toHaveBeenCalled();
    job.stop();
  });
});
