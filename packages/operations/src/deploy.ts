import type {
  ActivityEvent,
  DeployHookResolution,
  DeployedApp,
  DeployedAppStatus,
  DeployedAppsSummary,
  Operation,
  Repo,
  Workspace,
} from "@citadel/contracts";
import { nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import {
  buildDeployedApps,
  probeAppStatus,
  resolveDeployHook,
  runDeployHookList,
  runDeployHookRedeploy,
} from "@citadel/hooks";

export type DeployOpsDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
  newOperation: (
    type: string,
    status: Operation["status"],
    repoId: string | null,
    workspaceId: string | null,
    progress: number,
    message: string,
  ) => Operation;
};

function resolutionFor(repo: Repo, workspace: Workspace): DeployHookResolution {
  return resolveDeployHook({
    workspacePath: workspace.path,
    repoDeployCommand: repo.deployHookCommand,
  });
}

function envFor(repo: Repo, workspace: Workspace) {
  return {
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    workspaceBranch: workspace.branch,
    repoId: repo.id,
  };
}

export async function listDeployedApps(
  _deps: DeployOpsDeps,
  input: { repo: Repo; workspace: Workspace },
): Promise<DeployedAppsSummary> {
  const checkedAt = nowIso();
  const resolution = resolutionFor(input.repo, input.workspace);
  if (resolution.source === "none") {
    return {
      workspaceId: input.workspace.id,
      resolution,
      apps: [],
      error:
        "No deploy hook configured. Add .citadel/hooks/deploy in the worktree or set a deploy command in repo settings.",
      checkedAt,
    };
  }
  let apps: DeployedApp[] = [];
  let error: string | null = null;
  try {
    const result = await runDeployHookList({ resolution, env: envFor(input.repo, input.workspace) });
    const statuses = new Map<string, DeployedAppStatus>();
    await Promise.all(
      result.parsed.apps.map(async (app) => {
        statuses.set(app.name, await probeAppStatus(app.url));
      }),
    );
    apps = buildDeployedApps({
      workspaceId: input.workspace.id,
      list: result.parsed,
      statuses,
      lastChecked: checkedAt,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "deploy_hook_list_failed";
  }
  return {
    workspaceId: input.workspace.id,
    resolution,
    apps,
    error,
    checkedAt,
  };
}

export async function redeployApp(
  deps: DeployOpsDeps,
  input: { repo: Repo; workspace: Workspace; appName?: string | undefined },
): Promise<{ operationId: string; status: "succeeded" | "failed"; exitStatus: number | null }> {
  const label = input.appName ? `Redeploy ${input.appName}` : "Redeploy all apps";
  const operation = deps.newOperation(
    "workspace.deploy.redeploy",
    "running",
    input.repo.id,
    input.workspace.id,
    10,
    label,
  );
  const resolution = resolutionFor(input.repo, input.workspace);
  if (resolution.source === "none") {
    deps.store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: "deploy_hook_not_configured",
      updatedAt: nowIso(),
    });
    return { operationId: operation.id, status: "failed", exitStatus: null };
  }
  try {
    const result = await runDeployHookRedeploy({
      resolution,
      env: envFor(input.repo, input.workspace),
      appName: input.appName,
      onOutput: ({ stream, chunk }) => {
        const text = chunk.replace(/\s+$/, "");
        if (!text) return;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          deps.store.appendOperationLog(operation.id, {
            level: stream === "stderr" ? "warn" : "info",
            message: line.slice(0, 4_000),
            at: nowIso(),
          });
        }
      },
    });
    const ok = result.exitStatus === 0;
    deps.store.upsertOperation({
      ...operation,
      status: ok ? "succeeded" : "failed",
      progress: 100,
      message: ok ? `${label} dispatched` : `${label} exited ${result.exitStatus}`,
      error: ok ? null : result.stderrTail.trim().slice(-1000) || `deploy_hook_exit_${result.exitStatus}`,
      retriable: !ok,
      retryInput: ok
        ? null
        : { kind: "deploy.redeploy", workspaceId: input.workspace.id, appName: input.appName ?? null },
      updatedAt: nowIso(),
    });
    deps.activity(
      ok ? "deploy.redeploy" : "deploy.redeploy.failed",
      "user",
      ok ? `${label} dispatched via ${resolution.source}` : `${label} failed (exit ${result.exitStatus})`,
      input.repo.id,
      input.workspace.id,
      operation.id,
    );
    return { operationId: operation.id, status: ok ? "succeeded" : "failed", exitStatus: result.exitStatus };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "deploy_hook_redeploy_failed";
    deps.store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: message,
      retriable: true,
      retryInput: { kind: "deploy.redeploy", workspaceId: input.workspace.id, appName: input.appName ?? null },
      updatedAt: nowIso(),
    });
    deps.activity(
      "deploy.redeploy.failed",
      "user",
      `${label} failed: ${message}`,
      input.repo.id,
      input.workspace.id,
      operation.id,
    );
    return { operationId: operation.id, status: "failed", exitStatus: null };
  }
}
