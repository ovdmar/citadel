import type { Operation, Repo, Workspace } from "@citadel/contracts";
import { resolveTeardownHook, runTeardownHook } from "@citadel/hooks";

type TeardownPhaseOutcome = { kind: "ok" } | { kind: "blocked"; error: string; activityMessage: string };

// Runs the full teardown phase for removeWorkspace: file-based hook first,
// then configured hooks. Returns "blocked" when force=false AND a hook
// failed — caller marks the operation failed and exits without touching tmux
// or the worktree.
export async function runTeardownPhase(input: {
  workspace: Workspace;
  repo: Repo;
  operation: Operation;
  force: boolean;
  hookTimeoutMs?: number;
  deps: FileTeardownDeps & {
    runConfiguredTeardown: () => Promise<void>;
  };
}): Promise<TeardownPhaseOutcome> {
  const { workspace, repo, operation, force, hookTimeoutMs, deps } = input;
  const fileOutcome = await runFileTeardown({
    workspace,
    repo,
    operation,
    force,
    ...(hookTimeoutMs !== undefined ? { hookTimeoutMs } : {}),
    deps,
  });
  if (fileOutcome.kind === "failed-blocked") {
    return {
      kind: "blocked",
      error: fileOutcome.error,
      activityMessage: `Removal blocked because file teardown failed for ${workspace.name}`,
    };
  }
  if (fileOutcome.kind === "failed-continue") {
    deps.logOp(operation.id, "warn", fileOutcome.logMessage);
  }

  try {
    deps.logOp(
      operation.id,
      "info",
      `Running ${repo.teardownHookIds.length} teardown hook(s): ${repo.teardownHookIds.join(", ") || "(none)"}`,
    );
    await deps.runConfiguredTeardown();
  } catch (error) {
    const message = error instanceof Error ? error.message : "workspace_teardown_failed";
    if (!force) {
      return {
        kind: "blocked",
        error: `configured teardown failed: ${message}`,
        activityMessage: `Removal blocked because teardown failed for ${workspace.name}`,
      };
    }
    // force=true previously swallowed silently; now leave a warning trail.
    deps.logOp(
      operation.id,
      "warn",
      `[teardown] configured teardown failed: ${message.slice(0, 500)}; continuing because force=true`,
    );
  }
  return { kind: "ok" };
}

type FileTeardownOutcome =
  | { kind: "skipped" }
  | { kind: "succeeded" }
  | { kind: "failed-continue"; logMessage: string }
  | { kind: "failed-blocked"; error: string };

type FileTeardownDeps = {
  exists: (path: string) => boolean;
  logOp: (operationId: string, level: "info" | "warn" | "error", message: string) => void;
  activity: (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
};

// Runs the file-based teardown hook (`.citadel/hooks/teardown`) per the plan's
// 3-state contract: absent → skip; failed + !force → fail without touching
// downstream state; failed + force → log warning and continue. Streamed output
// is appended to the operation log with a `[teardown]` prefix.
//
// Kept in its own module so the OperationService entry point stays under the
// 800-line architectural cap.
async function runFileTeardown(input: {
  workspace: Workspace;
  repo: Repo;
  operation: Operation;
  force: boolean;
  hookTimeoutMs?: number;
  deps: FileTeardownDeps;
}): Promise<FileTeardownOutcome> {
  const { workspace, repo, operation, force, hookTimeoutMs, deps } = input;
  // Re-check existence immediately before resolution — protects against any
  // future refactor that prunes the worktree before this point.
  if (!deps.exists(workspace.path)) return { kind: "skipped" };
  const resolution = resolveTeardownHook({ workspacePath: workspace.path });
  if (resolution.source !== "repo-file") return { kind: "skipped" };

  deps.logOp(operation.id, "info", "[teardown] running .citadel/hooks/teardown");
  let exitStatus: number | null = null;
  let stderrTail = "";
  try {
    const result = await runTeardownHook({
      resolution,
      env: {
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        workspaceBranch: workspace.branch ?? "",
        repoId: repo.id,
      },
      ...(hookTimeoutMs !== undefined ? { timeoutMs: hookTimeoutMs } : {}),
      onOutput: ({ stream, chunk }) => {
        deps.logOp(operation.id, stream === "stderr" ? "warn" : "info", `[teardown] ${chunk}`);
      },
    });
    exitStatus = result.exitStatus;
    stderrTail = result.stderrTail;
  } catch (error) {
    stderrTail = error instanceof Error ? error.message : "teardown_hook_failed";
  }

  if (exitStatus === 0) {
    deps.activity(
      "workspace.teardown.file",
      "hook",
      `File teardown completed for ${workspace.name}`,
      workspace.repoId,
      workspace.id,
      operation.id,
    );
    return { kind: "succeeded" };
  }

  if (!force) {
    const detail = stderrTail.trim().slice(-1000) || `exit ${exitStatus ?? "?"}`;
    deps.activity(
      "workspace.teardown.file.failed",
      "hook",
      `File teardown failed for ${workspace.name} (exit ${exitStatus ?? "?"})`,
      workspace.repoId,
      workspace.id,
      operation.id,
    );
    return { kind: "failed-blocked", error: `file teardown failed: ${detail}` };
  }

  const detail = stderrTail.trim().slice(-500) || `exit ${exitStatus ?? "?"}`;
  deps.activity(
    "workspace.teardown.file.failed",
    "hook",
    `File teardown failed but force=true for ${workspace.name}`,
    workspace.repoId,
    workspace.id,
    operation.id,
  );
  return {
    kind: "failed-continue",
    logMessage: `[teardown] file teardown failed (${exitStatus ?? "?"}): ${detail}; continuing because force=true`,
  };
}
