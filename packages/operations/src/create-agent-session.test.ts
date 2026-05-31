import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createAgentSession session-id wiring", () => {
  it("mints a UUID, injects sessionIdArg, persists runtimeSessionId on the row", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "sid-create", source: "scratch" });

    const scriptPath = writeLongRunningNodeScript(fixture.dir, "sid-create-runtime.js");
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "claude-code" },
      { command: "node", args: [scriptPath], displayName: "Test", sessionIdArg: "--session-id" },
    );
    try {
      expect(session.runtimeSessionId).toMatch(UUID_V4);
      const row = store.listSessions(created.workspaceId).find((s) => s.id === session.id);
      expect(row?.runtimeSessionId).toBe(session.runtimeSessionId);
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  }, 15_000);

  it("uses --resume + the provided UUID when input.resumeRuntimeSessionId is set", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "sid-resume", source: "scratch" });

    const existing = randomUUID();
    const scriptPath = writeLongRunningNodeScript(fixture.dir, "sid-resume-runtime.js");
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "claude-code", resumeRuntimeSessionId: existing },
      {
        command: "node",
        args: [scriptPath],
        displayName: "Test",
        sessionIdArg: "--session-id",
        resumeArg: "--resume",
      },
    );
    try {
      // The row carries the caller-supplied UUID verbatim — no fresh mint.
      expect(session.runtimeSessionId).toBe(existing);
      const row = store.listSessions(created.workspaceId).find((s) => s.id === session.id);
      expect(row?.runtimeSessionId).toBe(existing);
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  }, 15_000);

  it("leaves runtimeSessionId null for agent runtimes without sessionIdArg", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "sid-none", source: "scratch" });

    const scriptPath = writeLongRunningNodeScript(fixture.dir, "sid-none-runtime.js");
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "test-agent" },
      { command: "node", args: [scriptPath], displayName: "Test Agent" },
    );
    try {
      expect(session.runtimeSessionId ?? null).toBeNull();
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  }, 15_000);

  it("creates terminal sessions through the terminal profile without firing agent hooks", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "terminal-create", source: "scratch" });

    const session = await service.createTerminalSession({ workspaceId: created.workspaceId });
    try {
      expect(session.kind).toBe("terminal");
      expect(session.runtimeId).toBeNull();
      expect(store.listWorkspaceSessions(created.workspaceId).find((s) => s.id === session.id)).toMatchObject({
        kind: "terminal",
        runtimeId: null,
      });
      expect(store.listActivity(created.workspaceId).find((event) => event.type === "terminal.started")).toBeDefined();
      expect(store.listActivity(created.workspaceId).find((event) => event.type === "agent.started")).toBeUndefined();
    } finally {
      service.stopWorkspaceSession({ sessionId: session.id });
    }
  }, 15_000);

  it("passes Codex initial prompts as positional argv instead of pasting into the TUI", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "codex-prompt", source: "scratch" });
    const argvPath = path.join(fixture.dir, "codex-argv.json");
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(1)));`,
      "setTimeout(() => {}, 10000);",
    ].join(" ");

    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "codex", prompt: "hello codex" },
      { command: "node", args: ["-e", script], displayName: "Fake Codex", sessionIdArg: "--session-id" },
    );
    try {
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(argvPath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const argv = JSON.parse(fs.readFileSync(argvPath, "utf8")) as string[];
      expect(argv).toContain("hello codex");
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  }, 15_000);

  it("retries Codex startup when its state database is temporarily locked", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "codex-db-lock", source: "scratch" });
    const attemptsPath = path.join(fixture.dir, "attempts.txt");
    const readyPath = path.join(fixture.dir, "ready.txt");
    const scriptPath = path.join(fixture.dir, "fake-codex-lock.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
        `const readyPath = ${JSON.stringify(readyPath)};`,
        "let attempts = 0;",
        "try { attempts = Number(fs.readFileSync(attemptsPath, 'utf8')) || 0; } catch {}",
        "attempts += 1;",
        "fs.writeFileSync(attemptsPath, String(attempts));",
        "if (attempts === 1) {",
        "  console.error('failed to initialize state runtime at /home/test/.codex: error returned from database: (code: 5) database is locked');",
        "  process.exit(1);",
        "}",
        "fs.writeFileSync(readyPath, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );

    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "codex" },
      { command: "node", args: [scriptPath], displayName: "Fake Codex", sessionIdArg: "--session-id" },
    );
    try {
      expect(fs.readFileSync(attemptsPath, "utf8")).toBe("2");
      expect(fs.readFileSync(readyPath, "utf8")).toBe("ready");
      expect(session.runtimeSessionId).toMatch(UUID_V4);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-cas-"));
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

function writeLongRunningNodeScript(dir: string, name: string) {
  const scriptPath = path.join(dir, name);
  fs.writeFileSync(scriptPath, "setInterval(() => {}, 1000);\n");
  return scriptPath;
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
