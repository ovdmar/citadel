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
});
