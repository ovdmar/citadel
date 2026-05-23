import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { claudeProjectsDir } from "@citadel/runtimes";
import { afterEach, describe, expect, it } from "vitest";
import { readAgentHistory } from "./agent-history.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function restoreHome(original: string | undefined) {
  if (original === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = original;
}

function bootstrap() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-history-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const workspacePath = path.join(dir, "workspace");
  fs.mkdirSync(workspacePath, { recursive: true });
  store.insertRepo({
    id: "repo_h",
    name: "Repo",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-23T09:00:00.000Z",
    updatedAt: "2026-05-23T09:00:00.000Z",
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_h",
    repoId: "repo_h",
    name: "ws",
    path: workspacePath,
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
    createdAt: "2026-05-23T09:00:00.000Z",
    updatedAt: "2026-05-23T09:00:00.000Z",
    archivedAt: null,
  });
  store.insertSession({
    id: "sess_h",
    workspaceId: "ws_h",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "disconnected",
    tmuxSessionName: "citadel_h",
    tmuxSessionId: "$1",
    createdAt: "2026-05-23T10:00:00.000Z",
    updatedAt: "2026-05-23T10:00:00.000Z",
  });
  return { dir, store, workspacePath };
}

describe("readAgentHistory", () => {
  it("returns the initial prompt and merges transcript-derived follow-ups", () => {
    const { dir, store, workspacePath } = bootstrap();
    store.insertAgentPrompt({
      id: "pmt_initial",
      sessionId: "sess_h",
      source: "initial",
      role: "user",
      text: "start working on the audit",
      sentAt: "2026-05-23T10:00:00.000Z",
      externalId: null,
    });

    const home = path.join(dir, "home");
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, "claude-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "start working on the audit" },
          uuid: "claude-initial",
          timestamp: "2026-05-23T10:00:01.000Z",
          sessionId: "claude-session",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "focus on usability issues" },
          uuid: "claude-followup",
          timestamp: "2026-05-23T10:05:00.000Z",
          sessionId: "claude-session",
        }),
        "",
      ].join("\n"),
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = readAgentHistory(store, { sessionId: "sess_h" });
      if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
      expect(result.prompts.map((entry) => entry.text)).toEqual([
        "start working on the audit",
        "focus on usability issues",
      ]);
      // The transcript record should have replaced the DB-captured initial.
      const initial = result.prompts[0];
      expect(initial?.source).toBe("transcript");
      expect(initial?.externalId).toBe("claude-initial");
      expect(result.total).toBe(2);
    } finally {
      restoreHome(originalHome);
    }
  });

  it("falls back to DB-captured prompts when no transcript exists", () => {
    const { store } = bootstrap();
    store.insertAgentPrompt({
      id: "pmt_a",
      sessionId: "sess_h",
      source: "initial",
      role: "user",
      text: "kick off",
      sentAt: "2026-05-23T10:00:00.000Z",
      externalId: null,
    });
    store.insertAgentPrompt({
      id: "pmt_b",
      sessionId: "sess_h",
      source: "send_agent_message",
      role: "user",
      text: "second steer",
      sentAt: "2026-05-23T10:10:00.000Z",
      externalId: null,
    });
    const originalHome = process.env.HOME;
    process.env.HOME = "/nonexistent-home";
    try {
      const result = readAgentHistory(store, { sessionId: "sess_h" });
      if (!result.ok) throw new Error("expected ok");
      expect(result.prompts.map((entry) => entry.text)).toEqual(["kick off", "second steer"]);
      expect(result.total).toBe(2);
    } finally {
      restoreHome(originalHome);
    }
  });

  it("returns session_not_found when the session is missing", () => {
    const { store } = bootstrap();
    const result = readAgentHistory(store, { sessionId: "nope" });
    expect(result).toEqual({ ok: false, error: "session_not_found" });
  });
});
