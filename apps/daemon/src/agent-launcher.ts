import type { AgentDefinition, LaunchAgentInput, PredefinedAgentKind } from "@citadel/contracts";
import type { AgentDefinitionsStorage } from "./agent-definitions/storage.js";

export type ComposedLaunchInput = LaunchAgentInput;

// Compose the system-prompt-prepended LaunchAgentInput that the daemon will
// hand to operations.launchAgent. System prompt is prepended uniformly across
// all runtimes (no runtime-specific flags) so the composition is a single
// well-tested seam.
export function composeAgentLaunchInput(args: {
  definition: AgentDefinition;
  userPrompt: string;
  repoId?: string;
  repoName?: string;
  namespaceId?: string;
  displayName?: string;
  workspaceName?: string;
  branchName?: string;
  defaultRuntime?: string;
}): ComposedLaunchInput {
  const runtimeId = args.definition.runtime || args.defaultRuntime || "claude-code";
  const composed = `## System\n${args.definition.systemPrompt}\n\n## User prompt\n${args.userPrompt}`;
  const out: ComposedLaunchInput = { prompt: composed, runtimeId };
  if (args.repoId !== undefined) out.repoId = args.repoId;
  if (args.repoName !== undefined) out.repoName = args.repoName;
  if (args.namespaceId !== undefined) out.namespaceId = args.namespaceId;
  if (args.displayName !== undefined) out.displayName = args.displayName;
  if (args.workspaceName !== undefined) out.workspaceName = args.workspaceName;
  if (args.branchName !== undefined) out.branchName = args.branchName;
  return out;
}

// Predefined-kind launcher: load the definition by reserved id, throw a
// structured sentinel if storage is unavailable, return the composed input.
export function resolvePredefinedAgent(
  storage: AgentDefinitionsStorage,
  kind: PredefinedAgentKind,
): { error: string } | { definition: AgentDefinition } {
  if (storage.state() === "unavailable") return { error: "agent_storage_unavailable" };
  const def = storage.get(kind);
  if (!def) return { error: "agent_storage_unavailable" };
  return { definition: def };
}

export function resolveCustomAgent(
  storage: AgentDefinitionsStorage,
  agentId: string,
): { error: string } | { definition: AgentDefinition } {
  if (storage.state() === "unavailable") return { error: "agent_storage_unavailable" };
  const def = storage.get(agentId);
  if (!def) return { error: "agent_not_found" };
  if (def.kind !== "custom") return { error: "use_predefined_launcher_for_this_id" };
  return { definition: def };
}
