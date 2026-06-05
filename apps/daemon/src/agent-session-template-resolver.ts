import type { CitadelConfig } from "@citadel/config";
import type { CreateAgentSessionInput } from "@citadel/contracts";
import type { CreateAgentSessionOperationInput } from "@citadel/operations";
import { agentTemplateDefaultsFromRuntimes, listAgentTemplates } from "./agent-templates.js";

export async function resolveCreateAgentSessionInputFromTemplates(
  config: CitadelConfig,
  input: CreateAgentSessionInput,
): Promise<CreateAgentSessionOperationInput> {
  if (!input.role) return input;
  const templates = await listAgentTemplates(config.dataDir, agentTemplateDefaultsFromRuntimes(config.agentRuntimes));
  const template = templates.find((candidate) => candidate.role === input.role);
  if (!template) throw new Error(`role_template_not_found:${input.role}`);
  return {
    ...input,
    runtimeId: template.launchSettings.runtimeId,
    displayName: template.displayName,
    launchSettings: template.launchSettings,
    roleTemplatePrompt: template.systemPrompt,
  };
}
