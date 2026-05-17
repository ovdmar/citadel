import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureTmux, ensureTmuxSession, killTmuxSession, resizePane, sendKeys, tmuxSessionExists } from "./index.js";

const sessions: string[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) killTmuxSession(session);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("tmux terminal gateway helpers", () => {
  it("creates durable sessions, sends input, captures output, resizes, and cleans up", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-"));
    dirs.push(cwd);
    const sessionName = `citadel_test_${Date.now().toString(36)}`;
    sessions.push(sessionName);

    const session = await ensureTmuxSession({
      sessionName,
      cwd,
      command: "bash",
      args: ["--noprofile", "--norc"],
    });

    expect(session.tmuxSessionName).toBe(sessionName);
    expect(session.tmuxSessionId).toMatch(/^\$/);
    expect(tmuxSessionExists(sessionName)).toBe(true);

    sendKeys(sessionName, "printf terminal-smoke");
    sendKeys(sessionName, "\n");
    await waitForCapture(sessionName, "terminal-smoke");

    resizePane(sessionName, 100, 30);
    const captured = captureTmux(sessionName, 20);
    expect(captured).toContain("terminal-smoke");

    killTmuxSession(sessionName);
    expect(tmuxSessionExists(sessionName)).toBe(false);
  });
});

async function waitForCapture(sessionName: string, expected: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = captureTmux(sessionName, 20);
    if (output.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}
