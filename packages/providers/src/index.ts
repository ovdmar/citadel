import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { UsageProviderConfig } from "@citadel/config";
import type {
  CheckSummary,
  CiProviderSummary,
  CiRunSummary,
  IssueTrackerSummary,
  IssueTransition,
  IssueTransitionActionResult,
  PrReviewerState,
  ProviderHealth,
  RuntimeUsageCategory,
  RuntimeUsageSummary,
  VersionControlSummary,
} from "@citadel/contracts";
import { runtimeUsageFetchers } from "@citadel/runtimes";

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

export type ProviderConfigInput = {
  github: { enabled: boolean; command?: string | undefined };
  jira: { enabled: boolean; command?: string | undefined; projectKey?: string | undefined };
};

export async function collectProviderHealth(config: ProviderConfigInput) {
  const jiraCommand = config.jira.command ?? "jtk";
  const jiraHealthArgs = config.jira.projectKey
    ? [
        "issues",
        "search",
        "--jql",
        `project = ${config.jira.projectKey} ORDER BY updated DESC`,
        "--max",
        "1",
        "--no-color",
      ]
    : ["--help"];
  return Promise.all([
    commandHealth({
      id: "github-gh",
      displayName: "GitHub CLI",
      kind: "version-control",
      command: config.github.command ?? "gh",
      args: ["auth", "status"],
      enabled: config.github.enabled,
    }),
    commandHealth({
      id: "jira-jtk",
      displayName: "Jira CLI",
      kind: "issue-tracker",
      command: jiraCommand,
      args: jiraHealthArgs,
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

export type CollectRuntimeUsageInput = {
  runtimeId: string;
  command: string;
  args: string[];
  // Optional external usage-provider command — used as the fallback for custom
  // runtimes that don't have a built-in fetcher. Known runtimes (claude-code,
  // codex) always prefer their runtime-owned fetcher and ignore this.
  externalProvider?: UsageProviderConfig | undefined;
};

export async function collectRuntimeUsage(input: CollectRuntimeUsageInput): Promise<RuntimeUsageSummary> {
  const checkedAt = new Date().toISOString();
  const fetcher = runtimeUsageFetchers[input.runtimeId];
  if (fetcher) {
    try {
      const categories = await fetcher({ command: input.command, args: input.args });
      return {
        runtimeId: input.runtimeId,
        providerId: `usage-${input.runtimeId}`,
        source: `${input.runtimeId}-runtime`,
        status: categories.length > 0 ? "healthy" : "degraded",
        reason: categories.length > 0 ? null : "Usage panel did not render any categories",
        categories,
        checkedAt,
      };
    } catch (error) {
      return {
        runtimeId: input.runtimeId,
        providerId: `usage-${input.runtimeId}`,
        source: `${input.runtimeId}-runtime`,
        status: "degraded",
        reason: error instanceof Error ? error.message : "Runtime usage fetch failed",
        categories: [],
        checkedAt,
      };
    }
  }
  const provider = input.externalProvider;
  if (!provider) {
    return {
      runtimeId: input.runtimeId,
      providerId: "usage-unsupported",
      source: "unsupported",
      status: "unavailable",
      reason: "No usage provider configured for this runtime",
      categories: [],
      checkedAt,
    };
  }
  try {
    const { stdout } = await execFileAsync(provider.command, provider.args, {
      cwd: provider.cwd,
      timeout: 8000,
      maxBuffer: 128 * 1024,
    });
    return normalizeRuntimeUsage(input.runtimeId, provider.id, stdout, checkedAt);
  } catch (error) {
    return {
      runtimeId: input.runtimeId,
      providerId: provider.id,
      source: provider.command,
      status: "degraded",
      reason: error instanceof Error ? error.message : "Usage provider failed",
      categories: [],
      checkedAt,
    };
  }
}

// Parse the JSON contract emitted by an external (custom-runtime) usage
// command. The external script must return:
//   { categories: [{ label, percentUsed, reset?, section? }, ...], status?, reason?, source? }
export function normalizeRuntimeUsage(
  runtimeId: string,
  providerId: string,
  output: string,
  checkedAt = new Date().toISOString(),
): RuntimeUsageSummary {
  const parsed = JSON.parse(output) as Record<string, unknown>;
  const rawCategories = Array.isArray(parsed.categories) ? (parsed.categories as unknown[]) : [];
  const categories: RuntimeUsageCategory[] = [];
  for (const entry of rawCategories) {
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const label = typeof obj.label === "string" ? obj.label : null;
    const pct = typeof obj.percentUsed === "number" ? obj.percentUsed : null;
    if (!label || pct === null || pct < 0 || pct > 100) continue;
    categories.push({
      label,
      percentUsed: pct,
      reset: typeof obj.reset === "string" ? obj.reset : null,
      section: typeof obj.section === "string" ? obj.section : null,
    });
  }
  const declaredStatus = parsed.status;
  const status: RuntimeUsageSummary["status"] =
    declaredStatus === "degraded" || declaredStatus === "unavailable" ? declaredStatus : "healthy";
  return {
    runtimeId,
    providerId,
    source: typeof parsed.source === "string" ? parsed.source : providerId,
    status,
    reason: typeof parsed.reason === "string" ? parsed.reason : null,
    categories,
    checkedAt,
  };
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

type GhReview = {
  author?: { login?: string | null; name?: string | null } | null;
  state?: string | null;
  submittedAt?: string | null;
};
type GhReviewRequest = { login?: string | null; name?: string | null };

async function currentPullRequest(rootPath: string) {
  try {
    const raw = await gh(rootPath, [
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,additions,deletions,reviews,reviewRequests",
    ]);
    const parsed = JSON.parse(raw) as {
      number: number;
      title: string;
      url: string;
      state: string;
      isDraft: boolean;
      reviewDecision?: string | null;
      statusCheckRollup?: Array<Record<string, unknown>>;
      additions?: number | null;
      deletions?: number | null;
      reviews?: GhReview[];
      reviewRequests?: GhReviewRequest[];
    };
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state: parsed.state,
      draft: parsed.isDraft,
      reviewDecision: parsed.reviewDecision ?? null,
      checks: (parsed.statusCheckRollup ?? []).map(normalizeCheck),
      additions: typeof parsed.additions === "number" ? parsed.additions : null,
      deletions: typeof parsed.deletions === "number" ? parsed.deletions : null,
      reviewers: aggregateReviewers(parsed.reviews ?? [], parsed.reviewRequests ?? []),
    };
  } catch {
    return null;
  }
}

export function aggregateReviewers(reviews: GhReview[], reviewRequests: GhReviewRequest[]) {
  // Take the latest review per author; "pending" review requests outrank older
  // states because GitHub re-requests a review when the PR moves on.
  const latestByLogin = new Map<string, { name: string | null; state: string; submittedAt: string }>();
  for (const review of reviews) {
    const login = review.author?.login;
    if (!login) continue;
    const submittedAt = review.submittedAt ?? "";
    const prev = latestByLogin.get(login);
    if (!prev || submittedAt > prev.submittedAt) {
      latestByLogin.set(login, {
        name: review.author?.name ?? null,
        state: String(review.state ?? "").toUpperCase(),
        submittedAt,
      });
    }
  }
  const out: Array<{ login: string; name: string | null; state: PrReviewerState }> = [];
  for (const [login, entry] of latestByLogin) {
    out.push({ login, name: entry.name, state: mapReviewState(entry.state) });
  }
  for (const requested of reviewRequests) {
    if (!requested.login) continue;
    const existing = out.find((r) => r.login === requested.login);
    if (existing) {
      existing.state = "pending";
      if (!existing.name && requested.name) existing.name = requested.name;
    } else {
      out.push({ login: requested.login, name: requested.name ?? null, state: "pending" });
    }
  }
  return out;
}

function mapReviewState(state: string): PrReviewerState {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "changes_requested";
    case "COMMENTED":
      return "commented";
    case "DISMISSED":
      return "dismissed";
    default:
      return "pending";
  }
}

export function normalizeCheck(input: Record<string, unknown>): CheckSummary {
  return {
    name: String(input.name ?? input.context ?? "check"),
    status: String(input.status ?? input.state ?? "unknown"),
    conclusion: typeof input.conclusion === "string" ? input.conclusion : null,
    url: typeof input.detailsUrl === "string" ? input.detailsUrl : typeof input.url === "string" ? input.url : null,
    startedAt: typeof input.startedAt === "string" ? input.startedAt : null,
    completedAt: typeof input.completedAt === "string" ? input.completedAt : null,
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

let githubCommandOverride = "gh";

export function setGithubCommand(command: string | undefined) {
  githubCommandOverride = command?.length ? command : "gh";
}

async function gh(rootPath: string, args: string[]) {
  const result = await execFileAsync(githubCommandOverride, args, {
    cwd: rootPath,
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

let jiraCommandOverride = "jtk";

export function setJiraCommand(command: string | undefined) {
  jiraCommandOverride = command?.length ? command : "jtk";
}

async function jtk(args: string[]) {
  const result = await execFileAsync(jiraCommandOverride, args, {
    timeout: 12000,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}
