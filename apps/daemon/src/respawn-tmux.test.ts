import type { AgentSession } from "@citadel/contracts";
import { describe, expect, it, vi } from "vitest";

// Mock @citadel/terminal so we can capture the args ensureTmuxSession is
// called with. runtimeId is load-bearing for the exit-hint feature on
// respawn paths — if it's ever dropped from the call, the Claude UUID
// resolver silently never runs and operators get the fallback hint forever.
type EnsureArgs = { sessionName: string; cwd: string; command: string; args: string[]; runtimeId?: string };
const ensureTmuxSession = vi.fn(async (_input: EnsureArgs) => ({ tmuxSessionName: "x", tmuxSessionId: "$1" }));
vi.mock("@citadel/terminal", () => ({ ensureTmuxSession: (input: EnsureArgs) => ensureTmuxSession(input) }));

import { makeRespawnTmux } from "./respawn-tmux.js";

function stubWorkspace(id: string, path: string) {
  return {
    id,
    repoId: "repo",
    name: id,
    path,
    branch: "feature/x",
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
  } as const;
}

function stubRuntime(id: string, command: string) {
  return { id, command, args: ["--flag"], displayName: id, promptArg: null };
}

function stubSession(workspaceId: string, runtimeId: string, tmuxSessionName: string | null = null) {
  return {
    id: "sess_x",
    workspaceId,
    runtimeId,
    displayName: "X",
    status: "running",
    transport: "connected",
    tmuxSessionName,
    tmuxSessionId: null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
  } as AgentSession;
}

describe("makeRespawnTmux", () => {
  it("propagates runtimeId so the wrapper's exit-hint resolver fires after a respawn", async () => {
    ensureTmuxSession.mockClear();
    const workspace = stubWorkspace("ws_1", "/tmp/citadel-ws-1");
    const runtime = stubRuntime("claude-code", "claude");
    const store = { listWorkspaces: () => [workspace] } as unknown as Parameters<typeof makeRespawnTmux>[0]["store"];
    const config = { runtimes: [runtime] } as unknown as Parameters<typeof makeRespawnTmux>[0]["config"];
    const respawn = makeRespawnTmux({ store, config });
    await respawn(stubSession("ws_1", "claude-code", "citadel_existing"));
    expect(ensureTmuxSession).toHaveBeenCalledTimes(1);
    expect(ensureTmuxSession.mock.calls[0]?.[0]).toMatchObject({
      sessionName: "citadel_existing",
      cwd: "/tmp/citadel-ws-1",
      command: "claude",
      args: ["--flag"],
      runtimeId: "claude-code",
    });
  });

  it("synthesizes a session name when none is recorded", async () => {
    ensureTmuxSession.mockClear();
    const workspace = stubWorkspace("ws_2", "/tmp/citadel-ws-2");
    const runtime = stubRuntime("codex", "codex");
    const store = { listWorkspaces: () => [workspace] } as unknown as Parameters<typeof makeRespawnTmux>[0]["store"];
    const config = { runtimes: [runtime] } as unknown as Parameters<typeof makeRespawnTmux>[0]["config"];
    const respawn = makeRespawnTmux({ store, config });
    await respawn(stubSession("ws_2", "codex"));
    expect(ensureTmuxSession.mock.calls[0]?.[0]).toMatchObject({ runtimeId: "codex" });
    expect(ensureTmuxSession.mock.calls[0]?.[0]?.sessionName).toMatch(/^citadel_ws_2_/);
  });

  it("returns null and does not call ensureTmuxSession when the workspace or runtime is missing", async () => {
    ensureTmuxSession.mockClear();
    const store = { listWorkspaces: () => [] } as unknown as Parameters<typeof makeRespawnTmux>[0]["store"];
    const config = { runtimes: [] } as unknown as Parameters<typeof makeRespawnTmux>[0]["config"];
    const respawn = makeRespawnTmux({ store, config });
    const result = await respawn(stubSession("ws_missing", "claude-code"));
    expect(result).toBeNull();
    expect(ensureTmuxSession).not.toHaveBeenCalled();
  });
});
