import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMM_TRUNCATION,
  agentExitHintCommand,
  ensureTmuxSession,
  killTmuxSession,
  launchAgentInSession,
  panePidProcess,
  sweepLegacyAgentSentinels,
  tmuxPrefix,
} from "./index.js";

const sessions: string[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) killTmuxSession(session);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeShellSession(suffix: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pane-lifecycle-"));
  dirs.push(cwd);
  const sessionName = `citadel_test_pl_${suffix}_${Date.now().toString(36)}`;
  sessions.push(sessionName);
  return { cwd, sessionName };
}

describe("panePidProcess", () => {
  it("returns { command, pid } for a live session and null for a missing one", async () => {
    const { cwd, sessionName } = makeShellSession("ppp");
    await ensureTmuxSession({ sessionName, cwd });
    const info = panePidProcess(sessionName);
    expect(info).not.toBeNull();
    expect(info?.command).toMatch(/^(bash|sh|zsh|fish|dash)$/);
    expect(Number.isFinite(info?.pid)).toBe(true);
    expect((info?.pid ?? -1) > 0).toBe(true);

    expect(panePidProcess("citadel_test_pl_does_not_exist")).toBeNull();
  });
});

describe("ensureTmuxSession (shell-first)", () => {
  it("creates a session whose pane PID is a login shell, NOT the legacy wrapper", async () => {
    const { cwd, sessionName } = makeShellSession("shell");
    await ensureTmuxSession({ sessionName, cwd });
    const info = panePidProcess(sessionName);
    expect(info?.command).toMatch(/^(bash|sh|zsh|fish|dash)$/);
  });

  it("does NOT write any /tmp/citadel-agent-*.{live,exit} sentinel files for shell-first sessions", async () => {
    const { cwd, sessionName } = makeShellSession("nosentinel");
    const liveBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("citadel-agent-"));
    await ensureTmuxSession({ sessionName, cwd });
    const liveAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("citadel-agent-"));
    // No NEW citadel-agent-* files should appear under the session name.
    const ours = liveAfter.filter((n) => n.includes(sessionName) && !liveBefore.includes(n));
    expect(ours).toEqual([]);
  });
});

