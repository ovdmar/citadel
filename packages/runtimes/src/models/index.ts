import type { RuntimeModelDescriptor } from "@citadel/contracts";
import { fetchClaudeCodeModels } from "./claude-code.js";
import { fetchCodexModels } from "./codex.js";
import { fetchCursorAgentModels } from "./cursor-agent.js";
import { fetchPiModels } from "./pi.js";

export type RuntimeModelListerResult = {
  models: RuntimeModelDescriptor[];
  probeError?: string;
};

export type RuntimeModelLister = (input: {
  command: string;
  args?: string[];
}) => Promise<RuntimeModelListerResult>;

// Lookup of built-in, runtime-owned model listers keyed by runtime id.
// Mirrors the `runtimeUsageFetchers` registry next door.
export const runtimeModelListers: Record<string, RuntimeModelLister> = {
  "claude-code": fetchClaudeCodeModels,
  codex: fetchCodexModels,
  "cursor-agent": fetchCursorAgentModels,
  pi: fetchPiModels,
};

export function hasRuntimeModelLister(runtimeId: string): boolean {
  return Object.hasOwn(runtimeModelListers, runtimeId);
}

export {
  fetchClaudeCodeModels,
  parseClaudeCodeModelsList,
  CLAUDE_CODE_MODELS_FALLBACK,
} from "./claude-code.js";
export { fetchCodexModels } from "./codex.js";
export { fetchCursorAgentModels } from "./cursor-agent.js";
export { fetchPiModels } from "./pi.js";
