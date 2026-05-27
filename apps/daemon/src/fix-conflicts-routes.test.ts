import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitRepo as createGitRepoBase,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_AUTO_RECOVERY_DISABLED = "1";

const createFixture = () => createFixtureBase(dirs);
const createGitRepo = (dir: string) => createGitRepoBase(dir);

describe("POST /api/workspaces/:id/fix-conflicts", () => {
  it("launches a Fix-conflicts agent with the default prompt and emits agent.fix-conflicts.launched", async () => {
    const fixture = createFixture();
    // Non-shell runtime required: the route refuses to paste the multi-line
    // fix-conflicts prompt into a bash pane (which would execute it line by
    // line as shell commands). Stub a no-op claude-code runtime alongside
    // shell so the route picks it for the spawn. promptArg embeds the
    // prompt as a CLI flag, so createAgentSession skips the submitPrompt
    // key-paste path (15s ready-wait) and the test stays fast.
    fixture.config.runtimes = [
      { id: "shell", displayName: "Shell", command: "bash", args: ["-l"] },
      { id: "claude-code", displayName: "Claude Code", command: "sleep", args: ["30"], promptArg: "--prompt" },
    ];
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_fc",
      name: "FC Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_fc",
      repoId: "repo_fc",
      name: "FC Workspace",
      path: git.repoPath,
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      // No hook file → default prompt; both POSTs accepted (no 409 / dedupe by design).
      const first = await postJson<{
        session: { id: string; displayName: string; workspaceId: string };
        promptSource: string;
        diagnostic: string | null;
      }>(`${baseUrl}/api/workspaces/ws_fc/fix-conflicts`, {});
      expect(first.session.displayName).toBe("Fix conflicts");
      expect(first.session.workspaceId).toBe("ws_fc");
      expect(first.promptSource).toBe("default");
      expect(first.diagnostic).toBeNull();

      const second = await postJson<{ session: { id: string } }>(`${baseUrl}/api/workspaces/ws_fc/fix-conflicts`, {});
      // Distinct session IDs prove "always launch new" — no 409 deduplication.
      expect(second.session.id).not.toBe(first.session.id);

      // Activity log records source=user for the operator-triggered launch.
      const fixActivities = fixture.store
        .listActivity("ws_fc")
        .filter((event) => event.message?.includes("Fix conflicts"));
      expect(fixActivities.length).toBeGreaterThanOrEqual(2);
      for (const event of fixActivities) expect(event.source).toBe("user");

      // The plan calls for a distinct activity event type so the activity log
      // can filter fix-conflicts launches from generic agent.started events.
      const launchEvents = fixture.store
        .listActivity("ws_fc")
        .filter((event) => event.type === "agent.fix-conflicts.launched");
      expect(launchEvents.length).toBeGreaterThanOrEqual(2);
      for (const event of launchEvents) expect(event.source).toBe("user");
    } finally {
      await closeServer(server);
    }
  }, 20_000);

  it("selects a non-shell runtime even when it has no promptArg (claude-code default)", async () => {
    // Regression: the route previously required runtime.promptArg, which
    // meant the default claude-code runtime (no promptArg by design — `-p`
    // is non-interactive print mode) always 404'd as runtime_not_found.
    // The real invariant is "not a shell" (so multi-line text isn't
    // executed by bash); createAgentSession pastes the prompt into the
    // agent TUI when promptArg is absent.
    const fixture = createFixture();
    fixture.config.runtimes = [
      { id: "shell", displayName: "Shell", command: "bash", args: ["-l"] },
      // Mirror the real built-in: no promptArg. Use a quick-running command
      // so createAgentSession's submitPrompt waits a bounded time before
      // returning — the route still returns 202 from the selection path,
      // which is all this test exercises.
      { id: "claude-code", displayName: "Claude Code", command: "sleep", args: ["30"] },
    ];
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_nopromptarg",
      name: "No PromptArg Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_nopromptarg",
      repoId: "repo_nopromptarg",
      name: "No PromptArg Workspace",
      path: git.repoPath,
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_nopromptarg/fix-conflicts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // The selection logic must accept the non-shell claude-code runtime.
      // The eventual outcome may be 202 (selection + spawn succeeded, with
      // a best-effort submitPrompt) or 500 (submitPrompt timed out because
      // `sleep` never paints a TUI prompt). Either way it must NOT be the
      // old 404 runtime_not_found that this fix is regression-testing.
      expect(response.status).not.toBe(404);
      if (response.status === 404) {
        const body = (await response.json()) as { error: string };
        expect(body.error).not.toBe("runtime_not_found");
      }
    } finally {
      await closeServer(server);
    }
  }, 30_000);

  it("returns 404 runtime_not_found when the only configured runtime is shell", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_shell",
      name: "Shell Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_shell",
      repoId: "repo_shell",
      name: "Shell Workspace",
      path: git.repoPath,
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    // createFixture defaults to a shell-only runtime list. Without a
    // non-shell runtime, fix-conflicts must refuse so the multi-line prompt
    // doesn't get pasted into a bash pane and executed as commands.
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_shell/fix-conflicts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("runtime_not_found");
    } finally {
      await closeServer(server);
    }
  });

  it("returns 400 runtime_must_be_agent when the request explicitly asks for the shell runtime", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.config.runtimes = [
      { id: "shell", displayName: "Shell", command: "bash", args: ["-l"] },
      { id: "claude-code", displayName: "Claude Code", command: "echo", args: [] },
    ];
    fixture.store.insertRepo({
      id: "repo_shellexp",
      name: "Shell-Explicit Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_shellexp",
      repoId: "repo_shellexp",
      name: "Shell-Explicit Workspace",
      path: git.repoPath,
      branch: "feature",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_shellexp/fix-conflicts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeId: "shell" }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("runtime_must_be_agent");
    } finally {
      await closeServer(server);
    }
  });

  it("returns 404 workspace_not_found when the workspace does not exist", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_missing/fix-conflicts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("workspace_not_found");
    } finally {
      await closeServer(server);
    }
  });
});