describe("launchAgentInSession", () => {
  it("builds a Claude exit hint with the real runtime session id and no placeholder", () => {
    const command = agentExitHintCommand({ runtimeId: "claude-code", runtimeSessionId: "session-real-123" });
    expect(command).toContain("claude resume session-real-123");
    expect(command).not.toContain("<sessionId>");
  });

  it("sends env-prefixed argv via send-keys and waits for the runtime binary to be foreground (positive predicate)", async () => {
    const { cwd, sessionName } = makeShellSession("launch");
    await ensureTmuxSession({ sessionName, cwd });
    // Resize the pane wide so the long env+argv send-keys line doesn't
    // soft-wrap in the captured scrollback — the env-token assertions below
    // would otherwise miss across wrap boundaries.
    execFileSync("tmux", [...tmuxPrefix(), "resize-window", "-t", sessionName, "-x", "400", "-y", "40"], {
      stdio: "ignore",
    });
    // Use `sleep` as a stand-in agent — it sits as the foreground command
    // long enough for the predicate to match. Predicate uses COMM_TRUNCATION.
    await launchAgentInSession(sessionName, "sleep", ["10"], { timeoutMs: 3000 });
    const info = panePidProcess(sessionName);
    expect(info?.command).toBe("sleep".slice(0, COMM_TRUNCATION));
    // The session's pane history should contain the env prefix tokens. Strip
    // soft-wrap newlines (and trailing spaces tmux pads with) before matching
    // so the assertion isn't display-width-sensitive.
    const scrollRaw = execFileSync(
      "tmux",
      [...tmuxPrefix(), "capture-pane", "-p", "-J", "-S", "-50", "-t", sessionName],
      { encoding: "utf8", maxBuffer: 65_536 },
    );
    const scroll = scrollRaw.replace(/[ \t]+\n/g, "").replace(/\n/g, " ");
    expect(scroll).toContain("env -u NO_COLOR");
    expect(scroll).toContain("TERM=xterm-256color");
    expect(scroll).toContain("COLORTERM=truecolor");
    expect(scroll).toContain("FORCE_COLOR=1");
    expect(scroll).toContain("CLICOLOR_FORCE=1");
  }, 10_000);

  it("handles 15-character comm truncation for long binary names", async () => {
    // We can't actually run a binary with a 20-char name in a test, but we
    // can assert the constant + matching behaviour via the predicate logic.
    const longName = "really-long-runtime-name-over-15";
    expect(longName.slice(0, COMM_TRUNCATION).length).toBe(15);
    expect(longName.slice(0, COMM_TRUNCATION)).toBe("really-long-run");
  });

  it("prints the Claude resume hint after the launched agent exits", async () => {
    const { cwd, sessionName } = makeShellSession("hint");
    await ensureTmuxSession({ sessionName, cwd });
    await launchAgentInSession(sessionName, "sleep", ["1"], {
      timeoutMs: 3000,
      exitHint: { runtimeId: "claude-code", runtimeSessionId: "session-real-456" },
    });

    const deadline = Date.now() + 5000;
    let scroll = "";
    while (Date.now() < deadline) {
      scroll = execFileSync("tmux", [...tmuxPrefix(), "capture-pane", "-p", "-J", "-S", "-50", "-t", sessionName], {
        encoding: "utf8",
        maxBuffer: 65_536,
      });
      if (scroll.includes("claude resume session-real-456")) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(scroll).toContain("[citadel] Agent exited.");
    expect(scroll).toContain("claude resume session-real-456");
    expect(scroll).not.toContain("<sessionId>");
  }, 10_000);
});

describe("sweepLegacyAgentSentinels", () => {
  it("removes old citadel-agent-* files but keeps fresh ones (age filter)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sweep-"));
    dirs.push(tmpDir);
    const markerPath = path.join(tmpDir, ".marker");

    const oldLive = path.join(tmpDir, "citadel-agent-session_old.live");
    const oldExit = path.join(tmpDir, "citadel-agent-session_old.exit");
    const fresh = path.join(tmpDir, "citadel-agent-session_fresh.live");
    fs.writeFileSync(oldLive, "");
    fs.writeFileSync(oldExit, "0");
    fs.writeFileSync(fresh, "");
    const now = Date.now();
    const dayAgo = (now - 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldLive, dayAgo, dayAgo);
    fs.utimesSync(oldExit, dayAgo, dayAgo);

    const result = sweepLegacyAgentSentinels({ tmpDir, markerPath, maxAgeMs: 60 * 60 * 1000 });
    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.skipped).toBeNull();
    expect(fs.existsSync(oldLive)).toBe(false);
    expect(fs.existsSync(oldExit)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  it("is a no-op when the marker exists", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sweep-marker-"));
    dirs.push(tmpDir);
    const markerPath = path.join(tmpDir, ".marker");
    fs.writeFileSync(markerPath, "x");
    const oldLive = path.join(tmpDir, "citadel-agent-session.live");
    fs.writeFileSync(oldLive, "");
    fs.utimesSync(oldLive, 1, 1);

    const result = sweepLegacyAgentSentinels({ tmpDir, markerPath });
    expect(result).toEqual({ scanned: 0, removed: 0, skipped: "marker" });
    expect(fs.existsSync(oldLive)).toBe(true);
  });

  it("bails when count exceeds the safeguard", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sweep-safeguard-"));
    dirs.push(tmpDir);
    const markerPath = path.join(tmpDir, ".marker");
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(tmpDir, `citadel-agent-s${i}.live`), "");
    }
    const result = sweepLegacyAgentSentinels({ tmpDir, markerPath, safeguardCount: 2 });
    expect(result.skipped).toBe("safeguard");
    expect(result.scanned).toBe(5);
    expect(result.removed).toBe(0);
    // Marker NOT written when safeguard tripped.
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
