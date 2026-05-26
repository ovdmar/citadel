import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo, Workspace } from "@citadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GhScheduler } from "./gh-scheduler.js";
import {
  type MainWatcherDeps,
  parseLsRemoteSha,
  pickGitCwd,
  runMainWatcherTick,
  startMainWatcher,
} from "./main-watcher.js";

// Per-test clean-up of temp dirs we create so realistic .git path probing in
// pickGitCwd uses real fs but doesn't pollute /tmp.
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempGitDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-mw-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_1",
    name: "owner/repo",
    rootPath: "/nonexistent/root",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/nonexistent/wt",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: "repo_1",
    name: "ws",
    path: "/nonexistent/ws",
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
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

type StubStore = MainWatcherDeps["store"];

function makeStubStore(repos: Repo[], workspaces: Workspace[]): StubStore {
  return {
    listRepos: () => repos,
    listWorkspaces: () => workspaces,
  } as unknown as StubStore;
}

function makeStubScheduler(): { stub: GhScheduler; calls: string[] } {
  const calls: string[] = [];
  const stub = {
    markRepoMainMoved: (repoFullName: string) => calls.push(repoFullName),
    // Other methods unused by main-watcher.
    shouldRefetch: () => ({ fetch: true as const }),
    recordFetch: () => {},
    recordFetchError: () => {},
    evict: () => {},
    invalidateNotDue: () => {},
    hydrate: () => {},
    _entries: () => new Map(),
  } satisfies GhScheduler;
  return { stub, calls };
}

function quietLog(_level: "debug" | "warn", _message: string): void {}

describe("parseLsRemoteSha", () => {
  it("returns the SHA from a valid ls-remote line", () => {
    expect(parseLsRemoteSha("a1b2c3d4e5f6\trefs/heads/main\n")).toBe("a1b2c3d4e5f6");
  });

  it("returns null for empty stdout", () => {
    expect(parseLsRemoteSha("")).toBeNull();
    expect(parseLsRemoteSha("   \n")).toBeNull();
  });

  it("returns null for malformed lines (no tab)", () => {
    expect(parseLsRemoteSha("not-a-ref-line")).toBeNull();
  });

  it("rejects non-hex SHA values", () => {
    expect(parseLsRemoteSha("zzz\trefs/heads/main")).toBeNull();
  });
});

describe("pickGitCwd", () => {
  it("prefers repo.rootPath when it has a .git directory", () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const result = pickGitCwd(repo, []);
    expect(result).toEqual({ cwd: gitDir, reason: "root" });
  });

  it("falls back to the first workspace path with a .git directory", () => {
    const wsDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: "/definitely/does/not/exist" });
    const workspaces = [makeWorkspace({ path: wsDir })];
    const result = pickGitCwd(repo, workspaces);
    expect(result).toEqual({ cwd: wsDir, reason: "workspace" });
  });

  it("returns null when neither rootPath nor any workspace has a .git", () => {
    const repo = makeRepo({ rootPath: "/no/git/here" });
    const workspaces = [makeWorkspace({ path: "/also/no/git" })];
    expect(pickGitCwd(repo, workspaces)).toBeNull();
  });
});

