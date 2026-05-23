import type { CitadelConfig } from "@citadel/config";
import {
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateWorkspaceInputSchema,
  LaunchAgentInputSchema,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type McpToolCall, callMcpTool, serializeWorkspaceResource } from "@citadel/mcp";
import type { OperationService } from "@citadel/operations";
import { collectProviderHealth } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type { TtydManager } from "@citadel/terminal";
import { appendScratchpad, readScratchpad, writeScratchpad } from "./scratchpad.js";

export type DaemonMcpDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  ttyd: TtydManager;
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
  const { config, store, operations, ttyd, providerCache, emit } = deps;
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
    const content = typeof call.arguments?.content === "string" ? call.arguments.content : "";
    const snapshot = writeScratchpad(config.dataDir, content);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    return snapshot;
  }
  if (call.name === "append_scratchpad") {
    const content = typeof call.arguments?.content === "string" ? call.arguments.content : "";
    if (!content) return { error: "content_required" };
    const snapshot = appendScratchpad(config.dataDir, content);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    return snapshot;
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
  const providerHealth = await collectProviderHealth(config.providers);
  return callMcpTool(call, {
    repos: store.listRepos(),
    workspaces: store.listWorkspaces(),
    sessions: store.listSessions(),
    operations: store.listOperations(),
    activity: store.listActivity(),
    providerHealth,
    runtimes: listRuntimeHealth(config.runtimes),
  });
}
