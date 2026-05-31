import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookConfig } from "@citadel/config";
import type { Repo, Workspace } from "@citadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNotificationHooks, runWorkspaceHooks } from "./hooks-runner.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-runner-"));
  dirs.push(dir);
  return dir;
}

function writeFileHook(workspacePath: string, event: string, name: string, body: string, executable = true): string {
  const eventDir = path.join(workspacePath, ".citadel", "hooks", event);
  fs.mkdirSync(eventDir, { recursive: true });
  const file = path.join(eventDir, name);
  fs.writeFileSync(file, body);
  if (executable) fs.chmodSync(file, 0o755);
  return file;
}

const baseWorkspace = (path: string): Workspace =>
  ({
    id: "ws_test",
    repoId: "repo_test",
    name: "ws",
    path,
    branch: "main",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    namespaceId: null,
    setupHookIds: [],
    teardownHookIds: [],
    appHookIds: [],
    actionHookIds: [],
    lifecycle: "ready",
    readiness: { state: "ok", reasons: [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }) as unknown as Workspace;

const baseRepo: Repo = {
  id: "repo_test",
  name: "repo",
  rootPath: "/tmp/repo",
  defaultBranch: "main",
  defaultRemote: "origin",
  worktreeParent: "/tmp/worktrees",
  setupHookIds: [],
  teardownHookIds: [],
  providerIds: [],
  deployHookCommand: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  archivedAt: null,
};

const baseConfig = (hooks: HookConfig[] = []) => ({
  hooks,
  commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
});

describe("runWorkspaceHooks — config + file hook ordering", () => {
  it("runs config hooks first (in hookIds order) then file hooks (lex order)", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.setup", "30-third.sh", "#!/bin/sh\nexit 0\n");
    writeFileHook(ws, "workspace.setup", "20-second.sh", "#!/bin/sh\nexit 0\n");

    const callOrder: string[] = [];
    const activity = vi.fn((type: string, _src, _msg, _r, _w, _op) => {
      if (type === "hook.workspace.setup") callOrder.push("activity");
    });
    const dispatchAgentHook = vi.fn();
    const hooks: HookConfig[] = [
      { id: "first-config", kind: "command", event: "workspace.setup", command: "true", args: [], blocking: false },
    ];

    await runWorkspaceHooks({
      config: baseConfig(hooks),
      activity,
      event: "workspace.setup",
      hookIds: ["first-config"],
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: "op_1",
      dispatchAgentHook,
    });

    // Activity should fire 3 times: config-first then file lex (20 before 30).
    expect(activity).toHaveBeenCalledTimes(3);
    const messages = activity.mock.calls.map((c) => String(c[2]));
    expect(messages[0]).toMatch(/first-config/);
    expect(messages[1]).toMatch(/20-second\.sh/);
    expect(messages[2]).toMatch(/30-third\.sh/);
  });

  it("dispatches .agent hooks via the injected dispatcher with the rendered prompt", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.setup", "notify.agent", "Notify for workspace {{workspace.id}}\n");

    const dispatchAgentHook = vi.fn().mockResolvedValue({ sessionId: "agent_session_1" });
    const activity = vi.fn();

    await runWorkspaceHooks({
      config: baseConfig(),
      activity,
      event: "workspace.setup",
      hookIds: [],
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: "op_seed",
      dispatchAgentHook,
    });

    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    const callArg = dispatchAgentHook.mock.calls[0]?.[0];
    expect(callArg.prompt).toBe("Notify for workspace ws_test\n");
    expect(callArg.operationId).toBe("op_seed");
    expect(callArg.workspace.id).toBe("ws_test");
  });

  it("dispatches .prompt hooks with event-specific payload and returns hook count", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "pr.merge", "notify.prompt", "Merge PR #{{pullRequest.number}} with {{strategy}}\n");

    const dispatchAgentHook = vi.fn().mockResolvedValue({ sessionId: "agent_session_prompt" });
    const activity = vi.fn();

    const result = await runWorkspaceHooks({
      config: baseConfig(),
      activity,
      event: "pr.merge",
      hookIds: null,
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: "op_merge",
      payload: { strategy: "squash", pullRequest: { number: 42 } },
      dispatchAgentHook,
    });

    expect(result.ran).toBe(1);
    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    expect(dispatchAgentHook.mock.calls[0]?.[0]?.prompt).toBe("Merge PR #42 with squash\n");
  });

  it("when dispatcher rejects, records hook.<event>.failed activity and continues to the next hook", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.action", "10-broken.agent", "first\n");
    writeFileHook(ws, "workspace.action", "20-followup.sh", "#!/bin/sh\nexit 0\n");

    const dispatchAgentHook = vi.fn().mockRejectedValueOnce(new Error("session launch failed"));
    const activity = vi.fn();

    await runWorkspaceHooks({
      config: baseConfig(),
      activity,
      event: "workspace.action",
      hookIds: [],
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: "op_x",
      dispatchAgentHook,
    });

    const types = activity.mock.calls.map((c) => String(c[0]));
    expect(types).toContain("hook.workspace.action.failed");
    // followup .sh should still have run after the .agent failed.
    expect(types).toContain("hook.workspace.action");
  });

  it("propagates blocking failure on .sh under workspace.setup (legacy semantics preserved)", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.setup", "bad.sh", "#!/bin/sh\nexit 1\n");
    const dispatchAgentHook = vi.fn();
    const activity = vi.fn();

    await expect(
      runWorkspaceHooks({
        config: baseConfig(),
        activity,
        event: "workspace.setup",
        hookIds: [],
        repo: baseRepo,
        workspace: baseWorkspace(ws),
        operationId: "op_setup",
        dispatchAgentHook,
      }),
    ).rejects.toThrow();
  });

  it("propagates blocking failure on .sh under pr.merge (new blocking default)", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "pr.merge", "fail.sh", "#!/bin/sh\nexit 1\n");
    const dispatchAgentHook = vi.fn();
    const activity = vi.fn();

    await expect(
      runWorkspaceHooks({
        config: baseConfig(),
        activity,
        event: "pr.merge",
        hookIds: [],
        repo: baseRepo,
        workspace: baseWorkspace(ws),
        operationId: "op_merge",
        dispatchAgentHook,
      }),
    ).rejects.toThrow();
  });

  it("records discovery diagnostics as hook.<event>.failed activity entries (does not silently skip)", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.setup", "broken.sh", "#!/bin/sh\nexit 0\n", /* executable */ false);
    const dispatchAgentHook = vi.fn();
    const activity = vi.fn();

    await runWorkspaceHooks({
      config: baseConfig(),
      activity,
      event: "workspace.setup",
      hookIds: [],
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: "op_diag",
      dispatchAgentHook,
    });

    const types = activity.mock.calls.map((c) => String(c[0]));
    expect(types).toContain("hook.workspace.setup.failed");
  });
});

