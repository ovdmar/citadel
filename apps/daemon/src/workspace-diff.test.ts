import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStatus, readWorkspaceDiff, readWorkspaceRecentCommits } from "./workspace-diff.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace diff reader", () => {
  it("parses porcelain rename and copy status pairs using the resulting path", () => {
    expect(parseStatus("R  new.txt\0old.txt\0C  copy.txt\0source.txt\0?? loose.txt\0")).toEqual([
      { status: "R ", path: "new.txt" },
      { status: "C ", path: "copy.txt" },
      { status: "??", path: "loose.txt" },
    ]);
  });

  it("returns bounded previews for tracked, untracked, renamed, and binary changes", () => {
    const repo = createGitFixture();
    fs.writeFileSync(path.join(repo, "tracked.txt"), `changed\n${"x".repeat(140 * 1024)}`);
    fs.writeFileSync(path.join(repo, "new.txt"), "untracked\n");
    fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    fs.renameSync(path.join(repo, "rename-me.txt"), path.join(repo, "renamed.txt"));
    run("git", ["add", "-A"], repo);

    const diff = readWorkspaceDiff("ws_test", repo);

    expect(diff.clean).toBe(false);
    expect(diff.truncated).toBe(true);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tracked.txt", status: "M ", truncated: true }),
        expect.objectContaining({ path: "new.txt", status: "A ", binary: false }),
        expect.objectContaining({ path: "binary.bin", status: "A ", binary: true, diff: "" }),
        expect.objectContaining({ path: "renamed.txt", status: "R ", binary: false }),
      ]),
    );
    expect(diff.files.find((file) => file.path === "tracked.txt")?.diff.length).toBeLessThanOrEqual(128 * 1024);
  });

  it("returns untracked text previews and hides untracked binary content", () => {
    const repo = createGitFixture();
    fs.writeFileSync(path.join(repo, "untracked.txt"), "hello\n");
    fs.writeFileSync(path.join(repo, "untracked.bin"), Buffer.from([0, 1, 2, 3]));

    const diff = readWorkspaceDiff("ws_test", repo);

    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "untracked.txt",
          status: "??",
          binary: false,
          diff: expect.stringContaining("hello"),
        }),
        expect.objectContaining({ path: "untracked.bin", status: "??", binary: true, diff: "" }),
      ]),
    );
  });
});

describe("readWorkspaceRecentCommits", () => {
  it("returns sha/shortSha/message/author/relative/iso for each commit, newest first, honoring limit", () => {
    const repo = createGitFixture();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "second\n");
    run("git", ["add", "."], repo);
    run("git", ["commit", "-m", "second commit"], repo);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "third\n");
    run("git", ["add", "."], repo);
    run("git", ["commit", "-m", "third commit"], repo);

    const result = readWorkspaceRecentCommits("ws_test", repo, 2);
    expect(result.workspaceId).toBe("ws_test");
    expect(result.commits).toHaveLength(2);
    expect(result.commits[0]).toMatchObject({ message: "third commit", author: "Citadel Test" });
    expect(result.commits[1]).toMatchObject({ message: "second commit" });
    for (const commit of result.commits) {
      expect(commit.sha.length).toBeGreaterThanOrEqual(7);
      expect(commit.shortSha.length).toBeGreaterThanOrEqual(4);
      expect(commit.relativeTime).toMatch(/(seconds?|minutes?|hours?|days?|ago|just now)/);
      expect(commit.isoTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("clamps `limit` results to the requested ceiling and accepts more commits than exist", () => {
    const repo = createGitFixture();
    const result = readWorkspaceRecentCommits("ws_test", repo, 50);
    expect(result.commits).toHaveLength(1);
  });

  it("returns an empty list for a repo without any commits", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-empty-"));
    dirs.push(repo);
    run("git", ["init", "-b", "main"], repo);
    expect(readWorkspaceRecentCommits("ws_empty", repo)).toEqual({ workspaceId: "ws_empty", commits: [] });
  });

  it("survives commit messages containing the SEP/REC separator bytes by dropping malformed lines", () => {
    const repo = createGitFixture();
    run("git", ["commit", "--allow-empty", "-m", "hostile\x1fmessage"], repo);
    const result = readWorkspaceRecentCommits("ws_test", repo, 5);
    // The hostile commit either yields a clean record (when extra SEP lands at
    // end of subject) or is dropped, but the original `initial` commit always
    // survives — proving we don't truncate the full list because of one bad
    // record.
    expect(result.commits.find((commit) => commit.message === "initial")).toBeTruthy();
  });
});

function createGitFixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-diff-"));
  dirs.push(repo);
  run("git", ["init", "-b", "main"], repo);
  run("git", ["config", "user.email", "test@example.test"], repo);
  run("git", ["config", "user.name", "Citadel Test"], repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "initial\n");
  fs.writeFileSync(path.join(repo, "rename-me.txt"), "rename me\n");
  run("git", ["add", "."], repo);
  run("git", ["commit", "-m", "initial"], repo);
  return repo;
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}
