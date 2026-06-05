import type { WorkspaceSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  type SystemPromptStore,
  renderSystemPromptFallbackMessage,
  resolveSystemPromptLaunch,
} from "./system-prompt-launch.js";

describe("system prompt launch planning", () => {
  it("composes settings, role, and caller prompts into native argv", () => {
    const result = resolveSystemPromptLaunch({
      store: makeStore(),
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      baseSystemPrompt: "Base prompt",
      roleTemplatePrompt: "Role prompt",
      callerPrompt: "Caller prompt",
      runtimeArgs: ["--base"],
      launchWarnings: ["preexisting warning"],
      systemPromptArgv: { argv: ["--system", "{value}"], valueEncoding: "raw" },
      operationInput: { runtimeId: "test-agent", prompt: "User task" },
      runtime: { sessionIdArg: "--session-id", promptArg: "--prompt" },
    });

    expect(result.runtimeArgs).toEqual(["--base", "--system", "Base prompt\n\nRole prompt\n\nCaller prompt"]);
    expect(result.state).toMatchObject({
      snapshot: "Base prompt\n\nRole prompt\n\nCaller prompt",
      sources: ["settings_base", "role_template", "caller"],
    });
    expect(result.systemPromptDelivery).toEqual({ mode: "native_argv", runtimeId: "test-agent" });
    expect(result.systemPromptLastDelivery).toEqual({ mode: "native_argv", runtimeId: "test-agent" });
    expect(result.launchWarnings).toEqual(["preexisting warning"]);
  });

  it("selects pasted wrapper fallback when native system prompt argv is unavailable", () => {
    const result = resolveSystemPromptLaunch({
      store: makeStore(),
      workspaceId: "ws_1",
      runtimeId: "cursor-agent",
      baseSystemPrompt: "Base prompt",
      runtimeArgs: ["--base"],
      launchWarnings: [],
      operationInput: { runtimeId: "cursor-agent", prompt: "User task" },
      runtime: {},
    });

    expect(result.shouldUseFallbackSystemPrompt).toBe(true);
    expect(result.runtimeArgs).toEqual(["--base"]);
    expect(result.systemPromptDelivery).toEqual({
      mode: "pasted_wrapper",
      runtimeId: "cursor-agent",
      reason: "native_unavailable",
    });
    expect(result.launchWarnings[0]).toContain("pasted wrapper");
    expect(renderSystemPromptFallbackMessage("Base prompt", "User task")).toContain(
      "<citadel-system-instructions>\nBase prompt\n</citadel-system-instructions>",
    );
  });

  it("records empty metadata without changing argv when no prompt is composed", () => {
    const result = resolveSystemPromptLaunch({
      store: makeStore(),
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      baseSystemPrompt: " ",
      roleTemplatePrompt: "",
      callerPrompt: undefined,
      runtimeArgs: ["--base"],
      launchWarnings: [],
      systemPromptArgv: { argv: ["--system", "{value}"], valueEncoding: "raw" },
      operationInput: { runtimeId: "test-agent", prompt: "User task" },
      runtime: { promptArg: "--prompt" },
    });

    expect(result.runtimeArgs).toEqual(["--base"]);
    expect(result.state.sources).toEqual([]);
    expect(result.systemPromptDelivery).toEqual({ mode: "none", reason: "empty" });
    expect(result.systemPromptLastDelivery).toEqual({ mode: "none", reason: "empty" });
    expect(result.shouldUseFallbackSystemPrompt).toBe(false);
  });

  it("falls back when the projected full native argv is too large", () => {
    const result = resolveSystemPromptLaunch({
      store: makeStore(),
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      baseSystemPrompt: "Base prompt",
      runtimeArgs: ["--base"],
      launchWarnings: [],
      systemPromptArgv: { argv: ["--system", "{value}"], valueEncoding: "raw" },
      operationInput: { runtimeId: "test-agent", prompt: "x".repeat(70_000) },
      runtime: { promptArg: "--prompt" },
    });

    expect(result.runtimeArgs).toEqual(["--base"]);
    expect(result.systemPromptDelivery).toEqual({
      mode: "pasted_wrapper",
      runtimeId: "test-agent",
      reason: "argv_too_large",
    });
  });

  it("rejects raw authority tokens without echoing them", () => {
    const token = "citadel_agent_authority_abcdefghijklmnopqrstuvwxyz0123456789";

    let thrown: unknown;
    try {
      resolveSystemPromptLaunch({
        store: makeStore(),
        workspaceId: "ws_1",
        runtimeId: "test-agent",
        baseSystemPrompt: `Base ${token}`,
        runtimeArgs: [],
        launchWarnings: [],
        operationInput: { runtimeId: "test-agent" },
        runtime: {},
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("raw_authority_token_present:agentSessions.baseSystemPrompt");
    expect((thrown as Error).message).not.toContain(token);
  });

  it("copies resume metadata only from an exact source session match", () => {
    const source = agentSession({
      id: "sess_source",
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      runtimeSessionId: "run_1",
      systemPromptSources: ["settings_base", "role_template"],
      systemPromptDelivery: { mode: "native_argv", runtimeId: "test-agent" },
      systemPromptLastDelivery: { mode: "native_argv", runtimeId: "test-agent" },
    });
    const result = resolveSystemPromptLaunch({
      store: makeStore([source], { sess_source: "Old base\n\nOld role" }),
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      resumeRuntimeSessionId: "run_1",
      resumeSourceSessionId: "sess_source",
      baseSystemPrompt: "New base",
      roleTemplatePrompt: "New role",
      runtimeArgs: ["--base"],
      launchWarnings: [],
      operationInput: { runtimeId: "test-agent", resumeRuntimeSessionId: "run_1" },
      runtime: { resumeArg: "--resume" },
    });

    expect(result.state).toMatchObject({
      snapshot: "Old base\n\nOld role",
      sources: ["settings_base", "role_template"],
    });
    expect(result.systemPromptDelivery).toEqual({ mode: "native_argv", runtimeId: "test-agent" });
    expect(result.systemPromptLastDelivery).toEqual({ mode: "skipped_resume", reason: "resume" });
    expect(result.shouldUseFallbackSystemPrompt).toBe(false);
  });

  it("rejects mismatched resume source metadata", () => {
    const source = agentSession({
      id: "sess_source",
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      runtimeSessionId: "run_1",
    });

    expect(() =>
      resolveSystemPromptLaunch({
        store: makeStore([source]),
        workspaceId: "ws_1",
        runtimeId: "test-agent",
        resumeRuntimeSessionId: "run_2",
        resumeSourceSessionId: "sess_source",
        baseSystemPrompt: "New base",
        runtimeArgs: [],
        launchWarnings: [],
        operationInput: { runtimeId: "test-agent", resumeRuntimeSessionId: "run_2" },
        runtime: { resumeArg: "--resume" },
      }),
    ).toThrow(/resumeSourceSessionId/);
  });

  it("rejects raw authority tokens in copied resume snapshots", () => {
    const token = "citadel_agent_authority_abcdefghijklmnopqrstuvwxyz0123456789";
    const source = agentSession({
      id: "sess_source",
      workspaceId: "ws_1",
      runtimeId: "test-agent",
      runtimeSessionId: "run_1",
    });

    let thrown: unknown;
    try {
      resolveSystemPromptLaunch({
        store: makeStore([source], { sess_source: `Old base ${token}` }),
        workspaceId: "ws_1",
        runtimeId: "test-agent",
        resumeRuntimeSessionId: "run_1",
        resumeSourceSessionId: "sess_source",
        baseSystemPrompt: "New base",
        runtimeArgs: [],
        launchWarnings: [],
        operationInput: { runtimeId: "test-agent", resumeRuntimeSessionId: "run_1" },
        runtime: { resumeArg: "--resume" },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("raw_authority_token_present:workspaceSessions.systemPromptSnapshot");
    expect((thrown as Error).message).not.toContain(token);
  });
});

function makeStore(
  sessions: WorkspaceSession[] = [],
  snapshots: Record<string, string | null> = {},
): SystemPromptStore {
  return {
    listWorkspaceSessions: () => sessions,
    getWorkspaceSessionSystemPromptSnapshot: (sessionId) => snapshots[sessionId] ?? null,
  };
}

function agentSession(overrides: Partial<WorkspaceSession>): WorkspaceSession {
  return {
    id: "sess_1",
    kind: "agent",
    workspaceId: "ws_1",
    runtimeId: "test-agent",
    displayName: "Test Agent",
    targetType: "workspace_home",
    checkoutId: null,
    role: null,
    actionId: null,
    managed: false,
    parentSessionId: null,
    planVersionId: null,
    managerActionId: null,
    status: "stopped",
    statusReason: "launched",
    lastStatusAt: "2026-05-17T00:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    terminalBackend: "tmux",
    tmuxSessionName: null,
    tmuxSessionId: null,
    tmuxSocketName: null,
    ptySessionId: null,
    ptyOwnerSocket: null,
    ptyOwnerPid: null,
    ptyLastSeenAt: null,
    tabId: "tab_1",
    runtimeSessionId: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    ...overrides,
  } as WorkspaceSession;
}
