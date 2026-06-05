import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexAdapter,
  discoverCodexSessionIdFromProcess,
  extractCodexResumeSessionIdFromArgv,
  findCodexRolloutForSession,
  parseCodexRollout,
} from "./codex.js";

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function writeRollout(filePath: string, lines: unknown[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

describe("parseCodexRollout", () => {
  it("returns session_meta + user input_text prompts, skipping environment_context", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-"));
    dirs.push(dir);
    const file = path.join(dir, "rollout.jsonl");
    writeRollout(file, [
      {
        timestamp: "2026-05-23T10:00:00.000Z",
        type: "session_meta",
        payload: { id: "codex-1", cwd: "/tmp/ws", timestamp: "2026-05-23T10:00:00.000Z" },
      },
      {
        timestamp: "2026-05-23T10:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
        },
      },
      {
        timestamp: "2026-05-23T10:00:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "do the migration" }],
        },
      },
      {
        timestamp: "2026-05-23T10:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "on it" }],
        },
      },
      {
        timestamp: "2026-05-23T10:00:04.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "also rebase" }],
        },
      },
    ]);
    const result = parseCodexRollout(file);
    expect(result.meta).toEqual({ id: "codex-1", cwd: "/tmp/ws", timestamp: "2026-05-23T10:00:00.000Z" });
    expect(result.prompts.map((entry) => entry.text)).toEqual(["do the migration", "also rebase"]);
    expect(result.prompts[0]?.externalId).toBe("codex-1:0");
    expect(result.prompts[1]?.externalId).toBe("codex-1:1");
  });
});

describe("findCodexRolloutForSession + adapter", () => {
  it("matches by cwd and session-start window", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-home-"));
    dirs.push(home);
    const workspacePath = "/tmp/codex-ws";
    const sessionsRoot = path.join(home, ".codex", "sessions", "2026", "05", "23");
    // Stale: cwd matches but starts in the past — should be rejected by start window.
    const staleFile = path.join(sessionsRoot, "rollout-stale.jsonl");
    writeRollout(staleFile, [
      { type: "session_meta", payload: { id: "stale", cwd: workspacePath, timestamp: "2026-05-01T00:00:00.000Z" } },
      {
        type: "response_item",
        timestamp: "2026-05-01T00:00:01.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
      },
    ]);
    // Wrong-cwd file: would otherwise match by time, but cwd differs.
    const wrongCwd = path.join(sessionsRoot, "rollout-wrong.jsonl");
    writeRollout(wrongCwd, [
      { type: "session_meta", payload: { id: "wrong", cwd: "/somewhere/else", timestamp: "2026-05-23T10:00:01.000Z" } },
    ]);
    // Match.
    const matchFile = path.join(sessionsRoot, "rollout-match.jsonl");
    writeRollout(matchFile, [
      { type: "session_meta", payload: { id: "match", cwd: workspacePath, timestamp: "2026-05-23T10:00:02.000Z" } },
      {
        type: "response_item",
        timestamp: "2026-05-23T10:00:03.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      },
    ]);

    expect(
      findCodexRolloutForSession({
        workspacePath,
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
        home,
      }),
    ).toBe(matchFile);

    const prompts = codexAdapter.getUserPrompts({
      workspacePath,
      sessionStartedAt: "2026-05-23T10:00:00.000Z",
      home,
    });
    expect(prompts.map((entry) => entry.text)).toEqual(["hi"]);
  });

  it("returns null when the codex sessions root does not exist", () => {
    expect(
      findCodexRolloutForSession({
        workspacePath: "/tmp/x",
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
        home: "/nonexistent-citadel-codex-home",
      }),
    ).toBeNull();
  });

  it("matches rollouts under CODEX_HOME/sessions", () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-home-root-"));
    dirs.push(codexHome);
    const workspacePath = "/tmp/codex-var-ws";
    const matchFile = path.join(codexHome, "sessions", "2026", "06", "05", "rollout-match.jsonl");
    writeRollout(matchFile, [
      {
        type: "session_meta",
        payload: { id: "match-var", cwd: workspacePath, timestamp: "2026-06-05T10:00:02.000Z" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-05T10:00:03.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi from var" }] },
      },
    ]);

    expect(
      findCodexRolloutForSession({
        workspacePath,
        sessionStartedAt: "2026-06-05T10:00:00.000Z",
        codexHome,
      }),
    ).toBe(matchFile);
    expect(
      codexAdapter
        .getUserPrompts({ workspacePath, sessionStartedAt: "2026-06-05T10:00:00.000Z", codexHome })
        .map((entry) => entry.text),
    ).toEqual(["hi from var"]);
  });
});

describe("codex live-process session id discovery", () => {
  it("extracts the resume UUID from argv", () => {
    const uuid = "019e6fa5-b167-7f90-a4a3-6bee05a75453";
    expect(extractCodexResumeSessionIdFromArgv(["codex", "resume", uuid, "--yolo"])).toBe(uuid);
    expect(extractCodexResumeSessionIdFromArgv(["codex", "--yolo"])).toBeNull();
  });

  it("discovers the session id from a live process's open rollout file", async () => {
    if (!fs.existsSync("/proc")) return;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-proc-home-"));
    dirs.push(home);
    const uuid = "019e6fb1-4632-7492-b175-cd9de9afb5bf";
    const rolloutFile = path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "05",
      "28",
      `rollout-2026-05-28T17-45-49-${uuid}.jsonl`,
    );
    writeRollout(rolloutFile, [
      {
        timestamp: "2026-05-28T17:45:49.362Z",
        type: "session_meta",
        payload: { id: uuid, cwd: "/tmp/ws", timestamp: "2026-05-28T17:45:49.362Z" },
      },
    ]);

    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs = require('node:fs'); fs.openSync(process.argv[1], 'r'); setInterval(() => {}, 1000);",
        rolloutFile,
      ],
      { stdio: "ignore" },
    );
    children.push(child);
    expect(child.pid).toBeTypeOf("number");

    const found = await waitFor(() =>
      child.pid ? discoverCodexSessionIdFromProcess({ rootPid: child.pid, home, workspacePath: "/tmp/ws" }) : null,
    );
    expect(found).toBe(uuid);
  });

  it("rejects open rollout files from a different workspace", async () => {
    if (!fs.existsSync("/proc")) return;

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-codex-proc-home-"));
    dirs.push(home);
    const uuid = "019e706d-9798-7161-b54a-e827a3b6ff64";
    const rolloutFile = path.join(
      home,
      ".codex",
      "sessions",
      "2026",
      "05",
      "28",
      `rollout-2026-05-28T21-11-30-${uuid}.jsonl`,
    );
    writeRollout(rolloutFile, [
      {
        timestamp: "2026-05-28T21:11:30.123Z",
        type: "session_meta",
        payload: { id: uuid, cwd: "/tmp/other-ws", timestamp: "2026-05-28T21:11:30.123Z" },
      },
    ]);

    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs = require('node:fs'); fs.openSync(process.argv[1], 'r'); setInterval(() => {}, 1000);",
        rolloutFile,
      ],
      { stdio: "ignore" },
    );
    children.push(child);
    expect(child.pid).toBeTypeOf("number");

    const found = await waitFor(
      () =>
        child.pid
          ? discoverCodexSessionIdFromProcess({
              rootPid: child.pid,
              home,
              workspacePath: "/tmp/target-ws",
              sessionStartedAt: "2026-05-28T21:11:29.000Z",
            })
          : null,
      500,
    );
    expect(found).toBeNull();
  });
});

async function waitFor(read: () => string | null, timeoutMs = 2000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}
