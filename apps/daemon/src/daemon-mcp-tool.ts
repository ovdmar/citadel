import fs from "node:fs";
import type { CitadelConfig } from "@citadel/config";
import {
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateScheduledAgentInputSchema,
  CreateWorkspaceInputSchema,
  LaunchAgentInputSchema,
  UpdateScheduledAgentInputSchema,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type McpToolCall, callMcpTool, serializeWorkspaceResource } from "@citadel/mcp";
import type { OperationService, ScheduledAgentRunner } from "@citadel/operations";
import { collectProviderHealth } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type { TtydManager } from "@citadel/terminal";
import type { ScheduledAgentService } from "./scheduled-agent-service.js";
import { ScratchpadTooLargeError, appendScratchpad, readScratchpad, writeScratchpad } from "./scratchpad.js";

export type DaemonMcpDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  ttyd: TtydManager;
  scheduledAgents: ScheduledAgentRunner;
  scheduledAgentService: ScheduledAgentService;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  emit: (type: string, payload: unknown) => void;
};

export function workspaceResource(store: SqliteStore) {
  return serializeWorkspaceResource({
    repos: store.listRepos(),
    workspaces: store.listWorkspaces(),
    sessions: store.listSessions(),
  });
}

export async function readMcpResource(store: SqliteStore, config: CitadelConfig, uri: string) {
  if (uri === "citadel://repos") return { repos: store.listRepos() };
  if (uri === "citadel://workspaces") return workspaceResource(store);
  if (uri === "citadel://provider-health") return { providerHealth: await collectProviderHealth(config.providers) };
  if (uri === "citadel://activity") return { activity: store.listActivity() };
  return null;
}

