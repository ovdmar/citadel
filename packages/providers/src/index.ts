import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CheckSummary, ProviderHealth, VersionControlSummary } from "@citadel/contracts";

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

export async function collectGitHubVersionControlSummary(rootPath: string): Promise<VersionControlSummary> {
  const checkedAt = new Date().toISOString();
  try {
    if (!fs.existsSync(path.join(rootPath, ".git"))) throw new Error(`Not a git repository: ${rootPath}`);
    const defaultBranch = await discoverDefaultBranch(rootPath);
    const currentBranch = await gitOptional(rootPath, ["branch", "--show-current"]);
    const remotes = await gitOptional(rootPath, ["remote"]).then((value) => value.split("\n").filter(Boolean));
    const pullRequest = await currentPullRequest(rootPath);
    return {
      providerId: "github-gh",
      status: "healthy",
      reason: null,
      defaultBranch: defaultBranch || null,
      currentBranch: currentBranch || null,
      remotes,
      pullRequest,
      checkedAt,
    };
  } catch (error) {
    return {
      providerId: "github-gh",
      status: "degraded",
      reason: error instanceof Error ? error.message : "GitHub provider summary failed",
      defaultBranch: null,
      currentBranch: null,
      remotes: [],
      pullRequest: null,
      checkedAt,
    };
  }
}

async function discoverDefaultBranch(rootPath: string) {
  const originHead = await gitOptional(rootPath, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (originHead) return originHead.replace(/^origin\//, "");
  const remoteDefault = await gitOptional(rootPath, ["remote", "show", "origin"]);
  const match = remoteDefault.match(/HEAD branch: ([^\n]+)/);
  if (match?.[1]) return match[1].trim();
  return (await gitOptional(rootPath, ["branch", "--show-current"])) || null;
}

async function currentPullRequest(rootPath: string) {
  try {
    const raw = await gh(rootPath, [
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,reviewDecision,statusCheckRollup",
    ]);
    const parsed = JSON.parse(raw) as {
      number: number;
      title: string;
      url: string;
      state: string;
      isDraft: boolean;
      reviewDecision?: string | null;
      statusCheckRollup?: Array<Record<string, unknown>>;
    };
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state: parsed.state,
      draft: parsed.isDraft,
      reviewDecision: parsed.reviewDecision ?? null,
      checks: (parsed.statusCheckRollup ?? []).map(normalizeCheck),
    };
  } catch {
    return null;
  }
}

function normalizeCheck(input: Record<string, unknown>): CheckSummary {
  return {
    name: String(input.name ?? input.context ?? "check"),
    status: String(input.status ?? input.state ?? "unknown"),
    conclusion: typeof input.conclusion === "string" ? input.conclusion : null,
    url: typeof input.detailsUrl === "string" ? input.detailsUrl : typeof input.url === "string" ? input.url : null,
  };
}

async function git(rootPath: string, args: string[]) {
  const result = await execFileAsync("git", args, { cwd: rootPath, timeout: 8000, maxBuffer: 512 * 1024 });
  return result.stdout.trim();
}

async function gitOptional(rootPath: string, args: string[]) {
  try {
    return await git(rootPath, args);
  } catch {
    return "";
  }
}

async function gh(rootPath: string, args: string[]) {
  const result = await execFileAsync("gh", args, { cwd: rootPath, timeout: 12000, maxBuffer: 1024 * 1024 });
  return result.stdout.trim();
}
