import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TeardownHookResolution } from "@citadel/contracts";

// The teardown hook contract:
//
//   `<hook>`  → runs once with no subcommand; stdout/stderr are streamed.
//                Exit 0 = success. Exit ≠ 0 = failure (operator can override
//                with force-remove; see packages/operations removeWorkspace).
//
// Invoked with cwd = workspacePath and these env vars:
//   CITADEL_WORKSPACE_ID, CITADEL_WORKSPACE_PATH, CITADEL_WORKSPACE_BRANCH, CITADEL_REPO_ID

export const TEARDOWN_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "teardown");

export type TeardownHookEnv = {
  workspaceId: string;
  workspacePath: string;
  workspaceBranch: string;
  repoId: string;
};

export type ResolveTeardownHookInput = {
  workspacePath: string;
};

export function resolveTeardownHook(input: ResolveTeardownHookInput): TeardownHookResolution {
  const filePath = path.join(input.workspacePath, TEARDOWN_HOOK_RELATIVE_PATH);
  const status = inspectHookFile(filePath);
  if (status === "executable") {
    return { source: "repo-file", filePath, note: null };
  }
  // Mirror deploy's diagnostic so operators discover a missing chmod +x
  // instead of silently treating an existing-but-not-executable file as absent.
  const note =
    status === "exists-not-executable" ? `${filePath} exists but is not executable (run: chmod +x ${filePath})` : null;
  return { source: "none", filePath: null, note };
}

type HookFileStatus = "executable" | "exists-not-executable" | "missing";

function inspectHookFile(filePath: string): HookFileStatus {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "missing";
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return "executable";
    } catch {
      return "exists-not-executable";
    }
  } catch {
    return "missing";
  }
}

export type TeardownStreamHandler = (input: { stream: "stdout" | "stderr"; chunk: string }) => void;

export type RunTeardownHookResult = {
  exitStatus: number | null;
  stderrTail: string;
};

function teardownHookEnv(input: TeardownHookEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CITADEL_WORKSPACE_ID: input.workspaceId,
    CITADEL_WORKSPACE_PATH: input.workspacePath,
    CITADEL_WORKSPACE_BRANCH: input.workspaceBranch,
    CITADEL_REPO_ID: input.repoId,
  };
}

// Default timeout for teardown hooks. Matches the order of magnitude of
// commandPolicy.hookTimeoutMs (120000) but is a per-call override so the
// operations layer can pass its own value once it threads commandPolicy.
const DEFAULT_TEARDOWN_TIMEOUT_MS = 120_000;

export function runTeardownHook(input: {
  resolution: TeardownHookResolution;
  env: TeardownHookEnv;
  onOutput?: TeardownStreamHandler;
  timeoutMs?: number;
}): Promise<RunTeardownHookResult> {
  if (input.resolution.source !== "repo-file" || !input.resolution.filePath) {
    return Promise.reject(new Error("teardown_hook_not_configured"));
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  const child = spawn(input.resolution.filePath, [], {
    cwd: input.env.workspacePath,
    env: teardownHookEnv(input.env),
    // ignore stdin and pipe stdout/stderr only. detached:true puts the hook in
    // its own process group so a timeout SIGKILL can reach grandchildren (a
    // bash hook + `sleep 5` would otherwise survive a kill targeted at the
    // bash pid). Hooks that explicitly background work (e.g.
    // `(daemon >/dev/null 2>&1 </dev/null &)`) detach themselves from our
    // pipes and can outlive normal exit; the close event fires when our
    // direct child exits.
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  return new Promise<RunTeardownHookResult>((resolve) => {
    let stderrTail = "";
    let settled = false;
    const finish = (exitStatus: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ exitStatus, stderrTail });
    };
    // SIGKILL on timeout. SIGTERM-then-SIGKILL would be nicer but for a
    // teardown hook that's hung we want a hard guarantee — the operator chose
    // to remove the workspace and we promised to either succeed or fail loudly.
    const killTimer = setTimeout(() => {
      // Negative pid targets the whole process group created by detached:true.
      // Falls back to killing just the direct child if the group kill fails.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // child may have exited between the timer firing and the kill call
        }
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().replace(/\s+$/, "");
      if (!text) return;
      for (const line of text.split("\n")) {
        if (!line) continue;
        input.onOutput?.({ stream: "stdout", chunk: line });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-32_768);
      const trimmed = text.replace(/\s+$/, "");
      if (!trimmed) return;
      for (const line of trimmed.split("\n")) {
        if (!line) continue;
        input.onOutput?.({ stream: "stderr", chunk: line });
      }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}
