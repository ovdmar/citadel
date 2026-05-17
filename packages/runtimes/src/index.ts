import { execFileSync } from "node:child_process";
import type { RuntimeConfig } from "@citadel/config";
import type { AgentRuntime } from "@citadel/contracts";

const shellCapabilities = {
  supportsPrompt: true,
  supportsResume: true,
  supportsModelSelection: false,
  supportsTranscript: false,
  supportsStatusDetection: true,
  supportsNonInteractiveGoal: true,
  supportsShell: true,
  supportsUsage: false,
};

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
      capabilities: shellCapabilities,
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
