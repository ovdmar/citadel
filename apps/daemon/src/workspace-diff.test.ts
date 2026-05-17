import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseStatus, readWorkspaceDiff } from "./workspace-diff.js";

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
