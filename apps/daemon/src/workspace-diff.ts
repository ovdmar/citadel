import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiffFile, WorkspaceDiff } from "@citadel/contracts";

const MAX_DIFF_BYTES = 128 * 1024;
const MAX_DIFF_FILES = 80;

export function readWorkspaceDiff(workspaceId: string, cwd: string): WorkspaceDiff {
  const status = execGit(cwd, ["status", "--porcelain=v1", "-z"]);
  const paths = parseStatus(status);
  const files: DiffFile[] = paths.slice(0, MAX_DIFF_FILES).map((entry) => {
    const diff =
      entry.status === "??"
        ? readUntrackedFilePreview(cwd, entry.path, MAX_DIFF_BYTES)
        : execGit(cwd, ["diff", "--no-ext-diff", "HEAD", "--", entry.path]);
    const binary = diff.includes("Binary files") || diff.includes("GIT binary patch") || isLikelyBinaryPreview(diff);
    const truncated = diff.length > MAX_DIFF_BYTES;
    return {
      path: entry.path,
      status: entry.status,
      binary,
      truncated,
      diff: binary ? "" : diff.slice(0, MAX_DIFF_BYTES),
    };
  });
  return {
    workspaceId,
    clean: paths.length === 0,
    files,
    truncated: paths.length > files.length || files.some((file) => file.truncated),
  };
}

export function parseStatus(input: string) {
  const parts = input.split("\0").filter(Boolean);
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const status = item.slice(0, 2);
    const filePath = item.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      entries.push({ status, path: filePath });
      index += 1;
      continue;
    }
    entries.push({ status, path: filePath });
  }
  return entries;
}

function readUntrackedFilePreview(cwd: string, relativePath: string, maxBytes: number) {
  const absolutePath = path.resolve(cwd, relativePath);
  const root = path.resolve(cwd);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) throw new Error("invalid_diff_path");
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) return "";
  const content = fs.readFileSync(absolutePath);
  if (content.includes(0)) return "Binary files /dev/null and untracked file differ";
  const preview = content.subarray(0, maxBytes).toString("utf8");
  return `--- /dev/null\n+++ b/${relativePath}\n@@ untracked preview @@\n${preview}`;
}

function isLikelyBinaryPreview(diff: string) {
  return diff.includes("\u0000");
}

function execGit(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
}
