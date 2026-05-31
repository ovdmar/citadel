import type { CitadelConfig } from "@citadel/config";
import type { AgentSession, Repo, ScheduledAgent, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_BACKGROUND_RESUME_MARKER,
  buildRateLimitBackgroundResumePrompt,
  computeBackgroundResumeRunAt,
  resumeRateLimitedSessions,
  scheduleRateLimitBackgroundResume,
} from "./rate-limit-background-resume.js";
import type { ScheduledAgentService } from "./scheduled-agent-service.js";

const NOW = new Date("2026-05-25T12:00:00.000Z");

function config(): CitadelConfig {
  return {
    version: 1,
    dataDir: "/tmp/citadel-test",
    databasePath: "/tmp/citadel-test/citadel.sqlite",
    bindHost: "127.0.0.1",
    port: 4010,
    mcp: { enabled: true },
    providers: { github: { enabled: true, command: "gh" }, jira: { enabled: true, command: "jtk" } },
    runtimes: [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"], supportsPrompt: true }],
    usageProviders: [],
    automations: {
      fixCi: {
        enabled: true,
        runtimeId: "claude-code",
        fallbackRuntimeId: "codex",
        idleThresholdMs: 300_000,
        debounceMs: 1_800_000,
        intervalMs: 60_000,
      },
    },
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] },
    commandPolicy: { hookTimeoutMs: 120_000, allowDestructiveWorkspaceCleanup: false },
    scratchpad: { path: undefined },
  } as CitadelConfig;
}

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "shell",
    displayName: "Shell",
    status: "usage_limited",
    statusReason: "pane:usage_limited:reset=2026-05-25T12:30:00.000Z",
    statusReasonAt: null,
    lastStatusAt: NOW.toISOString(),
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    tmuxSessionName: "tmux_1",
    tmuxSessionId: "$1",
    runtimeSessionId: null,
    rateLimitResumeAttempts: 0,
    nextResumeAt: null,
    lastResumeFromRateLimitAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function repo(over: Partial<Repo> = {}): Repo {
  return {
    id: "repo_1",
    name: "repo",
    rootPath: "/repo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archivedAt: null,
    ...over,
  };
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: "repo_1",
    name: "ws",
    path: "/repo",
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
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    archivedAt: null,
    ...over,
  };
}

