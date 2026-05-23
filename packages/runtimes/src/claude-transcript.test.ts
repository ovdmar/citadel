import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectsDir, findClaudeTranscriptForSession, parseClaudeTranscript } from "./claude-transcript.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("claudeProjectsDir", () => {
  it("dasherizes non-alphanumeric characters in the cwd", () => {
    const dir = claudeProjectsDir("/home/jonsnow/Workspace/citadel", "/root");
    expect(dir).toBe("/root/.claude/projects/-home-jonsnow-Workspace-citadel");
  });

  it("collapses dotted path segments into double dashes like Claude Code does", () => {
    const dir = claudeProjectsDir("/Users/me/.work/foo", "/root");
    expect(dir).toBe("/root/.claude/projects/-Users-me--work-foo");
  });
});

describe("parseClaudeTranscript", () => {
  it("extracts user-authored text messages and skips tool_result envelopes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-transcript-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello world" },
        uuid: "u1",
        timestamp: "2026-05-23T10:00:00.000Z",
        sessionId: "claude-1",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
        uuid: "tool-result",
        timestamp: "2026-05-23T10:00:01.000Z",
        sessionId: "claude-1",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "ignored" },
        uuid: "a1",
        timestamp: "2026-05-23T10:00:02.000Z",
        sessionId: "claude-1",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "follow-up message" }],
        },
        uuid: "u2",
        timestamp: "2026-05-23T10:01:00.000Z",
        sessionId: "claude-1",
      }),
      "not-json",
      "",
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);

    const prompts = parseClaudeTranscript(file);
    expect(prompts).toEqual([
      { uuid: "u1", text: "hello world", timestamp: "2026-05-23T10:00:00.000Z", sessionId: "claude-1" },
      { uuid: "u2", text: "follow-up message", timestamp: "2026-05-23T10:01:00.000Z", sessionId: "claude-1" },
    ]);
  });

  it("returns an empty array when the file does not exist", () => {
    expect(parseClaudeTranscript("/nonexistent/path.jsonl")).toEqual([]);
  });
});

describe("findClaudeTranscriptForSession", () => {
  it("picks the transcript whose first user message is closest to the session start", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-home-"));
    dirs.push(home);
    const workspacePath = "/tmp/ws-fixture";
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    const oldFile = path.join(projects, "old.jsonl");
    const matchFile = path.join(projects, "match.jsonl");
    fs.writeFileSync(
      oldFile,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "stale" },
        uuid: "old",
        timestamp: "2026-05-22T09:00:00.000Z",
        sessionId: "old",
      })}\n`,
    );
    fs.writeFileSync(
      matchFile,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        uuid: "match",
        timestamp: "2026-05-23T10:00:05.000Z",
        sessionId: "match",
      })}\n`,
    );

    const found = findClaudeTranscriptForSession({
      workspacePath,
      sessionStartedAt: "2026-05-23T10:00:00.000Z",
      home,
    });
    expect(found).toBe(matchFile);
  });

  it("returns null when the project directory does not exist", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-home-"));
    dirs.push(home);
    expect(
      findClaudeTranscriptForSession({
        workspacePath: "/nowhere",
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
        home,
      }),
    ).toBeNull();
  });
});