describe("runMainWatcherTick", () => {
  let scheduler: ReturnType<typeof makeStubScheduler>;
  let lastSeen: Map<string, string>;

  beforeEach(() => {
    scheduler = makeStubScheduler();
    lastSeen = new Map();
  });

  it("first-seen SHA stores but does NOT call markRepoMainMoved", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => "abc1234\trefs/heads/main\n",
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(scheduler.calls).toEqual([]);
    expect(lastSeen.get("owner/repo")).toBe("abc1234");
  });

  it("stable SHA across two ticks → no scheduler call", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => "abc1234\trefs/heads/main\n",
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(scheduler.calls).toEqual([]);
  });

  it("changed SHA on second tick → exactly one markRepoMainMoved call", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    let shaToReturn = "abc1234";
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => `${shaToReturn}\trefs/heads/main\n`,
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    shaToReturn = "def5678";
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(scheduler.calls).toEqual(["owner/repo"]);
  });

  it("ls-remote failure is tolerated; last-seen SHA preserved", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    let shouldThrow = false;
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => {
        if (shouldThrow) throw new Error("network blip");
        return "abc1234\trefs/heads/main\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    shouldThrow = true;
    await runMainWatcherTick(deps, lastSeen, quietLog); // throws → tolerated
    shouldThrow = false;
    await runMainWatcherTick(deps, lastSeen, quietLog); // recovers; SHA still abc1234
    expect(scheduler.calls).toEqual([]); // never moved
    expect(lastSeen.get("owner/repo")).toBe("abc1234");
  });

  it("skipped entirely when !hasViewers && grace expired (no ls-remote spawn)", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    let lsRemoteCalls = 0;
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => false,
      msSinceLastViewer: () => 999_999, // way past grace
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => {
        lsRemoteCalls += 1;
        return "abc1234\trefs/heads/main\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(lsRemoteCalls).toBe(0);
  });

  it("runs when within the 2-minute grace window even with hasViewers=false", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    const ws = makeWorkspace();
    let lsRemoteCalls = 0;
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => false,
      msSinceLastViewer: () => 60_000, // 1 min — inside grace
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => {
        lsRemoteCalls += 1;
        return "abc1234\trefs/heads/main\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(lsRemoteCalls).toBe(1);
  });

  it("uses repo.defaultRemote (non-origin supported, e.g., fork workflows)", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir, defaultRemote: "upstream", defaultBranch: "trunk" });
    const ws = makeWorkspace();
    const capturedArgs: Array<{ remote: string; ref: string }> = [];
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async (input) => {
        capturedArgs.push({ remote: input.remote, ref: input.ref });
        return "abc1234\trefs/heads/trunk\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(capturedArgs).toEqual([{ remote: "upstream", ref: "refs/heads/trunk" }]);
  });

  it("skips a repo with no live workspaces (no PRs to refresh)", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir });
    let lsRemoteCalls = 0;
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], []),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => {
        lsRemoteCalls += 1;
        return "abc1234\trefs/heads/main\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(lsRemoteCalls).toBe(0);
  });

  it("skips archived repos", async () => {
    const gitDir = makeTempGitDir();
    const repo = makeRepo({ rootPath: gitDir, archivedAt: "2026-05-25T00:00:00.000Z" });
    const ws = makeWorkspace();
    let lsRemoteCalls = 0;
    const deps: MainWatcherDeps = {
      store: makeStubStore([repo], [ws]),
      scheduler: scheduler.stub,
      hasViewers: () => true,
      msSinceLastViewer: () => 0,
      resolveRepoFullName: () => "owner/repo",
      runLsRemote: async () => {
        lsRemoteCalls += 1;
        return "abc1234\trefs/heads/main\n";
      },
    };
    await runMainWatcherTick(deps, lastSeen, quietLog);
    expect(lsRemoteCalls).toBe(0);
  });
});

describe("startMainWatcher", () => {
  it("CITADEL_MAIN_WATCHER_DISABLED=1 returns a no-op stop handle (no interval)", () => {
    const prev = process.env.CITADEL_MAIN_WATCHER_DISABLED;
    process.env.CITADEL_MAIN_WATCHER_DISABLED = "1";
    try {
      const setSpy = vi.spyOn(globalThis, "setInterval");
      const handle = startMainWatcher({
        store: makeStubStore([], []),
        scheduler: makeStubScheduler().stub,
        hasViewers: () => true,
        msSinceLastViewer: () => 0,
        resolveRepoFullName: () => "owner/repo",
      });
      expect(setSpy).not.toHaveBeenCalled();
      handle.stop(); // no-op; must not throw
      setSpy.mockRestore();
    } finally {
      if (prev === undefined) {
        delete process.env.CITADEL_MAIN_WATCHER_DISABLED;
      } else {
        process.env.CITADEL_MAIN_WATCHER_DISABLED = prev;
      }
    }
  });
});
