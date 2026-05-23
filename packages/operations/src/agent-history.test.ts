import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { claudeProjectsDir } from "@citadel/runtimes";
import { afterEach, describe, expect, it } from "vitest";
import { getSessionPromptSummary, readAgentHistory } from "./agent-history.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function bootstrap(runtimeId = "claude-code") {
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
    namespaceId: null,
    createdAt: "2026-05-23T09:00:00.000Z",
    updatedAt: "2026-05-23T09:00:00.000Z",
    archivedAt: null,
  });
  store.insertSession({
    id: "sess_h",
    workspaceId: "ws_h",
    runtimeId,
    displayName: "Agent",
    status: "running",
    transport: "disconnected",
    tmuxSessionName: "citadel_h",
    tmuxSessionId: "$1",
    createdAt: "2026-05-23T10:00:00.000Z",
    updatedAt: "2026-05-23T10:00:00.000Z",
  });
  return { dir, store, workspacePath };
}

function restoreHome(original: string | undefined) {
  if (original === undefined) Reflect.deleteProperty(process.env, "HOME");
  else process.env.HOME = original;
}

describe("readAgentHistory", () => {
  it("dispatches to the claude-code adapter and surfaces transcript prompts", () => {
    const { dir, store, workspacePath } = bootstrap("claude-code");
    const home = path.join(dir, "home");
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, "claude-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "start the audit" },
          uuid: "claude-1",
          timestamp: "2026-05-23T10:00:01.000Z",
          sessionId: "claude-session",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: "focus on usability" }] },
          uuid: "claude-2",
          timestamp: "2026-05-23T10:05:00.000Z",
          sessionId: "claude-session",
        }),
      ].join("\n"),
    );

    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const result = readAgentHistory(store, { sessionId: "sess_h" });
      if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
      expect(result.prompts.map((entry) => entry.text)).toEqual(["start the audit", "focus on usability"]);
      expect(result.prompts[0]?.externalId).toBe("claude-1");
      expect(result.total).toBe(2);
    } finally {
      restoreHome(originalHome);
    }
  });

  it("returns an empty history when the runtime has no transcript on disk", () => {
    const { store } = bootstrap("claude-code");
    const originalHome = process.env.HOME;
    process.env.HOME = "/nonexistent-home";
    try {
      const result = readAgentHistory(store, { sessionId: "sess_h" });
      if (!result.ok) throw new Error("expected ok");
      expect(result.prompts).toEqual([]);
      expect(result.total).toBe(0);
    } finally {
      restoreHome(originalHome);
    }
  });

  it("returns session_not_found when the session is missing", () => {
    const { store } = bootstrap();
    const result = readAgentHistory(store, { sessionId: "nope" });
    expect(result).toEqual({ ok: false, error: "session_not_found" });
  });

  it("returns an empty history for runtimes without an adapter (e.g. shell)", () => {
    const { store } = bootstrap("shell");
    const result = readAgentHistory(store, { sessionId: "sess_h" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.prompts).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("getSessionPromptSummary", () => {
  it("returns the first transcript prompt as the initial prompt and the total count", () => {
    const { dir, store, workspacePath } = bootstrap("claude-code");
    const home = path.join(dir, "home");
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, "claude-session.jsonl"),
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "kick off the migration" },
          uuid: "u1",
          timestamp: "2026-05-23T10:00:01.000Z",
          sessionId: "claude-session",
        }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "also rebase" },
          uuid: "u2",
          timestamp: "2026-05-23T10:01:00.000Z",
          sessionId: "claude-session",
        }),
      ].join("\n"),
    );
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const summary = getSessionPromptSummary(store, "sess_h");
      expect(summary).toEqual({ initialPrompt: "kick off the migration", messageCount: 2 });
    } finally {
      restoreHome(originalHome);
    }
  });

  it("returns null/0 when the session is unknown", () => {
    const { store } = bootstrap();
    expect(getSessionPromptSummary(store, "missing")).toEqual({ initialPrompt: null, messageCount: 0 });
  });
});
