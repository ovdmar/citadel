import type { RuntimeConfig } from "@citadel/config";
import type { AgentSession, Repo, Workspace } from "@citadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { defaultPromptRuntimeId, dispatchAgentHook } from "./dispatch-agent-hook.js";

const fakeWorkspace = { id: "ws_test", path: "/tmp/ws", repoId: "repo_test" } as unknown as Workspace;
const fakeRepo = { id: "repo_test", name: "repo" } as unknown as Repo;
const fakeSession = { id: "agent_session_xyz" } as unknown as AgentSession;

const claudeRuntime: RuntimeConfig = {
  id: "claude-code",
  displayName: "Claude Code",
  command: "claude",
  args: [],
  supportsPrompt: true,
};

const codexRuntime: RuntimeConfig = {
  id: "codex",
  displayName: "Codex",
  command: "codex",
  args: [],
  supportsPrompt: true,
};

const shellRuntime: RuntimeConfig = {
  id: "shell",
  displayName: "Shell",
  command: "bash",
  args: ["-l"],
};

describe("dispatchAgentHook", () => {
  it("forwards the rendered prompt and propagated operationId to createAgentSession", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    const result = await dispatchAgentHook(
      { runtimes: [claudeRuntime], createAgentSession },
      {
        workspace: fakeWorkspace,
        repo: fakeRepo,
        prompt: "rendered body",
        operationId: "op_seed",
        hookId: "file:workspace.setup/x.agent",
        event: "workspace.setup",
      },
    );
    expect(result.sessionId).toBe("agent_session_xyz");
    const sessionInput = createAgentSession.mock.calls[0]?.[0];
    expect(sessionInput.workspaceId).toBe("ws_test");
    expect(sessionInput.prompt).toBe("rendered body");
    expect(sessionInput.operationId).toBe("op_seed");
    expect(sessionInput.runtimeId).toBe("claude-code");
  });

  it("uses the frontmatter runtime when provided (overrides the default)", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    await dispatchAgentHook(
      { runtimes: [claudeRuntime, codexRuntime], createAgentSession },
      {
        workspace: fakeWorkspace,
        repo: fakeRepo,
        runtimeId: "codex",
        prompt: "p",
        operationId: null,
        hookId: "h",
        event: "workspace.action",
      },
    );
    expect(createAgentSession.mock.calls[0]?.[0]?.runtimeId).toBe("codex");
    expect(createAgentSession.mock.calls[0]?.[1]?.command).toBe("codex");
  });

  it("falls back to the first supportsPrompt runtime when frontmatter omits runtime", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    // shell first but doesn't support prompt; codex second is the first
    // supports-prompt runtime — that's the chosen default.
    await dispatchAgentHook(
      { runtimes: [shellRuntime, codexRuntime, claudeRuntime], createAgentSession },
      {
        workspace: fakeWorkspace,
        repo: fakeRepo,
        prompt: "p",
        operationId: null,
        hookId: "h",
        event: "workspace.action",
      },
    );
    expect(createAgentSession.mock.calls[0]?.[0]?.runtimeId).toBe("codex");
  });

  it("throws when the requested runtime is unknown (rather than silently substituting)", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    await expect(
      dispatchAgentHook(
        { runtimes: [claudeRuntime], createAgentSession },
        {
          workspace: fakeWorkspace,
          repo: fakeRepo,
          runtimeId: "ghost",
          prompt: "p",
          operationId: null,
          hookId: "h",
          event: "workspace.action",
        },
      ),
    ).rejects.toThrow(/agent_hook_unknown_runtime/);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("omits operationId from CreateAgentSessionInput when null (preserves the optional field shape)", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    await dispatchAgentHook(
      { runtimes: [claudeRuntime], createAgentSession },
      {
        workspace: fakeWorkspace,
        repo: fakeRepo,
        prompt: "p",
        operationId: null,
        hookId: "h",
        event: "workspace.action",
      },
    );
    const sessionInput = createAgentSession.mock.calls[0]?.[0];
    expect(Object.hasOwn(sessionInput, "operationId")).toBe(false);
  });

  it("forwards displayName when provided", async () => {
    const createAgentSession = vi.fn().mockResolvedValue(fakeSession);
    await dispatchAgentHook(
      { runtimes: [claudeRuntime], createAgentSession },
      {
        workspace: fakeWorkspace,
        repo: fakeRepo,
        displayName: "PR-merge: notify",
        prompt: "p",
        operationId: null,
        hookId: "h",
        event: "pr.merge",
      },
    );
    expect(createAgentSession.mock.calls[0]?.[0]?.displayName).toBe("PR-merge: notify");
  });
});

describe("defaultPromptRuntimeId", () => {
  it("returns the first supportsPrompt runtime", () => {
    expect(defaultPromptRuntimeId([shellRuntime, codexRuntime, claudeRuntime])).toBe("codex");
  });

  it("falls back to 'claude-code' when no runtime supports prompt", () => {
    expect(defaultPromptRuntimeId([shellRuntime])).toBe("claude-code");
  });

  it("falls back to 'claude-code' when the list is empty", () => {
    expect(defaultPromptRuntimeId([])).toBe("claude-code");
  });
});