export async function callDaemonMcpTool(deps: DaemonMcpDeps, call: McpToolCall) {
  const { config, store, operations, ttyd, scheduledAgents, scheduledAgentService, providerCache, emit } = deps;
  if (call.name === "register_repo") {
    const input = CreateRepoInputSchema.parse(call.arguments ?? {});
    const repo = operations.registerRepo(input);
    emit("repo.updated", { repoId: repo.id, repo });
    return { repo };
  }
  if (call.name === "create_workspace") {
    const result = await operations.createWorkspace(CreateWorkspaceInputSchema.parse(call.arguments ?? {}));
    emit("workspace.updated", result);
    return result;
  }
  if (call.name === "start_agent_session") {
    const input = CreateAgentSessionInputSchema.parse(call.arguments ?? {});
    const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    const session = await operations.createAgentSession(input, {
      command: runtime.command,
      args: runtime.args,
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? null,
    });
    emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
    return { session };
  }
  if (call.name === "launch_agent") {
    const input = LaunchAgentInputSchema.parse(call.arguments ?? {});
    const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    const result = await operations.launchAgent(input, {
      command: runtime.command,
      args: runtime.args,
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? null,
    });
    emit("workspace.updated", { workspaceId: result.workspaceId, operationId: result.operationId });
    if (result.sessionId) emit("agent.updated", { workspaceId: result.workspaceId, sessionId: result.sessionId });
    return result;
  }
  if (call.name === "stop_agent_session") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? (call.arguments.sessionId as string) : "";
    const result = operations.stopAgentSession({ sessionId });
    ttyd.release(sessionId);
    emit("agent.updated", { sessionId });
    return result;
  }
  if (call.name === "remove_workspace") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? (call.arguments.workspaceId as string) : "";
    const force = call.arguments?.force === true;
    const archiveOnly = call.arguments?.archiveOnly === true;
    const result = await operations.removeWorkspace({ workspaceId, force, archiveOnly });
    emit("workspace.updated", result);
    return result;
  }
  if (call.name === "reconcile") {
    const result = operations.reconcile();
    providerCache.clear();
    emit("state.reconciled", result);
    return result;
  }
  if (call.name === "archive_workspace") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    const result = await operations.removeWorkspace({ workspaceId, archiveOnly: true });
    emit("workspace.updated", result);
    return result;
  }
  if (call.name === "read_agent_output") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    const input: { sessionId: string; lines?: number; maxChars?: number } = { sessionId };
    if (typeof call.arguments?.lines === "number") input.lines = call.arguments.lines;
    if (typeof call.arguments?.maxChars === "number") input.maxChars = call.arguments.maxChars;
    return operations.readAgentTranscript(input);
  }
  if (call.name === "read_scratchpad") {
    return readScratchpad(config.dataDir);
  }
  if (call.name === "write_scratchpad") {
    if (typeof call.arguments?.content !== "string") return { error: "content_required" };
    try {
      const snapshot = writeScratchpad(config.dataDir, call.arguments.content);
      emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof ScratchpadTooLargeError) return { error: error.message, limit: error.limit };
      throw error;
    }
  }
  if (call.name === "append_scratchpad") {
    if (typeof call.arguments?.content !== "string" || call.arguments.content === "") {
      return { error: "content_required" };
    }
    try {
      const snapshot = appendScratchpad(config.dataDir, call.arguments.content);
      emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof ScratchpadTooLargeError) return { error: error.message, limit: error.limit };
      throw error;
    }
  }
  if (call.name === "list_deployed_apps") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    if (!workspaceId) return { error: "workspace_id_required" };
    return operations.listDeployedApps({ workspaceId });
  }
  if (call.name === "redeploy_app") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    if (!workspaceId) return { error: "workspace_id_required" };
    const name = typeof call.arguments?.name === "string" ? call.arguments.name : undefined;
    const result = await operations.redeployApp({ workspaceId, appName: name });
    emit("workspace.deploy.redeploy", { workspaceId, operationId: result.operationId, status: result.status });
    return result;
  }
  if (call.name === "send_agent_message") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    const message = typeof call.arguments?.message === "string" ? call.arguments.message : "";
    if (!sessionId) return { ok: false, error: "session_id_required" };
    if (!message) return { ok: false, error: "message_required" };
    const result = await operations.sendAgentMessage({ sessionId, message });
    if (result.ok) emit("agent.updated", { sessionId });
    return result;
  }
  if (call.name === "read_agent_history") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    if (!sessionId) return { ok: false, error: "session_id_required" };
    const input: { sessionId: string; limit?: number; maxChars?: number } = { sessionId };
    if (typeof call.arguments?.limit === "number") input.limit = call.arguments.limit;
    if (typeof call.arguments?.maxChars === "number") input.maxChars = call.arguments.maxChars;
    return operations.readAgentHistory(input);
  }
  if (call.name === "create_scheduled_agent") {
    const parsed = CreateScheduledAgentInputSchema.parse(call.arguments ?? {});
    const result = scheduledAgentService.create(parsed);
    return result.ok ? { scheduledAgent: result.value } : { error: result.error };
  }
  if (call.name === "update_scheduled_agent") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const { id: _ignored, ...rest } = (call.arguments ?? {}) as Record<string, unknown>;
    const parsed = UpdateScheduledAgentInputSchema.parse(rest);
    const result = scheduledAgentService.update(id, parsed);
    return result.ok ? { scheduledAgent: result.value } : { error: result.error };
  }
  if (call.name === "delete_scheduled_agent") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const result = scheduledAgentService.delete(id);
    return result.ok ? { removed: true } : { error: result.error };
  }
  if (call.name === "run_scheduled_agent_now") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const result = await scheduledAgentService.runNow(id);
    if (!result.ok) return { error: result.error };
    const value = result.value;
    if (value.kind === "ran") {
      return {
        status: value.status,
        runId: value.runId,
        message: value.message,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        backgroundSessionId: value.backgroundSessionId,
        scheduledAgent: value.scheduledAgent,
      };
    }
    if (value.kind === "queued") {
      return {
        queued: true,
        runId: value.runId,
        queuePosition: value.queuePosition,
        scheduledAgent: value.scheduledAgent,
      };
    }
    if (value.kind === "skipped_overlap") {
      return { error: "run_already_in_progress", scheduledAgent: value.scheduledAgent };
    }
    return { error: "queue_full", limit: value.limit, scheduledAgent: value.scheduledAgent };
  }
  if (call.name === "list_scheduled_agent_runs") {
    const agentId = typeof call.arguments?.scheduledAgentId === "string" ? call.arguments.scheduledAgentId : "";
    if (!agentId) return { error: "scheduled_agent_id_required" };
    if (!scheduledAgents.find(agentId)) return { error: "scheduled_agent_not_found" };
    const limit = Math.max(1, Math.min(typeof call.arguments?.limit === "number" ? call.arguments.limit : 50, 500));
    const offset = Math.max(0, typeof call.arguments?.offset === "number" ? call.arguments.offset : 0);
    return { runs: store.listScheduledAgentRuns(agentId, { limit, offset }) };
  }
  if (call.name === "read_scheduled_agent_run_log") {
    const runId = typeof call.arguments?.runId === "string" ? call.arguments.runId : "";
    if (!runId) return { error: "run_id_required" };
    const run = store.findScheduledAgentRun(runId);
    if (!run) return { error: "run_not_found" };
    if (!run.logFilePath) return { error: "log_not_available" };
    const offset = Math.max(0, typeof call.arguments?.offset === "number" ? call.arguments.offset : 0);
    const maxBytes = Math.max(
      256,
      Math.min(typeof call.arguments?.maxBytes === "number" ? call.arguments.maxBytes : 16_000, 200_000),
    );
    try {
      const fd = fs.openSync(run.logFilePath, "r");
      try {
        const stat = fs.fstatSync(fd);
        const start = Math.min(offset, stat.size);
        const length = Math.min(maxBytes, Math.max(0, stat.size - start));
        const buffer = Buffer.alloc(length);
        const bytesRead = length > 0 ? fs.readSync(fd, buffer, 0, length, start) : 0;
        return {
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          bytesRead,
          nextOffset: start + bytesRead,
          truncated: start + bytesRead < stat.size,
        };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { error: "log_file_missing" };
    }
  }
  const providerHealth = await collectProviderHealth(config.providers);
  return callMcpTool(call, {
    repos: store.listRepos(),
    workspaces: store.listWorkspaces(),
    sessions: store.listSessions(),
    operations: store.listOperations(),
    activity: store.listActivity(),
    providerHealth,
    runtimes: listRuntimeHealth(config.runtimes),
    scheduledAgents: scheduledAgents.list(),
    // Per-session summary comes from the runtime's own transcript via the
    // adapter dispatcher. mtime pre-filter inside each adapter keeps list
    // calls cheap even on big project dirs.
    sessionPromptSummary: (sessionId) => operations.getSessionPromptSummary(sessionId),
  });
}
