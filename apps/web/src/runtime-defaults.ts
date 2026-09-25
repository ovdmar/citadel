import type { AgentRuntime } from "@citadel/contracts";

// Resolve the workspace's default agent runtime. Matches the resolution the
// create-workspace modal has used inline: prefer "claude-code" if healthy,
// else fall back to the first healthy runtime; "" when no agent runtime is
// available.
//
// When the configurable per-workspace default lands (Agents-system block
// #12), this helper is the single seam to swap for a workspace-aware reader.
export function defaultAgentRuntimeId(runtimes: ReadonlyArray<AgentRuntime>): string {
  const launchable = runtimes.filter((runtime) => runtime.health === "healthy");
  if (launchable.some((runtime) => runtime.id === "claude-code")) return "claude-code";
  return launchable[0]?.id ?? "";
}
