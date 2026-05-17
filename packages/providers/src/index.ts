import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProviderHealth } from "@citadel/contracts";

const execFileAsync = promisify(execFile);

export type ProviderKind = ProviderHealth["kind"];

export async function commandHealth(input: {
  id: string;
  displayName: string;
  kind: ProviderKind;
  command: string;
  args: string[];
  enabled: boolean;
}): Promise<ProviderHealth> {
  const checkedAt = new Date().toISOString();
  if (!input.enabled) {
    return {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      status: "unavailable",
      reason: "Provider is disabled in config",
      checkedAt,
    };
  }
  try {
    await execFileAsync(input.command, input.args, { timeout: 8000, maxBuffer: 256 * 1024 });
    return {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      status: "healthy",
      reason: null,
      checkedAt,
    };
  } catch (error) {
    return {
      id: input.id,
      displayName: input.displayName,
      kind: input.kind,
      status: "degraded",
      reason: error instanceof Error ? error.message : "Provider health check failed",
      checkedAt,
    };
  }
}

export async function collectProviderHealth(config: { github: { enabled: boolean }; jira: { enabled: boolean } }) {
  return Promise.all([
    commandHealth({
      id: "github-gh",
      displayName: "GitHub CLI",
      kind: "version-control",
      command: "gh",
      args: ["auth", "status"],
      enabled: config.github.enabled,
    }),
    commandHealth({
      id: "jira-jtk",
      displayName: "Jira CLI",
      kind: "issue-tracker",
      command: "/home/linuxbrew/.linuxbrew/bin/jtk",
      args: ["issues", "search", "--jql", "project = MS ORDER BY updated DESC", "--max", "1", "--no-color"],
      enabled: config.jira.enabled,
    }),
  ]);
}