function scheduledAgent(over: Partial<ScheduledAgent> = {}): ScheduledAgent {
  return {
    id: "sched_existing",
    name: "Rate-limit auto-resume",
    description: RATE_LIMIT_BACKGROUND_RESUME_MARKER,
    scheduleType: "once",
    cron: null,
    runAt: "2026-05-25T12:31:00.000Z",
    repoId: "repo_1",
    runtimeId: "shell",
    prompt: "node --input-type=module -e ''",
    workspaceStrategy: "new",
    workspaceName: "(background)",
    baseBranch: null,
    runMode: "background",
    backgroundCwd: "/repo",
    overlapPolicy: "skip",
    enabled: true,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunMessage: null,
    lastWorkspaceId: null,
    lastSessionId: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

function storeFixture(input: {
  sessions?: AgentSession[];
  scheduledAgents?: ScheduledAgent[];
  repos?: Repo[];
  workspaces?: Workspace[];
}) {
  const updates: Array<{ sessionId: string; update: Parameters<SqliteStore["updateSessionRateLimitResume"]>[1] }> = [];
  const store = {
    listSessions: () => input.sessions ?? [],
    listScheduledAgents: () => input.scheduledAgents ?? [],
    listRepos: () => input.repos ?? [repo()],
    listWorkspaces: () => input.workspaces ?? [workspace()],
    updateSessionRateLimitResume: (
      sessionId: string,
      update: Parameters<SqliteStore["updateSessionRateLimitResume"]>[1],
    ) => {
      updates.push({ sessionId, update });
    },
  } as unknown as SqliteStore;
  return { store, updates };
}

describe("rate-limit background resume scheduling", () => {
  it("computes reset+60s and never schedules before now", () => {
    expect(computeBackgroundResumeRunAt("2026-05-25T12:30:00.000Z", NOW)).toBe("2026-05-25T12:31:00.000Z");
    expect(computeBackgroundResumeRunAt("2026-05-25T11:30:00.000Z", NOW)).toBe("2026-05-25T12:00:00.000Z");
  });

  it("creates one one-shot background scheduled agent for the latest parsed usage reset", () => {
    const { store } = storeFixture({
      sessions: [
        session({ id: "a", statusReason: "pane:usage_limited:reset=2026-05-25T12:10:00.000Z" }),
        session({ id: "b", statusReason: "pane:usage_limited:reset=2026-05-25T12:30:00.000Z" }),
      ],
    });
    const created: ScheduledAgent[] = [];
    const service = {
      create: vi.fn((input) => {
        const agent = scheduledAgent({ id: "sched_new", ...input, cron: null, lastRunStatus: "never" });
        created.push(agent);
        return { ok: true, value: agent };
      }),
      update: vi.fn(),
    } as unknown as ScheduledAgentService;

    const result = scheduleRateLimitBackgroundResume({
      store,
      scheduledAgentService: service,
      config: config(),
      now: NOW,
    });

    expect(result).toEqual({ kind: "created", scheduledAgentId: "sched_new", runAt: "2026-05-25T12:31:00.000Z" });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        description: RATE_LIMIT_BACKGROUND_RESUME_MARKER,
        scheduleType: "once",
        runAt: "2026-05-25T12:31:00.000Z",
        runtimeId: "shell",
        runMode: "background",
        backgroundCwd: "/repo",
        overlapPolicy: "skip",
      }),
    );
    expect(created[0]?.prompt).toContain("/api/internal/rate-limit-auto-resume");
  });

  it("does not create a duplicate while a pending internal one-shot exists", () => {
    const { store } = storeFixture({
      sessions: [session({ statusReason: "pane:usage_limited:reset=2026-05-25T12:30:00.000Z" })],
      scheduledAgents: [scheduledAgent()],
    });
    const service = { create: vi.fn(), update: vi.fn() } as unknown as ScheduledAgentService;

    const result = scheduleRateLimitBackgroundResume({
      store,
      scheduledAgentService: service,
      config: config(),
      now: NOW,
    });

    expect(result).toEqual({
      kind: "already_scheduled",
      scheduledAgentId: "sched_existing",
      runAt: "2026-05-25T12:31:00.000Z",
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it("does not schedule again for a reset cycle already resumed", () => {
    const resetAt = "2026-05-25T11:30:00.000Z";
    const { store } = storeFixture({
      sessions: [
        session({
          statusReason: `pane:usage_limited:reset=${resetAt}`,
          lastResumeFromRateLimitAt: "2026-05-25T11:31:00.000Z",
        }),
      ],
    });
    const service = { create: vi.fn(), update: vi.fn() } as unknown as ScheduledAgentService;

    const result = scheduleRateLimitBackgroundResume({
      store,
      scheduledAgentService: service,
      config: config(),
      now: NOW,
    });

    expect(result).toEqual({ kind: "no_reset" });
    expect(service.create).not.toHaveBeenCalled();
  });

  it("builds a shell prompt that calls the local internal resume endpoint", () => {
    expect(buildRateLimitBackgroundResumePrompt("http://127.0.0.1:4010")).toContain(
      "http://127.0.0.1:4010/api/internal/rate-limit-auto-resume",
    );
  });
});

describe("resumeRateLimitedSessions", () => {
  it("resumes all currently limited sessions through system, non-optimistic sends", async () => {
    const dueReset = "2026-05-25T11:30:00.000Z";
    const { store, updates } = storeFixture({
      sessions: [
        session({ id: "usage", status: "usage_limited", statusReason: `pane:usage_limited:reset=${dueReset}` }),
        session({ id: "server", status: "rate_limited", statusReason: "pane:rate_limited:server" }),
        session({ id: "idle", status: "idle", statusReason: "pane:active:idle" }),
      ],
    });
    const sends: Array<Parameters<OperationService["sendAgentMessage"]>[0]> = [];
    const operations = {
      sendAgentMessage: async (input: Parameters<OperationService["sendAgentMessage"]>[0]) => {
        sends.push(input);
        return { ok: true, sessionId: input.sessionId };
      },
    } as unknown as OperationService;

    const result = await resumeRateLimitedSessions({ store, operations, config: config(), now: NOW });

    expect(result).toEqual({ resumed: ["usage", "server"], skipped: [], postponedUntil: null });
    expect(sends).toEqual([
      { sessionId: "usage", message: "resume", source: "system", optimistic: false },
      { sessionId: "server", message: "resume", source: "system", optimistic: false },
    ]);
    expect(updates).toHaveLength(2);
    expect(updates[0]?.update).toMatchObject({
      rateLimitResumeAttempts: 0,
      nextResumeAt: null,
      lastResumeFromRateLimitAt: NOW.toISOString(),
    });
  });

  it("postpones every resume when any healthy usage limit reset is still in the future", async () => {
    const { store } = storeFixture({
      sessions: [
        session({
          id: "usage",
          status: "usage_limited",
          statusReason: "pane:usage_limited:reset=2026-05-25T12:30:00.000Z",
        }),
        session({ id: "server", status: "rate_limited", statusReason: "pane:rate_limited:server" }),
      ],
    });
    const operations = { sendAgentMessage: vi.fn() } as unknown as OperationService;

    const result = await resumeRateLimitedSessions({ store, operations, config: config(), now: NOW });

    expect(result).toEqual({ resumed: [], skipped: [], postponedUntil: "2026-05-25T12:30:00.000Z" });
    expect(operations.sendAgentMessage).not.toHaveBeenCalled();
  });
});
