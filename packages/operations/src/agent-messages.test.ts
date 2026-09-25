import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("sendAgentMessage", () => {
  it("rejects transcript/message calls for unknown sessions", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);

    expect(service.readAgentTranscript({ sessionId: "sess_missing" })).toEqual({
      ok: false,
      error: "session_not_found",
    });
    expect(await service.sendAgentMessage({ sessionId: "sess_missing", message: "hi" })).toEqual({
      ok: false,
      error: "session_not_found",
    });
  });

  it("submits follow-up messages to an idle Codex TUI when the live foreground is still the runtime", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "idle-codex-send", source: "scratch" });
    const scriptPath = path.join(fixture.dir, "fake-codex.js");
    fs.writeFileSync(
      scriptPath,
      [
        "process.stdin.setEncoding('utf8');",
        "let buf = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buf += chunk;",
        "  for (;;) {",
        "    const idx = buf.indexOf('\\n');",
        "    if (idx < 0) break;",
        "    const line = buf.slice(0, idx);",
        "    buf = buf.slice(idx + 1);",
        "    process.stdout.write(`ECHO:${line}\\n`);",
        "  }",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "codex" },
      { command: "node", args: [scriptPath], displayName: "Fake Codex", sessionIdArg: "--session-id" },
    );
    try {
      store.updateSessionStatus(session.id, {
        status: "idle",
        statusReason: "pane:codex:stable_timeout",
        lastStatusAt: new Date().toISOString(),
      });
      const sendResult = await service.sendAgentMessage({ sessionId: session.id, message: "continue please" });
      expect(sendResult).toMatchObject({ ok: true, sessionId: session.id });

      const deadline = Date.now() + 3000;
      let transcript = service.readAgentTranscript({ sessionId: session.id, lines: 50, maxChars: 4000 });
      while (Date.now() < deadline) {
        transcript = service.readAgentTranscript({ sessionId: session.id, lines: 50, maxChars: 4000 });
        if (transcript.ok && transcript.text.includes("ECHO:continue please")) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      expect(transcript.ok).toBe(true);
      if (transcript.ok) expect(transcript.text).toContain("ECHO:continue please");
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  }, 20_000);
});

function makeService(store: SqliteStore) {
  return new OperationService(store, {
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  });
}

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-agent-messages-"));
  dirs.push(dir);
  const remotePath = path.join(dir, "remote.git");
  const repoPath = path.join(dir, "repo");
  run("git", ["init", "--bare", remotePath], dir);
  run("git", ["clone", remotePath, repoPath], dir);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  run("git", ["add", "README.md"], repoPath);
  run("git", ["commit", "-m", "initial"], repoPath);
  run("git", ["branch", "-M", "main"], repoPath);
  run("git", ["push", "-u", "origin", "main"], repoPath);
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoPath);
  return { dir, repoPath };
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
