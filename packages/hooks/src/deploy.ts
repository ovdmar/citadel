import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import {
  type DeployHookListOutput,
  DeployHookListOutputSchema,
  type DeployHookResolution,
  type DeployedApp,
  type DeployedAppStatus,
} from "@citadel/contracts";
import { buildHookEnv, inspectHookFile, notExecutableNote } from "./file-hook-shared.js";

// The deploy hook contract:
//
//   `<hook> list`            → stdout: { "apps": [ { "name": string, "url": string } ] }
//   `<hook> redeploy [name]` → starts the redeploy; stdout/stderr are streamed
//
// The hook is invoked with cwd = workspacePath and these env vars:
//   CITADEL_WORKSPACE_ID, CITADEL_WORKSPACE_PATH, CITADEL_WORKSPACE_BRANCH, CITADEL_REPO_ID

export const DEPLOY_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "deploy");

export type DeployHookEnv = {
  workspaceId: string;
  workspacePath: string;
  workspaceBranch: string;
  repoId: string;
};

export type ResolveDeployHookInput = {
  workspacePath: string;
  repoDeployCommand?: string | null;
};

export function resolveDeployHook(input: ResolveDeployHookInput): DeployHookResolution {
  const filePath = path.join(input.workspacePath, DEPLOY_HOOK_RELATIVE_PATH);
  const status = inspectHookFile(filePath);
  if (status === "executable") {
    return { source: "repo-file", filePath, command: null, note: null };
  }
  const cmd = (input.repoDeployCommand ?? "").trim();
  // Surface a diagnostic so users discover the missing chmod +x instead of
  // silently seeing the empty-state panel.
  const skipNote = status === "exists-not-executable" ? notExecutableNote(filePath) : null;
  if (cmd.length) {
    const note = skipNote ? `${skipNote}; using repo-config fallback` : null;
    return { source: "repo-config", filePath: null, command: cmd, note };
  }
  return { source: "none", filePath: null, command: null, note: skipNote };
}

function spawnDeployHook(
  resolution: DeployHookResolution,
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
  if (resolution.source === "repo-config" && resolution.command) {
    // Pass args as positional ($1, $2). Hook authors branch on $1.
    return spawn("bash", ["-c", `${resolution.command} "$@"`, "_citadel_deploy", ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.detached ?? false,
    });
  }
  throw new Error("deploy_hook_not_configured");
}

export function deployHookEnv(input: DeployHookEnv): NodeJS.ProcessEnv {
  return buildHookEnv(input);
}

export type RunDeployListResult = {
  stdout: string;
  stderr: string;
  exitStatus: number | null;
  parsed: DeployHookListOutput;
};

export async function runDeployHookList(input: {
  resolution: DeployHookResolution;
  env: DeployHookEnv;
  timeoutMs?: number;
}): Promise<RunDeployListResult> {
  const timeoutMs = input.timeoutMs ?? 10_000;
  const child = spawnDeployHook(input.resolution, ["list"], {
    cwd: input.env.workspacePath,
    env: deployHookEnv(input.env),
  });
  return new Promise<RunDeployListResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`deploy_hook_list_timeout_${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-32_768);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-32_768);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`deploy_hook_list_exit_${code}: ${stderr.trim() || stdout.trim() || "no_output"}`));
        return;
      }
      try {
        const parsed = parseDeployListOutput(stdout);
        resolve({ stdout, stderr, exitStatus: code, parsed });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function parseDeployListOutput(stdout: string): DeployHookListOutput {
  const trimmed = stdout.trim();
  // Empty stdout is treated as a misconfigured hook — silently returning an
  // empty list lets typo'd or half-implemented hooks look healthy.
  if (!trimmed) throw new Error('deploy_hook_list_empty: hook printed nothing (expected `{"apps":[...]}`)');
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`deploy_hook_list_invalid_json: ${error instanceof Error ? error.message : "json_parse_failed"}`);
  }
  return DeployHookListOutputSchema.parse(payload);
}

export type RedeployStreamHandler = (input: { stream: "stdout" | "stderr"; chunk: string }) => void;

export type RunDeployRedeployResult = {
  exitStatus: number | null;
  stdoutTail: string;
  stderrTail: string;
};

// Spawn the redeploy subcommand and stream its output to the caller.
// We deliberately do not enforce a timeout — redeploys can be long.
export function runDeployHookRedeploy(input: {
  resolution: DeployHookResolution;
  env: DeployHookEnv;
  appName?: string | undefined;
  onOutput?: RedeployStreamHandler;
  signal?: AbortSignal;
}): Promise<RunDeployRedeployResult> {
  const args = ["redeploy"];
  if (input.appName) args.push(input.appName);
  const child = spawnDeployHook(input.resolution, args, {
    cwd: input.env.workspacePath,
    env: deployHookEnv(input.env),
  });
  return new Promise<RunDeployRedeployResult>((resolve, reject) => {
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

// TCP-only port probe. We deliberately don't probe HTTP (some apps speak gRPC
// or websockets); a listening socket means "something is bound". Returns
// "deployed" when the connect succeeds, "stopped" on refused/timeout, and
// "unknown" if the URL is unparseable.
export async function probeAppStatus(url: string, timeoutMs = 800): Promise<DeployedAppStatus> {
  const target = parseHostPort(url);
  if (!target) return "unknown";
  return new Promise<DeployedAppStatus>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (status: DeployedAppStatus) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("deployed"));
    socket.once("timeout", () => finish("stopped"));
    socket.once("error", () => finish("stopped"));
    try {
      socket.connect(target.port, target.host);
    } catch {
      finish("stopped");
    }
  });
}

function parseHostPort(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url);
    const defaultPort = parsed.protocol === "https:" ? 443 : 80;
    const port = parsed.port ? Number(parsed.port) : defaultPort;
    if (!Number.isFinite(port) || port <= 0 || port > 65_535) return null;
    return { host: parsed.hostname || "127.0.0.1", port };
  } catch {
    return null;
  }
}

export function buildDeployedApps(input: {
  workspaceId: string;
  list: DeployHookListOutput;
  statuses: Map<string, DeployedAppStatus>;
  lastChecked: string;
}): DeployedApp[] {
  return input.list.apps.map((app) => ({
    workspaceId: input.workspaceId,
    name: app.name,
    url: app.url,
    status: input.statuses.get(app.name) ?? "unknown",
    lastChecked: input.lastChecked,
  }));
}
