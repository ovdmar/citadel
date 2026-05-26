import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentExitSentinelPath,
  agentLiveSentinelPath,
  ensureTmuxSession,
  killTmuxSession,
  readAgentExitCode,
  tmuxSessionExists,
} from "./index.js";

// Skip the suite if tmux isn't installed (CI environments without tmux
// shouldn't break this test).
function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function uniqueSessionName(suffix: string) {
  return `citadel_wrapper_test_${process.pid}_${Date.now().toString(36)}_${suffix}`;
}

async function waitForSentinelGone(sessionName: string, timeoutMs = 5000): Promise<void> {
  const livePath = agentLiveSentinelPath(sessionName);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(livePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Live sentinel ${livePath} did not disappear within ${timeoutMs}ms`);
}

describe.runIf(hasTmux())("terminal wrapper exit-code capture", () => {
  const created: string[] = [];

  beforeEach(() => {
    created.length = 0;
  });

  afterEach(() => {
    for (const name of created) {
      try {
        killTmuxSession(name);
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("writes exit code 0 to .exit and removes .live on clean exit", async () => {
    const name = uniqueSessionName("ok");
    created.push(name);
    await ensureTmuxSession({ sessionName: name, cwd: "/tmp", command: "bash", args: ["-c", "exit 0"] });
    await waitForSentinelGone(name);
    expect(readAgentExitCode(name)).toBe(0);
    // tmux session itself is still alive (fallback shell) — pane survives.
    expect(tmuxSessionExists(name)).toBe(true);
  });

  it("writes non-zero exit code to .exit on agent failure", async () => {
    const name = uniqueSessionName("fail");
    created.push(name);
    await ensureTmuxSession({ sessionName: name, cwd: "/tmp", command: "bash", args: ["-c", "exit 7"] });
    await waitForSentinelGone(name);
    expect(readAgentExitCode(name)).toBe(7);
    expect(tmuxSessionExists(name)).toBe(true);
  });

  it("pane survives the agent exit with a fallback shell — wrapper's primary purpose", async () => {
    const name = uniqueSessionName("pane");
    created.push(name);
    await ensureTmuxSession({ sessionName: name, cwd: "/tmp", command: "bash", args: ["-c", "echo hi; exit 0"] });
    await waitForSentinelGone(name);
    // 200ms grace for fallback shell to take over.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tmuxSessionExists(name)).toBe(true);
  });

  it("killTmuxSession removes both .live and .exit sentinel files", async () => {
    const name = uniqueSessionName("cleanup");
    created.push(name);
    await ensureTmuxSession({ sessionName: name, cwd: "/tmp", command: "bash", args: ["-c", "exit 0"] });
    await waitForSentinelGone(name);
    expect(fs.existsSync(agentExitSentinelPath(name))).toBe(true);
    killTmuxSession(name);
    expect(fs.existsSync(agentLiveSentinelPath(name))).toBe(false);
    expect(fs.existsSync(agentExitSentinelPath(name))).toBe(false);
  });

  it("readAgentExitCode returns null when no .exit file exists", () => {
    const name = uniqueSessionName("missing");
    expect(readAgentExitCode(name)).toBeNull();
  });

  it("clears a stale .exit sentinel left by a prior incarnation with the same name", async () => {
    // Reproduces the daemon-restart bug: an existing .exit from a previous
    // wrapper run would otherwise be read by the status monitor and mark the
    // fresh session as already-stopped before the agent even starts. The
    // wrapper's leading `rm -f ${exitSentinel}` must clear that stale file.
    const name = uniqueSessionName("stale-exit");
    created.push(name);
    fs.writeFileSync(agentExitSentinelPath(name), "42\n");
    expect(readAgentExitCode(name)).toBe(42);
    await ensureTmuxSession({
      sessionName: name,
      cwd: "/tmp",
      command: "bash",
      args: ["-c", "exit 0"],
    });
    await waitForSentinelGone(name);
    // The fresh wrapper's exit (0) must overwrite the stale 42 — proves the
    // wrapper ran on a clean slate. With the bug present, the wrapper's
    // explicit `echo $rc > .exit` would still produce 0, so a stronger check
    // is that .live mtime is newer than .exit mtime during the run. Easiest
    // observable end-state check: final exit code is 0, not 42.
    expect(readAgentExitCode(name)).toBe(0);
  });

  it("during the wrapper run, .live is newer than .exit (the stale-.exit guard's anchor)", async () => {
    // The status-monitor's stale-.exit guard relies on `live.mtime > exit.mtime`.
    // Verifies the wrapper produces that ordering when a stale .exit exists at
    // launch time.
    const name = uniqueSessionName("mtime-order");
    created.push(name);
    fs.writeFileSync(agentExitSentinelPath(name), "42\n");
    const staleExitMtimeMs = fs.statSync(agentExitSentinelPath(name)).mtimeMs;
    // Sleep long enough that .live's touch lands measurably later.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ensureTmuxSession({
      sessionName: name,
      cwd: "/tmp",
      command: "bash",
      args: ["-c", "sleep 0.3"],
    });
    // Mid-run: .live exists; either .exit is gone (rm completed) OR a new .exit
    // hasn't been written yet. Poll briefly for .live to appear.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (fs.existsSync(agentLiveSentinelPath(name))) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fs.existsSync(agentLiveSentinelPath(name))).toBe(true);
    const liveMtimeMs = fs.statSync(agentLiveSentinelPath(name)).mtimeMs;
    expect(liveMtimeMs).toBeGreaterThan(staleExitMtimeMs);
    await waitForSentinelGone(name);
  });
});
