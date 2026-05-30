import type { AgentSession, Workspace } from "@citadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

type EnsureArgs = { sessionName: string; cwd: string };

const ensureTmuxSession = vi.fn(async (_input: EnsureArgs) => ({
  tmuxSessionName: "citadel_ws_sess",
  tmuxSessionId: "$1",
}));
const launchAgentInSession = vi.fn(
  async (_sessionName: string, _runtimeBinary: string, _argv: string[], _options?: unknown) => undefined,
);
const panePidProcess = vi.fn((_sessionName: string) => null as { command: string; pid: number } | null);

vi.mock("@citadel/terminal", () => ({
  ensureTmuxSession: (input: EnsureArgs) => ensureTmuxSession(input),
  launchAgentInSession: (sessionName: string, runtimeBinary: string, argv: string[], options?: unknown) =>
    launchAgentInSession(sessionName, runtimeBinary, argv, options),
  panePidProcess: (sessionName: string) => panePidProcess(sessionName),
}));

import { buildRespawnTmux, buildRestartAgent } from "./terminal-routes-helpers.js";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: "repo_1",
    name: "Workspace",
    path: "/tmp/citadel-ws",
    branch: "feature/test",
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
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    tmuxSessionName: "citadel_existing",
    tmuxSessionId: "$1",
    runtimeSessionId: "claude-session-1",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

function deps() {
  const store = {
    listWorkspaces: () => [workspace()],
    updateSessionStatus: vi.fn(),
  };
  const config = {
    runtimes: [
      {
        id: "claude-code",
        command: "claude",
        args: ["--flag"],
        displayName: "Claude",
        resumeArg: "--resume",
      },
    ],
  };
  return { store, config };
}

beforeEach(() => {
  ensureTmuxSession.mockClear();
  launchAgentInSession.mockClear();
  panePidProcess.mockClear();
});

describe("terminal route launch helpers", () => {
  it("passes the runtime exit hint when respawning an agent", async () => {
    const { store, config } = deps();
    const respawn = buildRespawnTmux(store as never, config as never);

    await respawn(session());

    expect(launchAgentInSession).toHaveBeenCalledWith(
      "citadel_existing",
      "claude",
      ["--flag", "--resume", "claude-session-1"],
      {
        exitHint: { runtimeId: "claude-code", runtimeSessionId: "claude-session-1" },
      },
    );
  });

  it("passes the runtime exit hint when restarting an agent", async () => {
    const { store, config } = deps();
    const restart = buildRestartAgent(store as never, config as never);

    await restart(session());

    expect(launchAgentInSession).toHaveBeenCalledWith(
      "citadel_existing",
      "claude",
      ["--flag", "--resume", "claude-session-1"],
      {
        exitHint: { runtimeId: "claude-code", runtimeSessionId: "claude-session-1" },
      },
    );
    expect(store.updateSessionStatus).toHaveBeenCalledWith(
      "sess_1",
      expect.objectContaining({ status: "running", statusReason: null }),
    );
  });
});
