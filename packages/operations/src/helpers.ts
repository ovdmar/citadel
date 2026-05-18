import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { HookOutput } from "@citadel/contracts";

export function asObject(payload: unknown) {
  return typeof payload === "object" && payload !== null ? payload : {};
}

export function discoverDefaultBranch(rootPath: string) {
  try {
    const remoteHead = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
    })
      .trim()
      .replace("refs/remotes/origin/", "");
    return remoteHead || "main";
  } catch {
    return "main";
  }
}

export function tryRunGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

export function workspaceIsDirty(workspacePath: string) {
  if (!fs.existsSync(workspacePath)) return false;
  const output = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  return output.trim().length > 0;
}

export function withActionHookIds(output: HookOutput, hookId: string): HookOutput {
  return {
    ...output,
    actions: output.actions.map((action) => ({ ...action, hookId: action.hookId ?? hookId })),
  };
}
