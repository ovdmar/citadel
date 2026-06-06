import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AgentSession } from "@citadel/contracts";
import type { CreateAgentSessionOperationInput, OperationService, RuntimeDescriptor } from "@citadel/operations";
import express, { type ErrorRequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgentSessionRoutes } from "./agent-session-routes.js";
import { asyncRoute } from "./app-helpers.js";
import { closeServer, createFixture as createFixtureBase, listen, postJson } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  vi.restoreAllMocks();
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("agent session reload route", () => {
  it("stops the current agent row and relaunches the runtime session into the same tab slot", async () => {
    const fixture = createFixture();
    insertWorkspace(fixture);
    insertAgentSession(fixture, {
      id: "sess_source",
      runtimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
      tabId: "tab_stable",
      targetType: "worktree_checkout",
      checkoutId: "co_1",
      role: "implementation",
      actionId: "implementation.review",
      managed: true,
      parentSessionId: "sess_parent",
      planVersionId: "plan_1",
      managerActionId: "mgr_1",
    });
    const operations = fakeOperations(fixture);
    const { server } = await createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);

    try {
      const response = await postJson<{ session: AgentSession; reloadedFrom: string }>(
        `${baseUrl}/api/agent-sessions/sess_source/reload`,
        {},
      );

      expect(response).toMatchObject({
        reloadedFrom: "sess_source",
        session: {
          id: "sess_reloaded",
          runtimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
          tabId: "tab_stable",
        },
      });
      expect(operations._callOrder).toEqual(["stop", "create"]);
      expect(operations.createAgentSession).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws_1",
          runtimeId: "claude-code",
          displayName: "Claude",
          resumeRuntimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
          resumeSourceSessionId: "sess_source",
          tabId: "tab_stable",
          targetType: "worktree_checkout",
          checkoutId: "co_1",
          role: "implementation",
          actionId: "implementation.review",
          managed: true,
          parentSessionId: "sess_parent",
          planVersionId: "plan_1",
          managerActionId: "mgr_1",
        }),
        expect.objectContaining({ command: "node", resumeArg: "--resume", sessionIdArg: "--session-id" }),
      );
      expect(fixture.store.listSessions("ws_1").find((session) => session.id === "sess_source")).toMatchObject({
        status: "stopped",
        closedAt: expect.stringMatching(/Z$/),
      });
    } finally {
      await closeServer(server);
    }
  });

  it("emits only the replacement update after a successful in-place reload", async () => {
    const fixture = createFixture();
    insertWorkspace(fixture);
    insertAgentSession(fixture, { id: "sess_source", tabId: "tab_stable" });
    const operations = fakeOperations(fixture);
    const events: Array<{ type: string; payload: unknown }> = [];
    const server = createReloadRouteServer(fixture, operations, events);
    const baseUrl = await listen(server);

    try {
      await postJson<{ session: AgentSession; reloadedFrom: string }>(
        `${baseUrl}/api/agent-sessions/sess_source/reload`,
        {},
      );

      expect(events).toEqual([
        {
          type: "agent.updated",
          payload: { workspaceId: "ws_1", sessionId: "sess_reloaded", reloadedFrom: "sess_source" },
        },
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects agent rows without a runtime session id before stopping anything", async () => {
    const fixture = createFixture();
    insertWorkspace(fixture);
    insertAgentSession(fixture, { id: "sess_missing_uuid", runtimeSessionId: null });
    const operations = fakeOperations(fixture);
    const { server } = await createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent-sessions/sess_missing_uuid/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "session_not_resumable", sessionId: "sess_missing_uuid" });
      expect(operations.stopAgentSession).not.toHaveBeenCalled();
      expect(operations.createAgentSession).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects closed agent rows before stopping or creating a replacement", async () => {
    const fixture = createFixture();
    insertWorkspace(fixture);
    insertAgentSession(fixture, {
      id: "sess_closed",
      status: "stopped",
      transport: "disconnected",
      closedAt: "2026-06-06T00:01:00.000Z",
    });
    const operations = fakeOperations(fixture);
    const { server } = await createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent-sessions/sess_closed/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "session_not_live", sessionId: "sess_closed" });
      expect(operations.stopAgentSession).not.toHaveBeenCalled();
      expect(operations.createAgentSession).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects runtimes without resume support before stopping anything", async () => {
    const fixture = createFixture();
    const runtime = fixture.config.agentRuntimes[0];
    if (!runtime) throw new Error("expected runtime fixture");
    const { resumeArg, ...runtimeWithoutResume } = runtime;
    expect(resumeArg).toBe("--resume");
    fixture.config.agentRuntimes = [runtimeWithoutResume];
    insertWorkspace(fixture);
    insertAgentSession(fixture, { id: "sess_no_resume_runtime" });
    const operations = fakeOperations(fixture);
    const { server } = await createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent-sessions/sess_no_resume_runtime/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "runtime_does_not_support_resume",
        runtimeId: "claude-code",
      });
      expect(operations.stopAgentSession).not.toHaveBeenCalled();
      expect(operations.createAgentSession).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("emits the stopped source update even when relaunch fails", async () => {
    const fixture = createFixture();
    insertWorkspace(fixture);
    insertAgentSession(fixture, { id: "sess_launch_error" });
    const operations = fakeOperations(fixture);
    operations.createAgentSession.mockImplementation(async () => {
      operations._callOrder.push("create");
      throw new Error("launch failed");
    });
    const events: Array<{ type: string; payload: unknown }> = [];
    const server = createReloadRouteServer(fixture, operations, events);
    const baseUrl = await listen(server);

    try {
      const response = await fetch(`${baseUrl}/api/agent-sessions/sess_launch_error/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: "launch failed" });
      expect(operations._callOrder).toEqual(["stop", "create"]);
      expect(events).toEqual([
        { type: "agent.updated", payload: { workspaceId: "ws_1", sessionId: "sess_launch_error" } },
      ]);
    } finally {
      await closeServer(server);
    }
  });
});

function createFixture() {
  const fixture = createFixtureBase(dirs);
  const runtimeScript = path.join(fixture.config.dataDir, "fake-runtime.js");
  fs.writeFileSync(runtimeScript, "setInterval(() => {}, 1000);\n");
  fixture.config.agentRuntimes = [
    {
      id: "claude-code",
      displayName: "Claude",
      command: "node",
      args: [runtimeScript],
      sessionIdArg: "--session-id",
      resumeArg: "--resume",
    },
  ];
  return fixture;
}

function fakeOperations(fixture: ReturnType<typeof createFixture>) {
  const callOrder: string[] = [];
  const operations = {
    _callOrder: callOrder,
    stopAgentSession: vi.fn((input: { sessionId: string }) => {
      callOrder.push("stop");
      fixture.store.closeWorkspaceSession(input.sessionId);
      return { stopped: true, removed: false, closed: true, reason: "ok" as const };
    }),
    createAgentSession: vi.fn(async (input: CreateAgentSessionOperationInput, _runtime: RuntimeDescriptor) => {
      callOrder.push("create");
      const ts = new Date().toISOString();
      const session: AgentSession = {
        id: "sess_reloaded",
        kind: "agent",
        workspaceId: input.workspaceId,
        targetType: input.targetType,
        checkoutId: input.checkoutId ?? null,
        runtimeId: input.runtimeId,
        displayName: input.displayName ?? "Claude",
        role: input.role ?? null,
        managed: input.managed ?? false,
        status: "running",
        transport: "connected",
        terminalBackend: "tmux",
        tmuxSessionName: "citadel_ws_1_reloaded",
        tmuxSessionId: "tmux_reloaded",
        tmuxSocketName: "citadel-ws-ws_1",
        runtimeSessionId: input.resumeRuntimeSessionId ?? null,
        tabId: input.tabId,
        createdAt: ts,
        updatedAt: ts,
      };
      fixture.store.insertSession(session);
      return session;
    }),
  };
  return operations as unknown as OperationService & typeof operations;
}

function createReloadRouteServer(
  fixture: ReturnType<typeof createFixture>,
  operations: OperationService,
  events: Array<{ type: string; payload: unknown }>,
) {
  const app = express();
  app.use(express.json());
  registerAgentSessionRoutes(app, {
    operations,
    store: fixture.store,
    emit: (type, payload) => events.push({ type, payload }),
    asyncRoute,
    config: fixture.config,
  });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "internal_error" });
  };
  app.use(errorHandler);
  return http.createServer(app);
}

function insertWorkspace(fixture: ReturnType<typeof createFixture>) {
  const ts = new Date().toISOString();
  fixture.store.insertWorkspace({
    id: "ws_1",
    repoId: null,
    name: "Workspace",
    path: fixture.config.dataDir,
    branch: "main",
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  });
}

function insertAgentSession(fixture: ReturnType<typeof createFixture>, overrides: Partial<AgentSession>) {
  const ts = "2026-06-06T00:00:00.000Z";
  fixture.store.insertSession({
    id: "sess_source",
    kind: "agent",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_ws_1_source",
    tmuxSessionId: "tmux_source",
    tmuxSocketName: "citadel-ws-ws_1",
    runtimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    tabId: "tab_source",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  });
}
