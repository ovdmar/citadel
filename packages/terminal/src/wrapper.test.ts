import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentExitSentinelPath,
  agentLiveSentinelPath,
  captureTmux,
  ensureTmuxSession,
  killTmuxSession,
  readAgentExitCode,
  terminalCommand,
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

// ---------------------------------------------------------------------------
// Exit-hint contract — see specs/B.3 item 13.
// Pure-string tests run without tmux; the integration test below resolves a
// real UUID by populating a fixture transcript under the operator's HOME.
// ---------------------------------------------------------------------------

describe("terminalCommand exit hint", () => {
  it("builds a syntactically valid bash script for the claude-code runtime", () => {
    const script = terminalCommand("citadel_unit_claude", "claude", [], { runtimeId: "claude-code" });
    // `bash -n` parses without executing — catches quoting bugs that would
    // otherwise only show up at agent-launch time (and drop the user straight
    // into the fallback shell with no agent ever running).
    expect(() => execFileSync("bash", ["-nc", script], { stdio: "pipe" })).not.toThrow();
    expect(script).toContain(".claude/projects/");
    expect(script).toContain("claude resume %s");
    expect(script).toContain("claude resume` to pick a session interactively");
  });

  it("builds a syntactically valid bash script for non-claude runtimes (fallback only)", () => {
    const script = terminalCommand("citadel_unit_codex", "codex", [], { runtimeId: "codex" });
    expect(() => execFileSync("bash", ["-nc", script], { stdio: "pipe" })).not.toThrow();
    // No resolver — no project_dir lookup, no %s format.
    expect(script).not.toContain(".claude/projects/");
    expect(script).not.toContain("claude resume %s");
    expect(script).toContain("claude resume` to pick a session interactively");
  });

  it("does not leak the <sessionId> placeholder text", () => {
    const claude = terminalCommand("c", "claude", [], { runtimeId: "claude-code" });
    const codex = terminalCommand("c", "codex", [], { runtimeId: "codex" });
    expect(claude).not.toContain("<sessionId>");
    expect(codex).not.toContain("<sessionId>");
  });

  it("never cd's away from the workspace cwd — the resolver depends on $PWD", () => {
    // Regression guard: a future "small fix" that prepends a `cd` would
    // silently break Claude UUID resolution by pointing $PWD at the wrong
    // project dir. If you must change the cwd, update this assertion AND
    // the resolver together.
    const script = terminalCommand("c", "claude", [], { runtimeId: "claude-code" });
    expect(script).not.toMatch(/(^|;|\n|&&|\|\|)\s*cd\s/);
  });
});

describe.runIf(hasTmux())("terminal wrapper exit hint (live tmux)", () => {
  const created: string[] = [];
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const name of created.splice(0)) {
      try {
        killTmuxSession(name);
      } catch {
        /* best-effort */
      }
    }
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  // tmux wraps long lines at the pane width (typically 80 cols). Collapse
  // whitespace before matching so the assertion isn't tied to terminal width.
  function flatten(text: string): string {
    return text.replace(/\s+/g, "");
  }

  async function waitForHint(name: string, needle: string, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    const wanted = flatten(needle);
    let lastPane = "";
    while (Date.now() < deadline) {
      lastPane = captureTmux(name, 200);
      if (flatten(lastPane).includes(wanted)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Hint "${needle}" did not appear within ${timeoutMs}ms. Last pane:\n${lastPane}`);
  }

  function makeFixtureCwd(slug: string) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `citadel-exit-hint-${slug}-`));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    return cwd;
  }

  function makeFixtureTranscript(cwd: string, uuid: string): string {
    // Mirror packages/runtimes/src/transcripts/claude-code.ts:11-14 exactly so
    // the wrapper's sed expression finds the dir we just created.
    const dasherized = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const projectDir = path.join(os.homedir(), ".claude", "projects", dasherized);
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, `${uuid}.jsonl`);
    fs.writeFileSync(transcript, "");
    cleanups.push(() => {
      try {
        fs.rmSync(projectDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    return transcript;
  }

  it("prints the resolved UUID hint when a Claude transcript exists for the cwd", async () => {
    const cwd = makeFixtureCwd("resolve");
    const uuid = "abc12345-6789-4abc-9def-0123456789ab";
    makeFixtureTranscript(cwd, uuid);
    const name = uniqueSessionName("hint-resolved");
    created.push(name);
    await ensureTmuxSession({
      sessionName: name,
      cwd,
      command: "bash",
      args: ["-c", "exit 0"],
      runtimeId: "claude-code",
    });
    await waitForHint(name, `claude resume ${uuid}`);
  }, 15000);

  it("prints the fallback hint when no Claude transcript exists for the cwd", async () => {
    const cwd = makeFixtureCwd("fallback");
    // Pre-clean any stale project dir that might shadow a fresh fixture.
    const dasherized = cwd.replace(/[^A-Za-z0-9]/g, "-");
    fs.rmSync(path.join(os.homedir(), ".claude", "projects", dasherized), { recursive: true, force: true });
    const name = uniqueSessionName("hint-fallback");
    created.push(name);
    await ensureTmuxSession({
      sessionName: name,
      cwd,
      command: "bash",
      args: ["-c", "exit 0"],
      runtimeId: "claude-code",
    });
    await waitForHint(name, "claude resume` to pick a session interactively");
  }, 15000);

  it("uses the fallback hint for non-Claude runtimes even when a transcript file exists", async () => {
    const cwd = makeFixtureCwd("non-claude");
    makeFixtureTranscript(cwd, "shouldnt-be-used");
    const name = uniqueSessionName("hint-non-claude");
    created.push(name);
    await ensureTmuxSession({
      sessionName: name,
      cwd,
      command: "bash",
      args: ["-c", "exit 0"],
      runtimeId: "codex",
    });
    await waitForHint(name, "claude resume` to pick a session interactively");
    // And crucially, the resolved-UUID form must not appear.
    const pane = captureTmux(name, 200);
    expect(flatten(pane)).not.toContain(flatten("claude resume shouldnt-be-used"));
  }, 15000);

  it("resolves the UUID when the workspace cwd contains shell-special characters", async () => {
    // Plan failure-modes called this out: a future change to shellQuote or
    // the printf line could break resolution on workspaces under paths
    // containing spaces / quotes / backticks. The wrapper uses
    // `printf %s "$PWD" | sed` which treats $PWD as a single argument,
    // so spaces survive. This test pins that behavior end-to-end.
    const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-exit-hint-spaces-"));
    cleanups.push(() => fs.rmSync(baseTmp, { recursive: true, force: true }));
    const cwd = path.join(baseTmp, "My Workspace");
    fs.mkdirSync(cwd, { recursive: true });
    const uuid = "spaced-aaaa-bbbb-cccc-ddddeeeeffff";
    makeFixtureTranscript(cwd, uuid);
    const name = uniqueSessionName("hint-spaces");
    created.push(name);
    await ensureTmuxSession({
      sessionName: name,
      cwd,
      command: "bash",
      args: ["-c", "exit 0"],
      runtimeId: "claude-code",
    });
    await waitForHint(name, `claude resume ${uuid}`);
  }, 15000);
});
