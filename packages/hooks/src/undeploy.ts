import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import type { UndeployHookResolution } from "@citadel/contracts";
import { buildHookEnv, inspectHookFile, notExecutableNote } from "./file-hook-shared.js";

// The undeploy hook contract:
//
//   `<hook> [name]` → stops the named app, or all apps if no name.
//                     stdout/stderr are streamed.
//
// The hook is invoked with cwd = workspacePath and these env vars:
//   CITADEL_WORKSPACE_ID, CITADEL_WORKSPACE_PATH, CITADEL_WORKSPACE_BRANCH, CITADEL_REPO_ID

export const UNDEPLOY_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "undeploy");

export type UndeployHookEnv = {
  workspaceId: string;
  workspacePath: string;
  workspaceBranch: string;
  repoId: string;
};

export type ResolveUndeployHookInput = {
  workspacePath: string;
};

export function resolveUndeployHook(input: ResolveUndeployHookInput): UndeployHookResolution {
  const filePath = path.join(input.workspacePath, UNDEPLOY_HOOK_RELATIVE_PATH);
  const status = inspectHookFile(filePath);
  if (status === "executable") {
    return { source: "repo-file", filePath, note: null };
  }
  return {
    source: "none",
    filePath: null,
    note: status === "exists-not-executable" ? notExecutableNote(filePath) : null,
  };
}

function spawnUndeployHook(
  resolution: UndeployHookResolution,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached?: boolean },
): ChildProcess {
  if (resolution.source === "repo-file" && resolution.filePath) {
    return spawn(resolution.filePath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached ?? false,
    });
  }
  throw new Error("undeploy_hook_not_configured");
}

export function undeployHookEnv(input: UndeployHookEnv): NodeJS.ProcessEnv {
  return buildHookEnv(input);
}

export type UndeployStreamHandler = (input: { stream: "stdout" | "stderr"; chunk: string }) => void;

export type RunUndeployHookResult = {
  exitStatus: number | null;
  stdoutTail: string;
  stderrTail: string;
};

export function runUndeployHook(input: {
  resolution: UndeployHookResolution;
  env: UndeployHookEnv;
  appName?: string | undefined;
  onOutput?: UndeployStreamHandler;
  signal?: AbortSignal;
}): Promise<RunUndeployHookResult> {
  const args = input.appName ? [input.appName] : [];
  const child = spawnUndeployHook(input.resolution, args, {
    cwd: input.env.workspacePath,
    env: undeployHookEnv(input.env),
  });
  return new Promise<RunUndeployHookResult>((resolve, reject) => {
    let stdoutTail = "";
    let stderrTail = "";
    const abortHandler = () => {
      child.kill("SIGTERM");
    };
    if (input.signal) {
      if (input.signal.aborted) abortHandler();
      else input.signal.addEventListener("abort", abortHandler, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdoutTail = `${stdoutTail}${text}`.slice(-32_768);
      input.onOutput?.({ stream: "stdout", chunk: text });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-32_768);
      input.onOutput?.({ stream: "stderr", chunk: text });
    });
    child.on("error", (error) => {
      input.signal?.removeEventListener("abort", abortHandler);
      reject(error);
    });
    child.on("close", (code) => {
      input.signal?.removeEventListener("abort", abortHandler);
      resolve({ exitStatus: code, stdoutTail, stderrTail });
    });
  });
}
