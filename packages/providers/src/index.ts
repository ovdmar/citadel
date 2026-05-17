import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CheckSummary,
  CiProviderSummary,
  CiRunSummary,
  IssueTrackerSummary,
  IssueTransition,
  IssueTransitionActionResult,
  ProviderHealth,
  VersionControlSummary,
} from "@citadel/contracts";

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

export async function collectGitHubCiRuns(rootPath: string): Promise<CiProviderSummary> {
  const checkedAt = new Date().toISOString();
  try {
    if (!fs.existsSync(path.join(rootPath, ".git"))) throw new Error(`Not a git repository: ${rootPath}`);
    const currentBranch = await gitOptional(rootPath, ["branch", "--show-current"]);
    const args = [
      "run",
      "list",
      "--limit",
      "10",
      "--json",
      "databaseId,name,status,conclusion,url,createdAt,headBranch,event",
    ];
    if (currentBranch) args.push("--branch", currentBranch);
    const raw = await gh(rootPath, args);
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    return {
      providerId: "github-gh",
      status: "healthy",
      reason: null,
      runs: parsed.map(normalizeCiRun),
      checkedAt,
    };
  } catch (error) {
    return {
      providerId: "github-gh",
      status: "degraded",
      reason: error instanceof Error ? error.message : "GitHub CI summary failed",
      runs: [],
      checkedAt,
    };
  }
}

export async function collectGitHubCiRunLog(rootPath: string, runId: string) {
  try {
    if (!fs.existsSync(path.join(rootPath, ".git"))) throw new Error(`Not a git repository: ${rootPath}`);
    const raw = await gh(rootPath, ["run", "view", runId, "--log"]);
    return {
      providerId: "github-gh",
      status: "healthy" as const,
      reason: null,
      runId,
      truncated: raw.length > 256 * 1024,
      log: raw.slice(0, 256 * 1024),
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      providerId: "github-gh",
      status: "degraded" as const,
      reason: error instanceof Error ? error.message : "GitHub CI log fetch failed",
      runId,
      truncated: false,
      log: "",
      checkedAt: new Date().toISOString(),
    };
  }
}

export function normalizeCiRun(input: Record<string, unknown>): CiRunSummary {
  return {
    providerId: "github-gh",
    id: String(input.databaseId ?? input.id ?? ""),
    name: String(input.name ?? "workflow"),
    status: String(input.status ?? "unknown"),
    conclusion: typeof input.conclusion === "string" ? input.conclusion : null,
    branch: typeof input.headBranch === "string" ? input.headBranch : null,
    event: typeof input.event === "string" ? input.event : null,
    url: typeof input.url === "string" ? input.url : null,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : null,
  };
}

export function normalizeCiRunList(output: string) {
  return (JSON.parse(output) as Array<Record<string, unknown>>).map(normalizeCiRun);
}

export async function collectJiraIssueSummary(issueKey: string): Promise<IssueTrackerSummary> {
  const checkedAt = new Date().toISOString();
  const key = issueKey.trim().toUpperCase();
  try {
    const issue = parseJiraIssueOutput(
      await jtk(["issues", "get", key, "--fields", "Summary,Status,Assignee,Updated", "--no-color"]),
    );
    const transitions = parseJiraTransitionsOutput(await jtk(["transitions", "list", key, "--no-color"]));
    return {
      providerId: "jira-jtk",
      status: "healthy",
      reason: null,
      key,
      summary: issue.summary,
      issueStatus: issue.issueStatus,
      assignee: issue.assignee,
      updated: issue.updated,
      url: null,
      transitions,
      checkedAt,
    };
  } catch (error) {
    return {
      providerId: "jira-jtk",
      status: "degraded",
      reason: error instanceof Error ? error.message : "Jira issue summary failed",
      key,
      summary: null,
      issueStatus: null,
      assignee: null,
      updated: null,
      url: null,
      transitions: [],
      checkedAt,
    };
  }
}

export function parseJiraIssueOutput(output: string) {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (match?.[1]) values.set(match[1].trim().toLowerCase(), match[2]?.trim() ?? "");
  }
  return {
    key: values.get("key") ?? null,
    summary: values.get("summary") ?? null,
    issueStatus: values.get("status") ?? null,
    assignee: values.get("assignee") ?? null,
    updated: values.get("updated") ?? null,
  };
}

export function parseJiraTransitionsOutput(output: string): IssueTransition[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("ID |"))
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && Boolean(parts[0]))
    .map(([id, name, toStatus]) => ({
      id: id ?? "",
      name: name ?? "",
      toStatus: toStatus ?? "",
    }));
}

export async function transitionJiraIssue(input: {
  issueKey: string;
  transition: string;
  fields?: Record<string, string>;
}): Promise<IssueTransitionActionResult> {
  const checkedAt = new Date().toISOString();
  const key = input.issueKey.trim().toUpperCase();
  const transition = input.transition.trim();
  try {
    const fieldArgs = Object.entries(input.fields ?? {}).flatMap(([field, value]) => ["--field", `${field}=${value}`]);
    await jtk(["transitions", "do", key, transition, ...fieldArgs, "--no-color"]);
    return {
      providerId: "jira-jtk",
      status: "healthy",
      reason: null,
      key,
      transition,
      checkedAt,
    };
  } catch (error) {
    return {
      providerId: "jira-jtk",
      status: "degraded",
      reason: error instanceof Error ? error.message : "Jira transition failed",
      key,
      transition,
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

async function jtk(args: string[]) {
  const result = await execFileAsync("/home/linuxbrew/.linuxbrew/bin/jtk", args, {
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
