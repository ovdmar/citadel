import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { isRateLimitError } from "./gh-cooldown.js";

const execFileAsync = promisify(execFile);

export type PrActionWarning = { code: string; message: string; paths: string[] };
export type GitHubRemote = { owner: string; repo: string; nameWithOwner: string };
export type GitHubPullRequestIdentity = {
  number: number | null;
  title: string | null;
  url: string;
  state: string;
  headRefName: string | null;
  baseRefName: string | null;
  headSha: string | null;
};

export type CreateGitHubPullRequestInput = {
  rootPath: string;
  baseBranch: string;
  defaultRemote: string;
  title: string;
  bodyFallback: string;
  githubCommand?: string;
};

export type PushGitHubBranchInput = {
  rootPath: string;
  baseBranch: string;
  defaultRemote: string;
  githubCommand?: string;
};

export type GitHubPrActionResult = {
  ok: boolean;
  pr: GitHubPullRequestIdentity | null;
  warnings: PrActionWarning[];
  pushed: boolean;
  error: string | null;
};

type CommandResult = { stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options: { cwd: string }) => Promise<CommandResult>;

export type GitHubPrActionDeps = {
  runCommand?: CommandRunner;
};

export async function createGitHubPullRequest(
  input: CreateGitHubPullRequestInput,
  deps: GitHubPrActionDeps = {},
): Promise<GitHubPrActionResult> {
  const warnings: PrActionWarning[] = [];
  try {
    const context = await readGitContext(input, deps);
    warnings.push(...context.warnings);
    const existing = await findOpenPullRequest(
      input.rootPath,
      context.remote,
      context.branch,
      input.baseBranch,
      input,
      deps,
    );
    if (existing) {
      const headSha = context.headSha;
      if (existing.headSha && headSha && existing.headSha !== headSha) {
        warnings.push({
          code: "local_head_differs_from_pr",
          message: "Local HEAD differs from the PR head.",
          paths: [],
        });
      }
      return { ok: true, pr: existing, warnings, pushed: false, error: null };
    }
    if (context.aheadCount === 0) {
      return { ok: false, pr: null, warnings, pushed: false, error: "zero_commits_ahead_of_base" };
    }

    await git(input.rootPath, ["push", "-u", input.defaultRemote, `HEAD:${context.branch}`], input, deps);
    const body = readPullRequestBody(input.rootPath, input.bodyFallback);
    const created = await createPullRequest(
      input.rootPath,
      context.remote,
      context.branch,
      input.baseBranch,
      input.title,
      body,
      input,
      deps,
    );
    const afterCreate =
      (await findOpenPullRequest(input.rootPath, context.remote, context.branch, input.baseBranch, input, deps)) ??
      created;
    return { ok: true, pr: afterCreate, warnings, pushed: true, error: null };
  } catch (error) {
    return {
      ok: false,
      pr: null,
      warnings,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function pushGitHubBranch(
  input: PushGitHubBranchInput,
  deps: GitHubPrActionDeps = {},
): Promise<GitHubPrActionResult> {
  const warnings: PrActionWarning[] = [];
  try {
    const context = await readGitContext({ ...input, title: "", bodyFallback: "" }, deps);
    warnings.push(...context.warnings);
    if (context.aheadCount === 0) {
      return { ok: false, pr: null, warnings, pushed: false, error: "zero_commits_ahead_of_base" };
    }
    await git(input.rootPath, ["push", "-u", input.defaultRemote, `HEAD:${context.branch}`], input, deps);
    return { ok: true, pr: null, warnings, pushed: true, error: null };
  } catch (error) {
    return {
      ok: false,
      pr: null,
      warnings,
      pushed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function parseGitHubRemoteUrl(value: string): GitHubRemote | null {
  const trimmed = value.trim();
  const https = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (https?.[1] && https[2]) return remote(https[1], https[2]);
  const ssh = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (ssh?.[1] && ssh[2]) return remote(ssh[1], ssh[2]);
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (sshUrl?.[1] && sshUrl[2]) return remote(sshUrl[1], sshUrl[2]);
  return null;
}

export function dirtyWarningsFromPorcelain(status: string): PrActionWarning[] {
  const staged: string[] = [];
  const unstaged: string[] = [];
  for (const line of status.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3).trim();
    if (code === "??") {
      unstaged.push(file);
      continue;
    }
    if (code[0] && code[0] !== " ") staged.push(file);
    if (code[1] && code[1] !== " ") unstaged.push(file);
  }
  const warnings: PrActionWarning[] = [];
  if (staged.length) {
    warnings.push({
      code: "staged_changes_excluded",
      message: "Staged changes are not included until they are committed.",
      paths: staged,
    });
  }
  if (unstaged.length) {
    warnings.push({
      code: "unstaged_changes_excluded",
      message: "Unstaged and untracked changes are not included in the pushed PR.",
      paths: unstaged,
    });
  }
  return warnings;
}

export function isGraphqlRateLimitError(error: unknown): boolean {
  const reason = isRateLimitError(error);
  if (!reason) return false;
  return String(reason).toLowerCase().includes("graphql");
}

async function readGitContext(
  input: CreateGitHubPullRequestInput,
  deps: GitHubPrActionDeps,
): Promise<{
  branch: string;
  remote: GitHubRemote;
  aheadCount: number;
  headSha: string;
  warnings: PrActionWarning[];
}> {
  const branch = await git(input.rootPath, ["branch", "--show-current"], input, deps);
  if (!branch) throw new Error("detached_head");
  await git(input.rootPath, ["check-ref-format", "--branch", branch], input, deps);
  const remoteUrl = await git(input.rootPath, ["remote", "get-url", input.defaultRemote], input, deps);
  const remote = parseGitHubRemoteUrl(remoteUrl);
  if (!remote) throw new Error("unsupported_github_remote");
  const baseRef = await resolveBaseRef(input.rootPath, input.baseBranch, input, deps);
  const mergeBase = await git(input.rootPath, ["merge-base", "HEAD", baseRef], input, deps);
  const aheadRaw = await git(input.rootPath, ["rev-list", "--count", `${mergeBase}..HEAD`], input, deps);
  const aheadCount = Number.parseInt(aheadRaw, 10);
  if (!Number.isFinite(aheadCount)) throw new Error("git_ahead_count_failed");
  const headSha = await git(input.rootPath, ["rev-parse", "HEAD"], input, deps);
  const warnings = dirtyWarningsFromPorcelain(await git(input.rootPath, ["status", "--porcelain=v1"], input, deps));
  return { branch, remote, aheadCount, headSha, warnings };
}

async function resolveBaseRef(
  rootPath: string,
  baseBranch: string,
  input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<string> {
  const branch = baseBranch.replace(/^origin\//, "");
  for (const candidate of [`origin/${branch}`, baseBranch]) {
    try {
      await git(rootPath, ["rev-parse", "--verify", `${candidate}^{commit}`], input, deps);
      return candidate;
    } catch {
      // Try next local base candidate.
    }
  }
  throw new Error(`base_ref_not_found:${baseBranch}`);
}

async function findOpenPullRequest(
  rootPath: string,
  remoteInfo: GitHubRemote,
  branch: string,
  baseBranch: string,
  input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<GitHubPullRequestIdentity | null> {
  const output = await gh(
    rootPath,
    [
      "pr",
      "list",
      "--repo",
      remoteInfo.nameWithOwner,
      "--head",
      `${remoteInfo.owner}:${branch}`,
      "--base",
      baseBranch.replace(/^origin\//, ""),
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      "number,title,url,state,headRefName,baseRefName,headRefOid",
    ],
    input,
    deps,
  );
  const parsed = JSON.parse(output || "[]") as Array<Record<string, unknown>>;
  const match = parsed.find(
    (entry) => entry.headRefName === branch && entry.baseRefName === baseBranch.replace(/^origin\//, ""),
  );
  return match ? prIdentity(match) : null;
}

async function createPullRequest(
  rootPath: string,
  remoteInfo: GitHubRemote,
  branch: string,
  baseBranch: string,
  title: string,
  body: string,
  input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<GitHubPullRequestIdentity | null> {
  const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pr-body-")), "body.md");
  fs.writeFileSync(bodyFile, body);
  try {
    const stdout = await gh(
      rootPath,
      [
        "pr",
        "create",
        "--repo",
        remoteInfo.nameWithOwner,
        "--base",
        baseBranch.replace(/^origin\//, ""),
        "--head",
        branch,
        "--title",
        title,
        "--body-file",
        bodyFile,
      ],
      input,
      deps,
    );
    const url = stdout.split(/\s+/).find((part) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(part));
    return url
      ? { number: null, title, url, state: "OPEN", headRefName: branch, baseRefName: baseBranch, headSha: null }
      : null;
  } catch (error) {
    if (!isGraphqlRateLimitError(error)) throw error;
    const existing = await findOpenPullRequest(rootPath, remoteInfo, branch, baseBranch, input, deps);
    if (existing) return existing;
    const restOutput = await gh(
      rootPath,
      [
        "api",
        `/repos/${remoteInfo.nameWithOwner}/pulls`,
        "-f",
        `base=${baseBranch.replace(/^origin\//, "")}`,
        "-f",
        `head=${branch}`,
        "-f",
        `title=${title}`,
        "-f",
        `body=${body}`,
        "-F",
        "draft=false",
      ],
      input,
      deps,
    );
    return prIdentity(JSON.parse(restOutput) as Record<string, unknown>);
  } finally {
    fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
  }
}

function readPullRequestBody(rootPath: string, fallback: string): string {
  for (const candidate of pullRequestTemplateCandidates(rootPath)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return fs.readFileSync(candidate, "utf8");
  }
  return fallback;
}

function pullRequestTemplateCandidates(rootPath: string): string[] {
  const candidates = [
    path.join(rootPath, ".github", "pull_request_template.md"),
    path.join(rootPath, ".github", "PULL_REQUEST_TEMPLATE.md"),
    path.join(rootPath, "docs", "pull_request_template.md"),
  ];
  const templateDir = path.join(rootPath, ".github", "PULL_REQUEST_TEMPLATE");
  if (fs.existsSync(templateDir) && fs.statSync(templateDir).isDirectory()) {
    candidates.push(
      ...fs
        .readdirSync(templateDir)
        .filter((entry) => entry.toLowerCase().endsWith(".md"))
        .sort()
        .map((entry) => path.join(templateDir, entry)),
    );
  }
  return candidates;
}

async function git(
  rootPath: string,
  args: string[],
  input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<string> {
  return (await runCommand("git", args, rootPath, input, deps)).stdout.trim();
}

async function gh(
  rootPath: string,
  args: string[],
  input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<string> {
  return (await runCommand(input.githubCommand ?? "gh", args, rootPath, input, deps)).stdout.trim();
}

async function runCommand(
  command: string,
  args: string[],
  rootPath: string,
  _input: { githubCommand?: string },
  deps: GitHubPrActionDeps,
): Promise<CommandResult> {
  if (deps.runCommand) return deps.runCommand(command, args, { cwd: rootPath });
  const result = await execFileAsync(command, args, {
    cwd: rootPath,
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function remote(owner: string, repo: string): GitHubRemote {
  const normalizedRepo = repo.replace(/\.git$/, "");
  return { owner, repo: normalizedRepo, nameWithOwner: `${owner}/${normalizedRepo}` };
}

function prIdentity(entry: Record<string, unknown>): GitHubPullRequestIdentity {
  return {
    number: typeof entry.number === "number" ? entry.number : null,
    title: typeof entry.title === "string" ? entry.title : null,
    url: String(entry.url ?? entry.html_url ?? ""),
    state: String(entry.state ?? "OPEN"),
    headRefName: typeof entry.headRefName === "string" ? entry.headRefName : null,
    baseRefName: typeof entry.baseRefName === "string" ? entry.baseRefName : null,
    headSha: typeof entry.headRefOid === "string" ? entry.headRefOid : null,
  };
}
