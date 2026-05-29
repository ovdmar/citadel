import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LaunchAgentInputSchema } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { agentLiveSentinelPath, killTmuxSession, tmuxSessionExists } from "@citadel/terminal";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];
const tmuxSessions: string[] = [];

afterEach(() => {
  for (const session of tmuxSessions.splice(0)) {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OperationService", () => {
  it("registers repos, creates workspaces, runs setup hooks, and blocks dirty removal", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const hookOutput = path.join(fixture.dir, "setup-hook.json");
    const service = new OperationService(store, {
      hooks: [
        {
          id: "setup",
          kind: "command",
          event: "workspace.setup",
          command: "node",
          args: ["-e", `process.stdin.pipe(require('fs').createWriteStream(${JSON.stringify(hookOutput)}))`],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: ["setup"], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Smoke Task", source: "scratch" });
    const workspace = store.listWorkspaces()[0];

    expect(result.workspaceId).toBe(workspace?.id);
    expect(workspace?.lifecycle).toBe("ready");
    expect(fs.existsSync(path.join(workspace?.path ?? "", ".git"))).toBe(true);
    expect(fs.readFileSync(hookOutput, "utf8")).toContain("workspace.setup");

    fs.writeFileSync(path.join(workspace?.path ?? "", "dirty.txt"), "dirty\n");
    const removeResult = await service.removeWorkspace({ workspaceId: result.workspaceId });

    expect(removeResult).toMatchObject({ removed: false, archived: false, dirty: true });
    expect(store.listOperations()[0]?.status).toBe("failed");
  });

  it("archives metadata without deleting dirty worktrees", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Archive Task", source: "scratch" });
    const workspace = store.listWorkspaces().find((w) => w.id === created.workspaceId);
    fs.writeFileSync(path.join(workspace?.path ?? "", "dirty.txt"), "dirty\n");

    const archived = await service.removeWorkspace({ workspaceId: created.workspaceId, archiveOnly: true });

    expect(archived).toMatchObject({ removed: false, archived: true, dirty: true });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    // The auto-created root workspace stays; only the worktree workspace is archived.
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);
  });

  it("removes repository tracking while preserving worktrees by default", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Repo Remove", source: "scratch" });
    const workspace = store.listWorkspaces().find((w) => w.id === created.workspaceId);

    const removed = await service.removeRepo({ repoId: repo.id });

    // archivedWorkspaces includes both the auto-created root and the explicit worktree.
    expect(removed).toMatchObject({ removed: true, archivedWorkspaces: 2, cleanupWorktrees: false });
    expect(store.listRepos()).toEqual([]);
    expect(store.listWorkspaces()).toEqual([]);
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    expect(store.listActivity().find((event) => event.type === "repo.removed")).toMatchObject({
      message: expect.stringContaining("preserved worktrees"),
    });
  });

  it("blocks repository removal with active sessions until force is explicit", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Active Repo", source: "scratch" });
    store.insertSession({
      id: "sess_active",
      workspaceId: created.workspaceId,
      runtimeId: "shell",
      displayName: "Shell",
      status: "running",
      statusReason: null,
      lastStatusAt: "2026-05-17T00:00:00.000Z",
      lastOutputAt: null,
      endedAt: null,
      exitCode: null,
      transport: "disconnected",
      tmuxSessionName: null,
      tmuxSessionId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });

    const blocked = await service.removeRepo({ repoId: repo.id });
    expect(blocked).toMatchObject({ removed: false, activeSessions: 1 });
    expect(store.listRepos()).toHaveLength(1);

    const forced = await service.removeRepo({ repoId: repo.id, force: true });
    expect(forced).toMatchObject({ removed: true, activeSessions: 1 });
    expect(store.listRepos()).toEqual([]);
  });

  it("marks workspace creation failed when a blocking setup hook fails", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "setup-fails",
          kind: "command",
          event: "workspace.setup",
          command: "node",
          args: ["-e", "process.stderr.write('setup denied'); process.exit(12)"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: ["setup-fails"], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Blocked Setup", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);

    expect(workspace?.lifecycle).toBe("failed");
    expect(store.listOperations().find((operation) => operation.id === result.operationId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("setup denied"),
    });
  });

  it("blocks destructive cleanup on teardown failure unless force is explicit", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "teardown-fails",
          kind: "command",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", "process.stderr.write('teardown denied'); process.exit(13)"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: ["teardown-fails"] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Teardown Policy", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);

    const blocked = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(blocked).toMatchObject({ removed: false, archived: false, dirty: false });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(true);
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(1);

    const forced = await service.removeWorkspace({ workspaceId: created.workspaceId, force: true });
    expect(forced).toMatchObject({ removed: true, archived: false, dirty: false });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(false);
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);
  });

  it("allows successful teardown hooks with unstructured stdout", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "teardown-logs",
          kind: "command",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", "process.stdout.write('No recorded dev stack pid file')"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: ["teardown-logs"] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Teardown Logs", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);

    const removed = await service.removeWorkspace({ workspaceId: created.workspaceId });

    expect(removed).toMatchObject({ removed: true, archived: false, dirty: false });
    expect(fs.existsSync(workspace?.path ?? "")).toBe(false);
    expect(store.listOperations().find((operation) => operation.id === removed.operationId)).toMatchObject({
      status: "succeeded",
    });
  });

  it("skips teardown hooks and prunes when the worktree directory is already gone", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "teardown-fails",
          kind: "command",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", "process.stderr.write('teardown denied'); process.exit(13)"],
          blocking: true,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: ["teardown-fails"] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Stale Worktree", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    expect(workspace).toBeDefined();

    // Simulate the worktree directory disappearing out from under citadel
    // (e.g. it was removed manually, or by a parallel `git worktree remove`).
    fs.rmSync(workspace?.path ?? "", { recursive: true, force: true });

    const removed = await service.removeWorkspace({ workspaceId: created.workspaceId });
    expect(removed).toMatchObject({ removed: true, archived: false });
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);

    const operation = store.listOperations().find((op) => op.id === removed.operationId);
    expect(operation?.status).toBe("succeeded");
  });

  it("force-removes the directory when git no longer tracks it as a worktree", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "Detached Worktree", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    expect(workspace).toBeDefined();

    // Reproduce the broken state: leftover directory on disk with a real
    // `.git` dir inside (so the dirty-status probe sees a valid repo), but
    // the parent repo's worktree refs have been pruned — so
    // `git worktree remove` errors with "is not a working tree". This
    // matches what we observed in the wild after a partial cleanup.
    const workspacePath = workspace?.path ?? "";
    fs.rmSync(workspacePath, { recursive: true, force: true });
    execFileSync("git", ["worktree", "prune"], { cwd: fixture.repoPath, stdio: "pipe" });
    fs.mkdirSync(workspacePath, { recursive: true });
    execFileSync("git", ["init", "--quiet"], { cwd: workspacePath, stdio: "pipe" });
    fs.writeFileSync(path.join(workspacePath, "leftover.txt"), "stale\n");

    // Force-remove so the bare leftover dir doesn't trip the dirty-status
    // probe (which expects a real git working tree). The cockpit calls this
    // path when the user clicks "force remove".
    const removed = await service.removeWorkspace({ workspaceId: created.workspaceId, force: true });
    expect(removed).toMatchObject({ removed: true, archived: false });
    expect(fs.existsSync(workspacePath)).toBe(false);
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);

    const operation = store.listOperations().find((op) => op.id === removed.operationId);
    expect(operation?.status).toBe("succeeded");
  });

  it("records notification hook failures without blocking workspace readiness", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "notify-fails",
          kind: "command",
          event: "workspace.created",
          command: "node",
          args: ["-e", "process.stderr.write('notify denied'); process.exit(14)"],
          blocking: false,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Notify Policy", source: "scratch" });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);

    expect(workspace?.lifecycle).toBe("ready");
    expect(store.listActivity().find((event) => event.type === "hook.workspace.created.failed")).toMatchObject({
      source: "hook",
      message: expect.stringContaining("notify denied"),
    });
  });

  it("cancels a running operation and rejects retry when not retriable", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    await service.createWorkspace({ repoId: repo.id, name: "cancel-target", source: "scratch" });
    const running = store.listOperations().find((operation) => operation.status === "running");
    expect(running).toBeUndefined();
    // Seed a fake queued operation to cancel.
    store.upsertOperation({
      id: "op_to_cancel",
      type: "workspace.action.custom",
      status: "queued",
      repoId: repo.id,
      workspaceId: null,
      progress: 0,
      message: "Waiting",
      error: null,
      logs: [],
      retriable: false,
      retryInput: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = service.cancelOperation("op_to_cancel");
    expect(result.cancelled).toBe(true);
    expect(store.findOperation("op_to_cancel")?.status).toBe("cancelled");
    const retry = await service.retryOperation("op_to_cancel");
    expect(retry.retried).toBe(false);
    expect(retry.reason).toBe("not_retriable");
  });

  it("reads bounded transcript and submits follow-up messages into the backing tmux pane", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "mcp-output", source: "scratch" });
    // Use bash with `read` to verify Enter is actually submitted by sendAgentMessage.
    const session = await service.createAgentSession(
      {
        workspaceId: created.workspaceId,
        runtimeId: "shell",
        prompt: undefined,
      },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    try {
      // Drive the session into a read loop the same way Claude Code waits for
      // chat input. If our follow-up does not press Enter, the loop never
      // resolves and the assertion below times out.
      execFileSync("tmux", [
        "send-keys",
        "-t",
        session.tmuxSessionName ?? "",
        "while read line; do printf 'ECHO:%s\\n' \"$line\"; done",
        "Enter",
      ]);
      const sendResult = await service.sendAgentMessage({ sessionId: session.id, message: "hello world" });
      expect(sendResult).toMatchObject({ ok: true, sessionId: session.id });
      // Poll the transcript until we see the echoed line.
      const deadline = Date.now() + 3000;
      let transcript = service.readAgentTranscript({ sessionId: session.id, lines: 50, maxChars: 4000 });
      while (Date.now() < deadline) {
        transcript = service.readAgentTranscript({ sessionId: session.id, lines: 50, maxChars: 4000 });
        if (transcript.ok && transcript.text.includes("ECHO:hello world")) break;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      expect(transcript.ok).toBe(true);
      if (transcript.ok) {
        expect(transcript.text).toContain("ECHO:hello world");
        expect(transcript.charCount).toBeLessThanOrEqual(4000);
      }
      expect(store.listActivity().some((event) => event.type === "agent.message")).toBe(true);
    } finally {
      service.stopAgentSession({ sessionId: session.id });
    }
  });

  it("stops a session, removes it from the cockpit, and records activity", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "stop-target", source: "scratch" });
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "shell" },
      { command: "bash", args: ["-l"], displayName: "Shell" },
    );
    expect(session.status).toBe("running");
    const result = service.stopAgentSession({ sessionId: session.id });
    expect(result.stopped).toBe(true);
    expect(store.listSessions().find((candidate) => candidate.id === session.id)).toBeUndefined();
    expect(store.listActivity().find((event) => event.type === "agent.stopped")).toBeTruthy();
  });

  it("createWorkspace falls back to baseBranch when origin lacks the named branch", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({
      repoId: repo.id,
      name: "brand-new-branch",
      source: "scratch",
      existingBranch: "fb-not-on-remote",
    });
    const workspace = store.listWorkspaces().find((w) => w.id === created.workspaceId);
    expect(workspace?.lifecycle).toBe("ready");
    expect(workspace?.branch).toBe("fb-not-on-remote");
    const branchOnDisk = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace?.path ?? "",
      encoding: "utf8",
    }).trim();
    expect(branchOnDisk).toBe("fb-not-on-remote");
  });

  it("removeWorkspace (non-archive) frees the (repo,name) slot for reuse", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const first = await service.createWorkspace({ repoId: repo.id, name: "reusable", source: "scratch" });
    const removed = await service.removeWorkspace({ workspaceId: first.workspaceId });
    expect(removed).toMatchObject({ removed: true, archived: false });
    // Row must be hard-deleted (not archived) so the UNIQUE(repo_id, name) index lets us recreate.
    expect(store.listArchivedWorkspaces().find((w) => w.id === first.workspaceId)).toBeUndefined();
    expect(store.listWorkspaces().find((w) => w.id === first.workspaceId)).toBeUndefined();
    // Re-creating under the same name no longer trips the unique index. Pass a
    // distinct branch via existingBranch so this assertion isolates the DB slot
    // contract (the git-side branch leftover is intentionally not in scope).
    const second = await service.createWorkspace({
      repoId: repo.id,
      name: "reusable",
      source: "imported",
      existingBranch: "reusable-take-2",
    });
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(store.listWorkspaces().find((w) => w.id === second.workspaceId)?.lifecycle).toBe("ready");
  });

  it("creates a workspace from an existing branch", async () => {
    const fixture = createGitFixture();
    // Seed an additional branch on the origin remote.
    run("git", ["checkout", "-b", "feature/import-me"], fixture.repoPath);
    fs.writeFileSync(path.join(fixture.repoPath, "imported.txt"), "imported\n");
    run("git", ["add", "imported.txt"], fixture.repoPath);
    run("git", ["commit", "-m", "feature commit"], fixture.repoPath);
    run("git", ["push", "-u", "origin", "feature/import-me"], fixture.repoPath);
    run("git", ["checkout", "main"], fixture.repoPath);
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({
      repoId: repo.id,
      name: "imported-ws",
      source: "imported",
      existingBranch: "feature/import-me",
    });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === created.workspaceId);
    expect(workspace?.lifecycle).toBe("ready");
    expect(workspace?.branch).toBe("feature/import-me");
    expect(fs.existsSync(path.join(workspace?.path ?? "", "imported.txt"))).toBe(true);
  });

  it("reconcile archives repos whose rootPath is gone and removes orphan sessions", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({
      repoId: repo.id,
      name: "reaper-target",
      source: "scratch",
    });
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "shell" },
      { command: "bash", args: ["-l"], displayName: "Shell" },
    );
    // Kill the underlying tmux session out-of-band and remove the repo from disk.
    if (session.tmuxSessionName) execFileSync("tmux", ["kill-session", "-t", session.tmuxSessionName]);
    fs.rmSync(fixture.repoPath, { recursive: true, force: true });
    const result = service.reconcile();
    expect(result.sessions).toBeGreaterThan(0);
    expect(result.repos).toBeGreaterThan(0);
    const reconciledRepo = store.listRepos().find((candidate) => candidate.id === repo.id);
    expect(reconciledRepo).toBeUndefined();
  });

  // Shell-first replacement of the legacy "reconcile flips to stopped" test.
  // The legacy assertion was: wrapper-`.live` sentinel removed → reconcile
  // flips status='stopped'. New behavior (shell-first lifecycle): the
  // pane's foreground command IS the source of truth. For a `shell`
  // runtime session, the pane PID is bash itself (no separate agent); the
  // reconciler leaves it alone because the shell IS the runtime. The
  // operator-visible "stopped" state is reserved for explicit Stop button
  // presses (which delete the row entirely). The new regression-pin tests
  // for non-shell agent runtimes live in status-monitor.test.ts.
  it("reconcile no longer mass-flips shell-runtime sessions to 'stopped' (shell-first invariant)", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const created = await service.createWorkspace({ repoId: repo.id, name: "agent-exit-target", source: "scratch" });
    const session = await service.createAgentSession(
      { workspaceId: created.workspaceId, runtimeId: "shell" },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );

    try {
      expect(session.tmuxSessionName).toBeTruthy();
      const sessionName = session.tmuxSessionName as string;
      // Legacy sentinel removal is now a no-op — the wrapper is gone and
      // reconcile doesn't read /tmp sentinels at all (it reads the pane's
      // foreground command via tmux). For a shell runtime session, the
      // pane foreground IS bash, which is the runtime binary — reconcile
      // leaves it alone.
      fs.rmSync(agentLiveSentinelPath(sessionName), { force: true });

      service.reconcile();

      const reconciled = store.listSessions().find((candidate) => candidate.id === session.id);
      // Shell-runtime session: status preserved (NOT flipped to stopped).
      expect(reconciled?.status).not.toBe("stopped");
      // Pane is still alive — the user can keep working in the shell.
      expect(tmuxSessionExists(sessionName)).toBe(true);
    } finally {
      if (session.tmuxSessionName) killTmuxSession(session.tmuxSessionName);
    }
  });

  it("records hook-provided workspace links and actions", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [
        {
          id: "workspace-links",
          kind: "command",
          event: "workspace.created",
          command: "node",
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({links:[{label:'Preview',url:'https://example.test/preview',kind:'preview'}],actions:[{id:'redeploy',label:'Redeploy',url:'https://example.test/deploy'}]}))",
          ],
          blocking: false,
        },
      ],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });

    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const result = await service.createWorkspace({ repoId: repo.id, name: "Hook Surface", source: "scratch" });

    expect(
      store.listActivity(result.workspaceId).find((event) => event.type === "hook.workspace.created"),
    ).toMatchObject({
      hookOutput: {
        links: [{ label: "Preview", kind: "preview" }],
        actions: [{ id: "redeploy", label: "Redeploy" }],
      },
    });
  });

  describe("launchAgent input validation", () => {
    it("requires exactly one of repoId or repoName", () => {
      expect(() => LaunchAgentInputSchema.parse({ prompt: "hello" })).toThrow(/repoId or repoName/);
      expect(() => LaunchAgentInputSchema.parse({ prompt: "hello", repoId: "repo_test", repoName: "fixture" })).toThrow(
        /repoId or repoName/,
      );
    });

    it("requires a non-empty prompt", () => {
      expect(() => LaunchAgentInputSchema.parse({ repoId: "repo_test" })).toThrow();
      expect(() => LaunchAgentInputSchema.parse({ repoId: "repo_test", prompt: "" })).toThrow();
    });

    it("defaults runtimeId to claude-code", () => {
      const parsed = LaunchAgentInputSchema.parse({ repoName: "fixture", prompt: "do a thing" });
      expect(parsed.runtimeId).toBe("claude-code");
    });
  });

  it("launchAgent bundles workspace creation and agent session start in one call", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath, name: "launch-fixture" });

    const result = await service.launchAgent(
      { repoName: "launch-fixture", prompt: "describe the repo in one sentence", runtimeId: "shell" },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    const session = store.listSessions().find((candidate) => candidate.id === result.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);

    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBeTruthy();
    expect(result.workspaceId).toBeTruthy();
    expect(result.branchName).toBeTruthy();
    expect(result.workspacePath).toContain(fixture.dir);

    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);
    expect(workspace?.lifecycle).toBe("ready");
    expect(workspace?.source).toBe("scratch");
    expect(workspace?.repoId).toBe(repo.id);
    expect(session?.runtimeId).toBe("shell");
    expect(session?.workspaceId).toBe(result.workspaceId);
    // Display name is derived from the prompt's first ~40 chars when caller didn't pass one.
    expect(session?.displayName).toBe("describe the repo in one sentence");
  });

  it("launchAgent resolves repo by id and assigns the workspace to the given namespace", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = service.registerRepo({ rootPath: fixture.repoPath });
    const { namespace } = service.createNamespace({ name: "team-a" });

    const result = await service.launchAgent(
      {
        repoId: repo.id,
        prompt: "investigate the failing build",
        runtimeId: "shell",
        namespaceId: namespace.id,
        workspaceName: "investigate-build",
        displayName: "Build Triage",
      },
      { command: "bash", args: ["--noprofile", "--norc"], displayName: "Shell" },
    );
    const session = store.listSessions().find((candidate) => candidate.id === result.sessionId);
    if (session?.tmuxSessionName) tmuxSessions.push(session.tmuxSessionName);

    expect(result.error).toBeUndefined();
    expect(session?.displayName).toBe("Build Triage");
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);
    expect(workspace?.name).toBe("investigate-build");
    expect(workspace?.namespaceId).toBe(namespace.id);
  });

  it("launchAgent throws when the named repo doesn't exist (no workspace gets created)", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const service = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    service.registerRepo({ rootPath: fixture.repoPath, name: "launch-fixture" });

    await expect(
      service.launchAgent(
        { repoName: "does-not-exist", prompt: "x", runtimeId: "shell" },
        { command: "bash", args: [], displayName: "Shell" },
      ),
    ).rejects.toThrow(/Unknown repo/);
    expect(store.listWorkspaces().filter((w) => w.kind !== "root")).toHaveLength(0);
  });
});
function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-ops-"));
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
