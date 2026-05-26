import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { UsageProviderConfig } from "@citadel/config";
import type {
  CheckSummary,
  CiProviderSummary,
  CiRunSummary,
  PrReviewerState,
  ProviderHealth,
  RuntimeUsageCategory,
  RuntimeUsageSummary,
  VersionControlSummary,
} from "@citadel/contracts";
import type { ParentPr, PrCommit, PrMergeResponse, PrMergeStrategy } from "@citadel/contracts/pr-routes";
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
    const pullRequest = await currentPullRequest(rootPath, remotes);
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

export {
  collectJiraIssueSummary,
  parseJiraIssueOutput,
  parseJiraTransitionsOutput,
  setJiraCommand,
  transitionJiraIssue,
} from "./jira.js";

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

async function currentPullRequest(rootPath: string, remotes: string[] = []) {
  // No upstream means there is no PR to look up — short-circuit so a local-
  // only repo (or a worktree that hasn't pushed yet) reads as "no PR" instead
  // of degrading the whole VC provider. Avoids spending a gh subprocess on a
  // call we know would fail with a non-distinguishable error.
  if (remotes.length === 0) return null;
  let raw: string;
  try {
    raw = await gh(rootPath, [
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,reviewDecision,statusCheckRollup,additions,deletions,reviews,reviewRequests,commits,baseRefName,headRefName,headRepository,mergeable",
    ]);
  } catch (error) {
    // Distinguish "no PR exists for this branch" (authoritative null) from
    // transient gh failures (rate limit, network, auth wobble). gh prints
    // "no pull requests found for branch ..." in the first case; everything
    // else is propagated so collectGitHubVersionControlSummary marks the
    // VC summary as `degraded` and the client preserves the last-known PR
    // instead of dropping it from the navbar.
    if (isGhNoPullRequestError(error)) return null;
    throw error;
  }
  try {
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
      commits?: Array<Record<string, unknown>>;
      baseRefName?: string;
      headRefName?: string;
      headRepository?: { nameWithOwner?: string } | null;
      mergeable?: string;
    };
    // Repo merge config + parent-PR detection run in parallel — both can fail
    // independently and degrade to safe defaults, so don't block the PR view
    // on either.
    const [allowedMergeStrategies, parentPr] = await Promise.all([
      fetchAllowedMergeStrategies(rootPath),
      parsed.baseRefName && parsed.headRepository?.nameWithOwner
        ? fetchParentPr(rootPath, parsed.baseRefName, parsed.headRepository.nameWithOwner)
        : Promise.resolve(null),
    ]);
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
      commits: (parsed.commits ?? []).map(normalizePrCommit),
      headRefName: parsed.headRefName ?? null,
      parentPr,
      mergeable: normalizeMergeable(parsed.mergeable),
      allowedMergeStrategies,
    };
  } catch {
    // JSON parse / shape failure: not a "no PR" signal — treat as transient
    // so the VC summary degrades and the client preserves cached data.
    throw new Error("gh pr view returned unparseable output");
  }
}

// gh prints "no pull requests found for branch ..." (or "no open pull
// requests found ...") when the branch genuinely has no PR. Match loosely on
// the error's stderr/message so we don't get tripped up by minor wording
// changes across gh versions.
export function isGhNoPullRequestError(error: unknown): boolean {
  if (!error) return false;
  const candidates: string[] = [];
  if (typeof error === "string") candidates.push(error);
  else if (typeof error === "object") {
    const obj = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    if (typeof obj.message === "string") candidates.push(obj.message);
    if (typeof obj.stderr === "string") candidates.push(obj.stderr);
    if (typeof obj.stdout === "string") candidates.push(obj.stdout);
  }
  return candidates.some((text) => /no (open )?pull requests? (found|matching)/i.test(text));
}

function normalizeMergeable(raw: string | undefined): "mergeable" | "conflicting" | "unknown" {
  if (!raw) return "unknown";
  const upper = raw.toUpperCase();
  if (upper === "MERGEABLE") return "mergeable";
  if (upper === "CONFLICTING") return "conflicting";
  return "unknown";
}

async function fetchAllowedMergeStrategies(rootPath: string): Promise<Array<"squash" | "merge" | "rebase">> {
  try {
    const raw = await gh(rootPath, [
      "repo",
      "view",
      "--json",
      "mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed",
    ]);
    const parsed = JSON.parse(raw) as {
      mergeCommitAllowed?: boolean;
      squashMergeAllowed?: boolean;
      rebaseMergeAllowed?: boolean;
    };
    const allowed: Array<"squash" | "merge" | "rebase"> = [];
    if (parsed.squashMergeAllowed) allowed.push("squash");
    if (parsed.mergeCommitAllowed) allowed.push("merge");
    if (parsed.rebaseMergeAllowed) allowed.push("rebase");
    return allowed;
  } catch {
    return [];
  }
}

