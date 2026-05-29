// Adoption-path tests for the ttyd manager. We exercise adopt() directly
// rather than spawning real ttyds: the records list is the same shape
// discoverExistingTtyds() produces, and the routing decisions
// (adopt / reap-duplicate / reap-unknown) live entirely inside adopt().
//
// Each test spawns a `sleep` child as a target the manager can safely
// SIGTERM — using process.pid would kill the test runner, and using a
// fictitious pid would make process.kill(pid, 0) throw ESRCH which
// isEntryAlive treats as dead (and adopt would refuse to adopt it).

import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createTtydManager } from "./ttyd.js";

const spawnedChildren: ChildProcess[] = [];
afterEach(() => {
  for (const child of spawnedChildren.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

function liveChildPid(): number {
  const child = spawn("sleep", ["120"], { detached: false, stdio: "ignore" });
  spawnedChildren.push(child);
  if (!child.pid) throw new Error("failed to spawn sleep");
  return child.pid;
}

function record(opts: { key: string; port: number; tmuxSession?: string; startedAt?: string; pid?: number }) {
  return {
    key: opts.key,
    port: opts.port,
    pid: opts.pid ?? liveChildPid(),
    basePath: `/terminals/${opts.key}`,
    tmuxSession: opts.tmuxSession ?? `tmux_${opts.key}`,
    worktreePath: null,
    startedAt: opts.startedAt ?? "2026-05-27T20:00:00.000Z",
    theme: "dark" as const,
    tabId: null,
  };
}

describe("ttyd manager — adopt()", () => {
  it("adopts every record when no resolveTabId is supplied (legacy callers)", () => {
    const manager = createTtydManager();
    const result = manager.adopt([record({ key: "sess_a", port: 11001 }), record({ key: "sess_b", port: 11002 })]);
    expect(result.adopted).toBe(2);
    expect(result.reapedDuplicates).toBe(0);
    expect(result.reapedUnknown).toBe(0);
    const keys = manager.list().map((entry) => entry.key);
    expect(keys.sort()).toEqual(["sess_a", "sess_b"]);
  });

  it("reaps records whose key isn't in the DB (legacy port-range orphans)", () => {
    const manager = createTtydManager();
    // Only sess_known has a DB row; sess_legacy is the 7xxx-style orphan we
    // want to nuke. pid=0 on the orphan so the SIGTERM branch is a no-op.
    const resolveTabId = (key: string) => (key === "sess_known" ? "tab_known" : null);
    const result = manager.adopt(
      [record({ key: "sess_known", port: 11001 }), record({ key: "sess_legacy", port: 7721, pid: liveChildPid() })],
      resolveTabId,
    );
    expect(result.adopted).toBe(1);
    expect(result.reapedUnknown).toBe(1);
    expect(result.reapedDuplicates).toBe(0);
    expect(manager.list().map((entry) => entry.key)).toEqual(["sess_known"]);
    expect(manager.list()[0]?.tabId).toBe("tab_known");
  });

  it("keeps the oldest ttyd per tab and reaps the rest as duplicates", () => {
    const manager = createTtydManager();
    // Two sessionIds sharing one tabId — typical of a resume-race where the
    // source row's ttyd was still alive when the restored row spawned a new
    // one. Oldest startedAt wins. pid=0 so the SIGTERM branch on the loser
    // is silent.
    const resolveTabId = (key: string) => (key === "sess_old" || key === "sess_new" ? "tab_shared" : null);
    const result = manager.adopt(
      [
        record({ key: "sess_old", port: 11001, startedAt: "2026-05-27T20:00:00.000Z" }),
        record({ key: "sess_new", port: 11002, startedAt: "2026-05-27T20:30:00.000Z", pid: liveChildPid() }),
      ],
      resolveTabId,
    );
    expect(result.adopted).toBe(1);
    expect(result.reapedDuplicates).toBe(1);
    expect(manager.list().map((entry) => entry.key)).toEqual(["sess_old"]);
  });

  it("releaseTab removes the entry serving that tab", () => {
    const manager = createTtydManager();
    manager.adopt([record({ key: "sess_a", port: 11001 })], () => "tab_a");
    expect(manager.list()).toHaveLength(1);
    const released = manager.releaseTab("tab_a");
    expect(released).toBe(1);
    expect(manager.list()).toHaveLength(0);
  });
});
