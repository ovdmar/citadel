import { execFileSync } from "node:child_process";

const DEFAULT_AGENT_NICE = 10;
const MAX_NICE = 19;
const DISABLED_VALUES = new Set(["0", "false", "no", "off", "disabled", "none"]);
const commandCache = new Map<string, boolean>();

type AgentResourcePrefixOptions = {
  env?: NodeJS.ProcessEnv;
  commandExists?: (command: string) => boolean;
};

export function agentResourcePrefixArgs(options: AgentResourcePrefixOptions = {}): string[] {
  const env = options.env ?? process.env;
  if (isDisabled(env.CITADEL_AGENT_LOW_PRIORITY)) return [];

  const exists = options.commandExists ?? commandAvailable;
  const args: string[] = [];
  if (!isDisabled(env.CITADEL_AGENT_IONICE) && exists("ionice")) args.push("ionice", "-c3");

  const niceValue = agentNiceValue(env.CITADEL_AGENT_NICE);
  if (niceValue > 0 && exists("nice")) args.push("nice", "-n", String(niceValue));
  return args;
}

export function agentNiceValue(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_AGENT_NICE;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_AGENT_NICE;
  return Math.min(MAX_NICE, Math.max(0, parsed));
}

function isDisabled(raw: string | undefined): boolean {
  return raw !== undefined && DISABLED_VALUES.has(raw.trim().toLowerCase());
}

function commandAvailable(command: string): boolean {
  if (!/^[A-Za-z0-9_.-]+$/.test(command)) return false;
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;
  try {
    execFileSync("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
      timeout: 1000,
    });
    commandCache.set(command, true);
    return true;
  } catch {
    commandCache.set(command, false);
    return false;
  }
}