async function fetchParentPr(rootPath: string, baseRefName: string, headRepository: string): Promise<ParentPr | null> {
  try {
    const raw = await gh(rootPath, [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "50",
      "--json",
      "number,url,headRefName,headRepository,state",
    ]);
    const candidates = JSON.parse(raw) as Array<{
      number: number;
      url: string;
      headRefName: string;
      headRepository?: string | { nameWithOwner?: string } | null;
      state: string;
    }>;
    return detectParentPr({ baseRefName, headRepository }, candidates);
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

// PR display helpers — used by the daemon's PR routes for the always-on
// cross-workspace poll, force-refresh, merge button, and stacked-PR detection.

// Hand-rolled concurrency limiter. Kept here (not as a dependency) to avoid
// touching pnpm-lock.yaml for ~10 lines of logic.
export function pLimit(concurrency: number) {
  if (concurrency < 1) throw new Error("pLimit concurrency must be >= 1");
  const queue: Array<() => void> = [];
  let active = 0;
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (job) {
      active += 1;
      job();
    }
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        task()
          .then((value) => {
            active -= 1;
            resolve(value);
            next();
          })
          .catch((error) => {
            active -= 1;
            reject(error);
            next();
          });
      });
      next();
    });
}

type RawCommit = {
  oid?: string;
  sha?: string;
  messageHeadline?: string;
  message?: string;
};

export function normalizePrCommit(raw: RawCommit): PrCommit {
  const sha = String(raw.oid ?? raw.sha ?? "");
  const headline =
    typeof raw.messageHeadline === "string" && raw.messageHeadline.length > 0
      ? raw.messageHeadline
      : ((raw.message ?? "").split("\n")[0]?.trim() ?? "");
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: headline,
    checks: [],
  };
}

// Pure: caller (daemon) provides the cache wrapper. Returns the per-commit
// check rollup from the GitHub API; tolerates failure with an empty array so
// one bad commit doesn't poison the PR summary.
export async function fetchCommitChecks(rootPath: string, nameWithOwner: string, sha: string): Promise<CheckSummary[]> {
  try {
    const raw = await gh(rootPath, [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${nameWithOwner}/commits/${sha}/check-runs`,
    ]);
    const parsed = JSON.parse(raw) as { check_runs?: Array<Record<string, unknown>> };
    return (parsed.check_runs ?? []).map((entry) =>
      normalizeCheck({
        name: entry.name,
        status: entry.status,
        conclusion: entry.conclusion,
        detailsUrl: entry.details_url ?? entry.html_url,
        startedAt: entry.started_at,
        completedAt: entry.completed_at,
      }),
    );
  } catch {
    return [];
  }
}

type ParentPrCandidate = {
  number: number;
  url: string;
  headRefName: string;
  state: string;
  headRepository?: string | { nameWithOwner?: string } | null;
};

// Match by both head ref name AND head repository so same-named branches in
// different forks don't false-positive. Open PRs win over merged when both
// match the same repo (right-after-merge case still surfaces a merged parent
// via its own MERGED state).
export function detectParentPr(
  query: { baseRefName: string; headRepository: string },
  candidates: ParentPrCandidate[],
): ParentPr | null {
  const matches = candidates.filter((candidate) => {
    if (candidate.headRefName !== query.baseRefName) return false;
    const repo =
      typeof candidate.headRepository === "string" ? candidate.headRepository : candidate.headRepository?.nameWithOwner;
    return repo === query.headRepository;
  });
  if (matches.length === 0) return null;
  const open = matches.find((m) => m.state.toUpperCase() === "OPEN");
  const choice = open ?? matches[0];
  if (!choice) return null;
  return { number: choice.number, url: choice.url, headRefName: choice.headRefName, state: choice.state };
}

type GhRunner = (args: string[]) => Promise<string>;

// Internal seam: tests inject a fake runner; production calls gh() in this
// module. NO --delete-branch is ever passed — branch deletion is a separate
// opt-in flow that's intentionally not part of the night's scope.
export async function mergePr(
  input: { rootPath: string; number: number; strategy: PrMergeStrategy },
  runner?: GhRunner,
): Promise<PrMergeResponse> {
  const run: GhRunner = runner ?? ((args) => gh(input.rootPath, args));
  const args = ["pr", "merge", String(input.number), `--${input.strategy}`];
  try {
    await run(args);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: classifyMergeFailure(detail), detail };
  }
}

function classifyMergeFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not mergeable") || lower.includes("merge conflict")) return "not_mergeable";
  if (lower.includes("not authorized") || lower.includes("authentication")) return "gh_auth";
  if (lower.includes("not allowed") || lower.includes("disabled")) return "strategy_disallowed";
  return "gh_error";
}

// isGhAvailable returns whether `gh auth status` succeeded recently for the
// given rootPath. Caches the answer for 60s so the merge button doesn't spawn
// gh on every render.
const ghAvailableCache = new Map<string, { expiresAt: number; available: boolean }>();

export async function isGhAvailable(rootPath: string): Promise<boolean> {
  const cached = ghAvailableCache.get(rootPath);
  if (cached && cached.expiresAt > Date.now()) return cached.available;
  let available = false;
  try {
    await gh(rootPath, ["auth", "status"]);
    available = true;
  } catch {
    available = false;
  }
  ghAvailableCache.set(rootPath, { expiresAt: Date.now() + 60_000, available });
  return available;
}
