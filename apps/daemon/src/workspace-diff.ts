import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiffFile, GitStatusSummary, WorkspaceDiff } from "@citadel/contracts";

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
    addedLines: files.reduce((total, file) => total + countDiffLines(file.diff).added, 0),
    deletedLines: files.reduce((total, file) => total + countDiffLines(file.diff).deleted, 0),
  };
}

export function readWorkspaceGitStatus(cwd: string): GitStatusSummary {
  const checkedAt = new Date().toISOString();
  const output = execGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  const lines = output.split("\n").filter(Boolean);
  const branchLine = lines[0]?.startsWith("## ") ? lines[0] : "";
  const statusLines = branchLine ? lines.slice(1) : lines;
  const counts = {
    modified: 0,
    staged: 0,
    untracked: 0,
    deleted: 0,
    renamed: 0,
    conflicted: 0,
  };
  for (const line of statusLines) {
    const status = line.slice(0, 2);
    if (status === "??") counts.untracked += 1;
    if (status.includes("U") || ["AA", "DD"].includes(status)) counts.conflicted += 1;
    if (status[0] && status[0] !== " " && status[0] !== "?") counts.staged += 1;
    if (status.includes("M")) counts.modified += 1;
    if (status.includes("D")) counts.deleted += 1;
    if (status.includes("R")) counts.renamed += 1;
  }
  return {
    branch: parseBranchName(branchLine),
    upstream: parseUpstream(branchLine),
    ahead: parseDistance(branchLine, "ahead"),
    behind: parseDistance(branchLine, "behind"),
    ...counts,
    clean: statusLines.length === 0,
    lines: statusLines.slice(0, 200),
    checkedAt,
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

function countDiffLines(diff: string) {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deleted += 1;
  }
  return { added, deleted };
}

function parseBranchName(branchLine: string) {
  if (!branchLine) return null;
  return (
    branchLine
      .replace(/^##\s+/, "")
      .split("...")[0]
      ?.trim() || null
  );
}

function parseUpstream(branchLine: string) {
  const match = branchLine.match(/\.\.\.([^\s\[]+)/);
  return match?.[1] ?? null;
}

function parseDistance(branchLine: string, kind: "ahead" | "behind") {
  const match = branchLine.match(new RegExp(`${kind} (\\d+)`));
  return match?.[1] ? Number(match[1]) : 0;
}
