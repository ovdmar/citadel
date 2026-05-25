import type { RuntimeUsageCategory } from "@citadel/contracts";
import { fetchClaudeUsageCategories } from "./claude-code.js";
import { fetchCodexUsageCategories } from "./codex.js";

export type RuntimeUsageFetcher = (input: { command: string; args?: string[] }) => Promise<RuntimeUsageCategory[]>;

// Lookup of built-in, runtime-owned usage fetchers keyed by runtime id.
// New runtime support is added by writing a fetcher next to this module and
// adding it here. The presence of a fetcher implies `supportsUsage: true`.
export const runtimeUsageFetchers: Record<string, RuntimeUsageFetcher> = {
  "claude-code": fetchClaudeUsageCategories,
  codex: fetchCodexUsageCategories,
};

export function hasRuntimeUsageFetcher(runtimeId: string): boolean {
  return Object.hasOwn(runtimeUsageFetchers, runtimeId);
}

export {
  extractClaudeUsagePanel,
  fetchClaudeUsageCategories,
  parseClaudeUsageCategories,
} from "./claude-code.js";
export {
  extractCodexStatusPanel,
  fetchCodexUsageCategories,
  parseCodexUsageCategories,
} from "./codex.js";
