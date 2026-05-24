import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const killCalls: string[] = [];
const insertCalls: Array<{ id: string }> = [];

// Mock @citadel/terminal so we can drive ensureTmuxSessionRaw / pipe / kill
// without spawning real tmux processes. Vitest runs hoisted variables before
// the mock factory; using globalThis keeps the closure refs stable.
vi.mock("@citadel/terminal", () => ({
  ensureTmuxSessionRaw: vi.fn(async ({ sessionName }: { sessionName: string }) => ({
    tmuxSessionName: sessionName,
    tmuxSessionId: "$mock",
  })),
  pipeBackgroundSessionToLog: vi.fn(),
  stopBackgroundSessionPipe: vi.fn(),
  killTmuxSession: vi.fn((name: string) => {
    killCalls.push(name);
  }),
  submitPrompt: vi.fn(async () => undefined),
}));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  killCalls.splice(0);
  insertCalls.splice(0);
  vi.clearAllMocks();
});

describe("createBackgroundAgentSession", () => {
  it("inserts a background_sessions row with the runtime display + cwd + tmux ids", async () => {
    const { createBackgroundAgentSession } = await import("./create-background-agent-session.js");
    const { store } = createStore();
    const result = await createBackgroundAgentSession(
      { store, activity: () => {} },
      {
        cwd: "/tmp/bg-test",
        runtimeId: "shell",
        runtime: { command: "bash", args: ["-lc", "true"], displayName: "Shell", promptArg: null },
        scheduledAgentId: "sched_x",
        logFilePath: "/tmp/bg-test/run.log",
      },
    );
    expect(result.scheduledAgentId).toBe("sched_x");
    expect(result.cwd).toBe("/tmp/bg-test");
    expect(result.tmuxSessionName).toMatch(/^citadel_bg_/);
    expect(store.findBackgroundSession(result.id)?.cwd).toBe("/tmp/bg-test");
  });

  it("kills the tmux session when pipeBackgroundSessionToLog throws after ensureTmuxSessionRaw succeeded", async () => {
    const terminal = await import("@citadel/terminal");
    vi.mocked(terminal.pipeBackgroundSessionToLog).mockImplementationOnce(() => {
      throw new Error("boom pipe");
    });
    const { createBackgroundAgentSession } = await import("./create-background-agent-session.js");
    const { store } = createStore();
    await expect(
      createBackgroundAgentSession(
        { store, activity: () => {} },
        {
          cwd: "/tmp/bg-fail",
          runtimeId: "shell",
          runtime: { command: "bash", args: [], displayName: "Shell", promptArg: null },
          scheduledAgentId: "sched_pipe_fail",
          logFilePath: "/tmp/bg-fail/run.log",
        },
      ),
    ).rejects.toThrow("boom pipe");
    expect(killCalls).toHaveLength(1);
    expect(killCalls[0]).toMatch(/^citadel_bg_/);
    // Row never inserted because the failure happens before insert.
    expect(store.findBackgroundSessionsByScheduledAgent("sched_pipe_fail")).toEqual([]);
  });

  it("kills the tmux session when the store insert throws after pipe was wired", async () => {
    const { createBackgroundAgentSession } = await import("./create-background-agent-session.js");
    const { store } = createStore();
    const original = store.insertBackgroundSession.bind(store);
    let calls = 0;
    store.insertBackgroundSession = ((session: Parameters<typeof original>[0]) => {
      calls += 1;
      throw new Error("boom insert");
    }) as typeof original;
    await expect(
      createBackgroundAgentSession(
        { store, activity: () => {} },
        {
          cwd: "/tmp/bg-fail-insert",
          runtimeId: "shell",
          runtime: { command: "bash", args: [], displayName: "Shell", promptArg: null },
          scheduledAgentId: "sched_insert_fail",
          logFilePath: "/tmp/bg-fail-insert/run.log",
        },
      ),
    ).rejects.toThrow("boom insert");
    expect(calls).toBe(1);
    expect(killCalls).toHaveLength(1);
  });

  it("threads prompt as a CLI arg when runtime.promptArg is set; pastes via submitPrompt otherwise", async () => {
    const terminal = await import("@citadel/terminal");
    const { createBackgroundAgentSession } = await import("./create-background-agent-session.js");
    const { store } = createStore();

    // Case A: promptArg present → prompt becomes a CLI arg, no paste.
    await createBackgroundAgentSession(
      { store, activity: () => {} },
      {
        cwd: "/tmp/bg-arg",
        runtimeId: "claude",
        runtime: { command: "claude", args: [], displayName: "Claude", promptArg: "-p" },
        prompt: "hello",
        scheduledAgentId: "sched_arg",
        logFilePath: "/tmp/bg-arg/run.log",
      },
    );
    const argCall = vi.mocked(terminal.ensureTmuxSessionRaw).mock.calls.at(-1)?.[0];
    expect(argCall?.args).toEqual(["-p", "hello"]);
    expect(terminal.submitPrompt).not.toHaveBeenCalled();

    // Case B: promptArg null → CLI args unchanged, paste via submitPrompt.
    await createBackgroundAgentSession(
      { store, activity: () => {} },
      {
        cwd: "/tmp/bg-paste",
        runtimeId: "shell",
        runtime: { command: "bash", args: [], displayName: "Shell", promptArg: null },
        prompt: "echo hi",
        scheduledAgentId: "sched_paste",
        logFilePath: "/tmp/bg-paste/run.log",
      },
    );
    const pasteCall = vi.mocked(terminal.ensureTmuxSessionRaw).mock.calls.at(-1)?.[0];
    expect(pasteCall?.args).toEqual([]);
    expect(terminal.submitPrompt).toHaveBeenCalledWith(pasteCall?.sessionName, "echo hi");
  });
});

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-bg-svc-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  return { store, dir };
}
