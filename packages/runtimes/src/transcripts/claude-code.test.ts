import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeAdapter,
  claudeProjectsDir,
  findClaudeTranscriptForSession,
  parseClaudeTranscript,
} from "./claude-code.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("claudeProjectsDir", () => {
  it("dasherizes non-alphanumeric characters", () => {
    expect(claudeProjectsDir("/home/jonsnow/Workspace/citadel", "/root")).toBe(
      "/root/.claude/projects/-home-jonsnow-Workspace-citadel",
    );
  });

  it("collapses dotted segments", () => {
    expect(claudeProjectsDir("/Users/me/.work/foo", "/root")).toBe("/root/.claude/projects/-Users-me--work-foo");
  });
});

describe("parseClaudeTranscript", () => {
  it("extracts user-authored text and skips tool_result envelopes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-transcript-"));
    dirs.push(dir);
    const file = path.join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello world" },
        uuid: "u1",
        timestamp: "2026-05-23T10:00:00.000Z",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
        uuid: "tool",
        timestamp: "2026-05-23T10:00:01.000Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "ignored" },
        uuid: "a1",
        timestamp: "2026-05-23T10:00:02.000Z",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "follow-up" }] },
        uuid: "u2",
        timestamp: "2026-05-23T10:01:00.000Z",
      }),
      "not-json",
      "",
    ];
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    expect(parseClaudeTranscript(file)).toEqual([
      { externalId: "u1", text: "hello world", sentAt: "2026-05-23T10:00:00.000Z" },
      { externalId: "u2", text: "follow-up", sentAt: "2026-05-23T10:01:00.000Z" },
    ]);
  });

  it("returns [] for a missing file", () => {
    expect(parseClaudeTranscript("/nonexistent")).toEqual([]);
  });
});

describe("findClaudeTranscriptForSession + adapter", () => {
  it("picks the .jsonl whose first user prompt is closest to the session start", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-home-"));
    dirs.push(home);
    const workspacePath = "/tmp/ws-fixture-match";
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    const matchFile = path.join(projects, "match.jsonl");
    fs.writeFileSync(
      matchFile,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "hi" },
        uuid: "match",
        timestamp: "2026-05-23T10:00:05.000Z",
      })}\n`,
    );
    expect(
      findClaudeTranscriptForSession({
        workspacePath,
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
        home,
      }),
    ).toBe(matchFile);
  });

  it("skips files whose mtime predates the session window", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-home-"));
    dirs.push(home);
    const workspacePath = "/tmp/ws-fixture-stale";
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    const stale = path.join(projects, "stale.jsonl");
    fs.writeFileSync(
      stale,
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "would score perfectly" },
        uuid: "stale",
        timestamp: "2026-05-23T10:00:00.000Z",
      })}\n`,
    );
    const longAgo = new Date("2026-01-01T00:00:00.000Z").getTime();
    fs.utimesSync(stale, longAgo / 1000, longAgo / 1000);
    expect(
      findClaudeTranscriptForSession({
        workspacePath,
        sessionStartedAt: "2026-05-23T10:00:00.000Z",
        home,
      }),
    ).toBeNull();
  });

  it("adapter.getUserPrompts returns parsed prompts via the dispatcher", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-home-"));
    dirs.push(home);
    const workspacePath = "/tmp/ws-fixture-adapter";
    const projects = claudeProjectsDir(workspacePath, home);
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, "session.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "go" },
        uuid: "u1",
        timestamp: "2026-05-23T10:00:01.000Z",
      })}\n`,
    );
    const prompts = claudeCodeAdapter.getUserPrompts({
      workspacePath,
      sessionStartedAt: "2026-05-23T10:00:00.000Z",
      home,
    });
    expect(prompts).toEqual([{ externalId: "u1", text: "go", sentAt: "2026-05-23T10:00:01.000Z" }]);
  });
});
