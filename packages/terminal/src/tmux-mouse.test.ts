import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { afterEach, describe, expect, it } from "vitest";
import { attachTmuxPty, ensureTmuxSession, killTmuxSession, tmuxPrefix } from "./index.js";

const dirs: string[] = [];
const sessions: Array<{ sessionName: string; socketName: string }> = [];
const ptys: IPty[] = [];

afterEach(() => {
  for (const pty of ptys.splice(0)) {
    try {
      pty.kill("SIGHUP");
    } catch {
      /* already closed */
    }
  }
  for (const { sessionName, socketName } of sessions.splice(0)) {
    killTmuxSession(sessionName, socketName);
    try {
      execFileSync("tmux", [...tmuxPrefix(socketName), "kill-server"], { stdio: "ignore" });
    } catch {
      /* server already gone */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("tmux mouse handling", () => {
  it("can enable mouse mode for a single attached session without changing the global default", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-terminal-mouse-"));
    dirs.push(cwd);
    const suffix = `${process.pid}_${Date.now().toString(36)}`;
    const sessionName = `citadel_mouse_${suffix}`;
    const socketName = `citadel-mouse-${suffix}`;
    sessions.push({ sessionName, socketName });
    await ensureTmuxSession({ sessionName, cwd, socketName });

    const pty = attachTmuxPty(sessionName, 80, 24, socketName, { enableTmuxMouse: true });
    ptys.push(pty);

    const globalMouse = execTmux(socketName, ["show-options", "-g", "mouse"]);
    const sessionMouse = execTmux(socketName, ["show-options", "-t", sessionName, "mouse"]);
    expect(globalMouse).toBe("mouse off");
    expect(sessionMouse).toBe("mouse on");
  });
});

function execTmux(socketName: string, args: string[]): string {
  return execFileSync("tmux", [...tmuxPrefix(socketName), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
