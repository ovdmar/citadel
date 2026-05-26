import fs from "node:fs";

// Shared utilities for file-discovered hooks (deploy + teardown). Kept in a
// dedicated module so the deploy/teardown contracts diverge in spawn/stream
// shape (where they genuinely differ) without diverging on the bits they
// share verbatim — file inspection and the CITADEL_* env contract.

export type HookFileStatus = "executable" | "exists-not-executable" | "missing";

export function inspectHookFile(filePath: string): HookFileStatus {
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

export function notExecutableNote(filePath: string): string {
  return `${filePath} exists but is not executable (run: chmod +x ${filePath})`;
}

export type HookEnvInput = {
  workspaceId: string;
  workspacePath: string;
  workspaceBranch: string;
  repoId: string;
};

// Builds the CITADEL_* env block passed to every file-discovered hook
// (deploy + teardown). Single source of truth for the hook env contract.
export function buildHookEnv(input: HookEnvInput): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CITADEL_WORKSPACE_ID: input.workspaceId,
    CITADEL_WORKSPACE_PATH: input.workspacePath,
    CITADEL_WORKSPACE_BRANCH: input.workspaceBranch,
    CITADEL_REPO_ID: input.repoId,
  };
}
