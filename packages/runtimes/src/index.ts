import { execFileSync } from "node:child_process";
import type { RuntimeConfig } from "@citadel/config";
import type { AgentRuntime } from "@citadel/contracts";

export {
  claudeProjectsDir,
  parseClaudeTranscript,
  findClaudeTranscriptForSession,
  renderClaudeTranscriptAsText,
  claudeCodeAdapter,
  codexAdapter,
  cursorAgentAdapter,
  getTranscriptAdapter,
  getUserPromptsForSession,
  parseCodexRollout,
  findCodexRolloutForSession,
  codexSessionsRoot,
} from "./transcripts/index.js";
export type { RuntimeUserPrompt, RuntimeTranscriptAdapter, GetUserPromptsInput } from "./transcripts/index.js";

export {
  runtimeUsageFetchers,
  hasRuntimeUsageFetcher,
  fetchClaudeUsageCategories,
  parseClaudeUsageCategories,
  extractClaudeUsagePanel,
  fetchCodexUsageCategories,
  parseCodexUsageCategories,
  extractCodexStatusPanel,
} from "./usage/index.js";
export type { RuntimeUsageFetcher } from "./usage/index.js";

const baseCapabilities = {
  supportsPrompt: false,
  supportsResume: false,
  supportsModelSelection: false,
  supportsTranscript: false,
  supportsStatusDetection: true,
  supportsNonInteractiveGoal: false,
  supportsShell: true,
  supportsUsage: false,
  // Default is false (shell-style runtimes emit line-buffered text). The
  // builtin overrides below flip it on for the known TUI runtimes so the
  // scheduled-agents UI can disable runMode='background' for them.
  supportsTui: false,
};

// Built-in capability defaults applied to known runtime IDs.
// Operator config can override these explicitly per runtime.
const builtinCapabilities: Record<string, Partial<typeof baseCapabilities>> = {
  "claude-code": {
    supportsPrompt: true,
    supportsResume: true,
    supportsModelSelection: true,
    supportsTranscript: true,
    supportsNonInteractiveGoal: true,
    supportsUsage: true,
    supportsTui: true,
  },
  codex: {
    supportsPrompt: true,
    supportsResume: true,
    supportsNonInteractiveGoal: true,
    supportsTui: true,
    supportsUsage: true,
  },
  "cursor-agent": {
    supportsPrompt: true,
    supportsNonInteractiveGoal: true,
    supportsTui: true,
  },
  pi: {
    supportsPrompt: true,
  },
  shell: {
    supportsPrompt: true,
    supportsResume: true,
    supportsNonInteractiveGoal: true,
  },
};

export function capabilitiesForRuntime(runtime: RuntimeConfig) {
  const built = builtinCapabilities[runtime.id] ?? {};
  const explicit: Partial<typeof baseCapabilities> = {};
  if (runtime.supportsPrompt !== undefined) explicit.supportsPrompt = runtime.supportsPrompt;
  if (runtime.supportsResume !== undefined) explicit.supportsResume = runtime.supportsResume;
  if (runtime.supportsModelSelection !== undefined) explicit.supportsModelSelection = runtime.supportsModelSelection;
  return { ...baseCapabilities, ...built, ...explicit };
}

export function listRuntimeHealth(configured: RuntimeConfig[]): AgentRuntime[] {
  return configured.map((runtime) => {
    const available = commandExists(runtime.command);
    return {
      id: runtime.id,
      displayName: runtime.displayName,
      command: runtime.command,
      args: runtime.args,
      health: available ? "healthy" : "unavailable",
      healthReason: available ? null : `Command not found on PATH: ${runtime.command}`,
      capabilities: capabilitiesForRuntime(runtime),
    };
  });
}

export function commandExists(command: string) {
  try {
    execFileSync("bash", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(input: string) {
  return `'${input.replace(/'/g, "'\\''")}'`;
}
