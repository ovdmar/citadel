import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CITADEL_NON_FF_POLICY } from "./non-ff-policy.js";

// The fix-conflicts hook contract:
//
//   `<hook>` (no args) → stdout: the prompt body to feed to the fix-conflicts
//   agent. The hook is invoked with cwd = workspacePath and the same env vars
//   as the deploy hook.
//
// When the hook is absent or non-executable, FIX_CONFLICTS_DEFAULT_PROMPT is
// used instead.

export const FIX_CONFLICTS_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "fixconflicts");

// Hook stdout cap. Matches the deploy hook's 32 KB precedent so the limit
// surfaces from a single place if it ever changes.
const FIX_CONFLICTS_STDOUT_CAP = 32 * 1024;

const FIX_CONFLICTS_SPAWN_TIMEOUT_MS = 10_000;

export const FIX_CONFLICTS_DEFAULT_PROMPT = [
  "Your branch has merge conflicts with main and the PR cannot be merged.",
  "",
  "Resolve them by:",
  "1. Run `git pull origin main` from this worktree. Use merge — NOT rebase.",
  `   ${CITADEL_NON_FF_POLICY}`,
  "2. Open each conflicted file and resolve the conflict markers carefully.",
  "   Preserve both sides' intent; do not delete tests, types, or specs to make",
  "   conflicts disappear.",
  "3. Run `make check` (or the minimal subset relevant to the conflict area).",
  '4. Commit with a focused message ("merge main into <branch>") and `git push`.',
  "",
  "If `git push` reports non-fast-forward after the merge, repeat from step 1.",
  "Never `--force` or `--force-with-lease`. When `gh pr view` reports",
  "mergeable=MERGEABLE again, stop and report back what was resolved.",
].join("\n");

export type FixConflictsHookEnv = {
  workspaceId: string;
  workspacePath: string;
  workspaceBranch: string;
  repoId: string;
};

export type ResolveFixConflictsPromptResult = {
  source: "hook" | "default";
  prompt: string;
  // Non-null when the hook exists-but-not-executable or fails to spawn.
  diagnostic: string | null;
};

export async function resolveFixConflictsPrompt(env: FixConflictsHookEnv): Promise<ResolveFixConflictsPromptResult> {
  const filePath = path.join(env.workspacePath, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
  const status = inspectHookFile(filePath);
  if (status === "missing") {
    return { source: "default", prompt: FIX_CONFLICTS_DEFAULT_PROMPT, diagnostic: null };
  }
  if (status === "exists-not-executable") {
    return {
      source: "default",
      prompt: FIX_CONFLICTS_DEFAULT_PROMPT,
      diagnostic: `${filePath} exists but is not executable (run: chmod +x ${filePath})`,
    };
  }
  try {
    const stdout = await runFixConflictsHook(filePath, env);
    const cleaned = normalizeHookStdout(stdout);
    if (!cleaned) {
      return {
        source: "default",
        prompt: FIX_CONFLICTS_DEFAULT_PROMPT,
        diagnostic: `${filePath} produced empty output; falling back to default`,
      };
    }
    return { source: "hook", prompt: cleaned, diagnostic: null };
  } catch (error) {
    return {
      source: "default",
      prompt: FIX_CONFLICTS_DEFAULT_PROMPT,
      diagnostic: `${filePath} failed: ${error instanceof Error ? error.message : "unknown_error"}`,
    };
  }
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

function fixConflictsHookEnv(env: FixConflictsHookEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CITADEL_WORKSPACE_ID: env.workspaceId,
    CITADEL_WORKSPACE_PATH: env.workspacePath,
    CITADEL_WORKSPACE_BRANCH: env.workspaceBranch,
    CITADEL_REPO_ID: env.repoId,
  };
}

function runFixConflictsHook(filePath: string, env: FixConflictsHookEnv): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(filePath, [], {
      cwd: env.workspacePath,
      env: fixConflictsHookEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`fix_conflicts_hook_timeout_${FIX_CONFLICTS_SPAWN_TIMEOUT_MS}ms`));
    }, FIX_CONFLICTS_SPAWN_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-FIX_CONFLICTS_STDOUT_CAP);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-FIX_CONFLICTS_STDOUT_CAP);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`fix_conflicts_hook_exit_${code}: ${stderr.trim() || "no_stderr"}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// Strip ANSI escape sequences and trim — hook authors might colorize output
// for their own shell debugging without realizing it ends up as a prompt.
function normalizeHookStdout(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
}
