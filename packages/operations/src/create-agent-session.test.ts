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

    // `true` ignores any args, so `true --session-id <uuid>` exits cleanly.
    // The tmux session still gets created — that's what we assert against.
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "claude-code" },
      { command: "true", args: [], displayName: "Test", sessionIdArg: "--session-id" },
    );
    try {
      expect(session.runtimeSessionId).toMatch(UUID_V4);
      const row = store.listSessions(created.workspaceId).find((s) => s.id === session.id);
      expect(row?.runtimeSessionId).toBe(session.runtimeSessionId);
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  });

  it("uses --resume + the provided UUID when input.resumeRuntimeSessionId is set", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "sid-resume", source: "scratch" });

    const existing = randomUUID();
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "claude-code", resumeRuntimeSessionId: existing },
      {
        command: "true",
        args: [],
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
  });

  it("leaves runtimeSessionId null for runtimes without sessionIdArg (e.g. plain shell)", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = makeService(store);
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "sid-none", source: "scratch" });

    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "shell" },
      { command: "true", args: [], displayName: "Shell" },
    );
    try {
      expect(session.runtimeSessionId ?? null).toBeNull();
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  });
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

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