describe("runNotificationHooks — file-based discovery", () => {
  it("dispatches a .agent hook on a non-agent.started notification event with rendered payload", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "workspace.created", "notify.agent", "ws={{workspace.id}} event={{event}}\n");
    const dispatchAgentHook = vi.fn().mockResolvedValue({ sessionId: "agent_session_n" });
    const activity = vi.fn();
    const workspace = baseWorkspace(ws);

    await runNotificationHooks({
      config: baseConfig(),
      activity,
      event: "workspace.created",
      repo: baseRepo,
      workspace,
      operationId: "op_create",
      payload: { repo: baseRepo, workspace },
      dispatchAgentHook,
    });

    expect(dispatchAgentHook).toHaveBeenCalledTimes(1);
    const callArg = dispatchAgentHook.mock.calls[0]?.[0];
    expect(callArg.prompt).toBe("ws=ws_test event=workspace.created\n");
    expect(callArg.operationId).toBe("op_create");
    const types = activity.mock.calls.map((c) => String(c[0]));
    expect(types).toContain("hook.workspace.created");
  });

  it("rejects .agent files under agent.started/ at discovery (would loop), accepts .sh", async () => {
    const ws = tmpWorkspace();
    writeFileHook(ws, "agent.started", "loop.agent", "would loop\n");
    writeFileHook(ws, "agent.started", "safe.sh", "#!/bin/sh\nexit 0\n");

    const dispatchAgentHook = vi.fn();
    const activity = vi.fn();

    await runNotificationHooks({
      config: baseConfig(),
      activity,
      event: "agent.started",
      repo: baseRepo,
      workspace: baseWorkspace(ws),
      operationId: null,
      payload: { repo: baseRepo, workspace: baseWorkspace(ws) },
      dispatchAgentHook,
    });

    expect(dispatchAgentHook).not.toHaveBeenCalled();
    const types = activity.mock.calls.map((c) => String(c[0]));
    expect(types).toContain("hook.agent.started"); // safe.sh fired
    expect(types).toContain("hook.agent.started.failed"); // loop.agent rejected
  });
});
