import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateReviewers,
  collectGitHubCiRunLog,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectProviderHealth,
  collectRuntimeUsage,
  commandHealth,
  detectParentPr,
  isGhNoPullRequestError,
  isRateLimitError,
  mergePr,
  normalizeCheck,
  normalizeCiRun,
  normalizeCiRunList,
  normalizePrCommit,
  normalizeRuntimeUsage,
  pLimit,
  setGithubCommand,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  setGithubCommand(undefined);
});

describe("commandHealth", () => {
  it("reports disabled providers as unavailable", async () => {
    const health = await commandHealth({
      id: "disabled",
      displayName: "Disabled",
      kind: "ci",
      command: "missing-command",
      args: [],
      enabled: false,
    });

    expect(health.status).toBe("unavailable");
  });

  it("reports successful shell providers as healthy", async () => {
    const health = await commandHealth({
      id: "node",
      displayName: "Node",
      kind: "version-control",
      command: "node",
      args: ["-e", "process.exit(0)"],
      enabled: true,
    });

    expect(health.status).toBe("healthy");
  });

  it("reports failed commands as degraded with a reason", async () => {
    const health = await commandHealth({
      id: "failing",
      displayName: "Failing",
      kind: "ci",
      command: "node",
      args: ["-e", "process.exit(3)"],
      enabled: true,
    });

    expect(health.status).toBe("degraded");
    expect(health.reason).toContain("Command failed");
  });

  it("can skip GitHub health without spawning gh", async () => {
    const [github] = await collectProviderHealth(
      {
        github: { enabled: true, command: "missing-gh-command" },
        jira: { enabled: false, command: "missing-jira-command" },
      },
      { skipGithubReason: "automation disabled" },
    );

    expect(github).toMatchObject({
      id: "github-gh",
      status: "unavailable",
      reason: "automation disabled",
    });
  });

  it("returns degraded normalized summaries for invalid repos", async () => {
    const summary = await collectGitHubVersionControlSummary("/definitely/not/a/repo");

    expect(summary.providerId).toBe("github-gh");
    expect(summary.status).toBe("degraded");
    expect(summary.pullRequest).toBeNull();
  });

  it("summarizes local git repositories without requiring an open pull request", async () => {
    const repoPath = createGitFixture();

    const summary = await collectGitHubVersionControlSummary(repoPath);

    expect(summary).toMatchObject({
      providerId: "github-gh",
      status: "healthy",
      reason: null,
      defaultBranch: "main",
      currentBranch: "main",
      remotes: [],
      pullRequest: null,
    });
    expect(Date.parse(summary.checkedAt)).not.toBeNaN();
  });

  it("normalizes GitHub Actions CI runs and degrades without a valid repo", async () => {
    expect(
      normalizeCiRun({
        databaseId: 123,
        name: "CI",
        status: "completed",
        conclusion: "success",
        headBranch: "main",
        event: "push",
        url: "https://example.test/run/123",
        createdAt: "2026-05-17T00:00:00Z",
      }),
    ).toMatchObject({ id: "123", name: "CI", conclusion: "success", branch: "main" });
    expect(normalizeCiRunList('[{"databaseId":456,"name":"Test","status":"queued"}]')[0]).toMatchObject({
      id: "456",
      name: "Test",
      conclusion: null,
    });

    const summary = await collectGitHubCiRuns("/definitely/not/a/repo");
    expect(summary.status).toBe("degraded");
    expect(summary.runs).toEqual([]);
    const log = await collectGitHubCiRunLog("/definitely/not/a/repo", "123");
    expect(log.status).toBe("degraded");
    expect(log.log).toBe("");
  });

  it("normalizes GitHub check runs including startedAt/completedAt and tolerates missing timestamps", () => {
    expect(
      normalizeCheck({
        name: "unit",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://example.test/check",
        startedAt: "2026-05-17T00:00:00Z",
        completedAt: "2026-05-17T00:01:30Z",
      }),
    ).toEqual({
      name: "unit",
      status: "completed",
      conclusion: "success",
      url: "https://example.test/check",
      startedAt: "2026-05-17T00:00:00Z",
      completedAt: "2026-05-17T00:01:30Z",
    });
    expect(normalizeCheck({ context: "legacy-status", state: "PENDING" })).toEqual({
      name: "legacy-status",
      status: "PENDING",
      conclusion: null,
      url: null,
      startedAt: null,
      completedAt: null,
    });
  });

  it("aggregates the latest review per author and promotes re-requested reviewers to pending", () => {
    const reviewers = aggregateReviewers(
      [
        {
          author: { login: "ovi", name: "Ovi M" },
          state: "COMMENTED",
          submittedAt: "2026-05-22T10:00:00Z",
        },
        {
          author: { login: "ovi", name: "Ovi M" },
          state: "APPROVED",
          submittedAt: "2026-05-22T11:00:00Z",
        },
        {
          author: { login: "jon", name: "Jon S" },
          state: "CHANGES_REQUESTED",
          submittedAt: "2026-05-22T09:00:00Z",
        },
      ],
      [
        { login: "jon", name: "Jon S" },
        { login: "alex", name: "Alex P" },
      ],
    );
    const byLogin = Object.fromEntries(reviewers.map((reviewer) => [reviewer.login, reviewer]));
    expect(reviewers).toHaveLength(3);
    // Exclusivity: ovi's earlier COMMENTED review must not slip through; only the
    // latest APPROVED state survives.
    expect(byLogin.ovi).toEqual({ login: "ovi", name: "Ovi M", state: "approved" });
    expect(byLogin.jon).toEqual({ login: "jon", name: "Jon S", state: "pending" });
    expect(byLogin.alex).toEqual({ login: "alex", name: "Alex P", state: "pending" });
  });

  it("maps every GitHub review state and falls back to 'pending' for unknown/null states", () => {
    const reviewers = aggregateReviewers(
      [
        { author: { login: "dis", name: null }, state: "DISMISSED", submittedAt: "2026-05-22T01:00:00Z" },
        { author: { login: "com", name: null }, state: "COMMENTED", submittedAt: "2026-05-22T02:00:00Z" },
        { author: { login: "unk", name: null }, state: "MYSTERY_STATE", submittedAt: "2026-05-22T03:00:00Z" },
        { author: { login: "nul", name: null }, state: null, submittedAt: "2026-05-22T04:00:00Z" },
      ],
      [],
    );
    const byLogin = Object.fromEntries(reviewers.map((reviewer) => [reviewer.login, reviewer.state]));
    expect(byLogin).toEqual({ dis: "dismissed", com: "commented", unk: "pending", nul: "pending" });
  });

  it("drops reviews and reviewRequests with falsy logins and backfills missing name from the request", () => {
    const reviewers = aggregateReviewers(
      [
        { author: null, state: "APPROVED", submittedAt: "2026-05-22T05:00:00Z" },
        { author: { login: "", name: "Anon" }, state: "APPROVED", submittedAt: "2026-05-22T06:00:00Z" },
        { author: { login: "needs-name", name: null }, state: "APPROVED", submittedAt: "2026-05-22T07:00:00Z" },
      ],
      [
        { login: null, name: "ignored" },
        { login: "needs-name", name: "Backfilled" },
      ],
    );
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0]).toEqual({ login: "needs-name", name: "Backfilled", state: "pending" });
  });

  it("normalizes runtime usage emitted by an external provider command", () => {
    const summary = normalizeRuntimeUsage(
      "custom-bot",
      "usage-custom",
      JSON.stringify({
        source: "custom-usage",
        categories: [
          { label: "Daily", percentUsed: 42, reset: "tomorrow" },
          { label: "Bogus", percentUsed: 250 },
          { label: "Weekly", percentUsed: 10, section: "Premium tier" },
        ],
      }),
    );
    expect(summary).toMatchObject({ runtimeId: "custom-bot", status: "healthy", source: "custom-usage" });
    // The 250%-used row is dropped (out of range); others survive.
    expect(summary.categories).toEqual([
      { label: "Daily", percentUsed: 42, reset: "tomorrow", section: null },
      { label: "Weekly", percentUsed: 10, reset: null, section: "Premium tier" },
    ]);
  });

  it("reports custom runtimes without an external usage provider as unavailable", async () => {
    const unsupported = await collectRuntimeUsage({
      runtimeId: "custom-bot",
      command: "custom-bot",
      args: [],
    });
    expect(unsupported).toMatchObject({
      runtimeId: "custom-bot",
      status: "unavailable",
      reason: "No usage provider configured for this runtime",
    });
    expect(unsupported.categories).toEqual([]);
  });
});

describe("PR display helpers", () => {
  it("pLimit never lets more than N tasks run concurrently", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    let gate: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      gate = resolve;
    });
    const tasks = Array.from({ length: 6 }, () =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await open;
        active -= 1;
      }),
    );
    // Let microtasks settle so the limiter has a chance to schedule.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(peak).toBe(2);
    gate();
    await Promise.all(tasks);
    // Even after the gate releases everyone, the peak observed during the
    // ramp-up must have stayed at the limit.
    expect(peak).toBe(2);
  });

  it("normalizePrCommit extracts sha, shortSha, message and defaults checks to []", () => {
    expect(
      normalizePrCommit({
        oid: "1234567890abcdef1234567890abcdef12345678",
        messageHeadline: "feat: add things",
      }),
    ).toEqual({
      sha: "1234567890abcdef1234567890abcdef12345678",
      shortSha: "1234567",
      message: "feat: add things",
      checks: [],
    });
  });

  it("normalizePrCommit prefers messageHeadline but falls back to first line of message", () => {
    expect(
      normalizePrCommit({
        oid: "abcdef0123456789abcdef0123456789abcdef01",
        message: "fix: thing\n\nwith body\n",
      }).message,
    ).toBe("fix: thing");
  });

  it("detectParentPr matches headRefName + headRepository on open + recently-merged PRs", () => {
    const openPrs = [
      {
        number: 42,
        url: "https://x.test/pr/42",
        headRefName: "feature/auth",
        state: "OPEN",
        headRepository: "org/repo",
      },
      {
        number: 43,
        url: "https://x.test/pr/43",
        headRefName: "feature/auth",
        state: "MERGED",
        headRepository: "org/repo",
      },
      {
        number: 99,
        url: "https://x.test/pr/99",
        headRefName: "feature/auth",
        state: "OPEN",
        headRepository: "org/fork",
      },
    ];
    // Open match wins over merged match in the same repo.
    expect(detectParentPr({ baseRefName: "feature/auth", headRepository: "org/repo" }, openPrs)).toEqual({
      number: 42,
      url: "https://x.test/pr/42",
      headRefName: "feature/auth",
      state: "OPEN",
    });
    // Cross-repo match is ignored.
    expect(detectParentPr({ baseRefName: "feature/fork-only", headRepository: "org/repo" }, openPrs)).toBeNull();
    // Merged-only parents are still surfaced (with state).
    const mergedOnly = [
      {
        number: 50,
        url: "https://x.test/pr/50",
        headRefName: "feature/ship",
        state: "MERGED",
        headRepository: "org/repo",
      },
    ];
    expect(detectParentPr({ baseRefName: "feature/ship", headRepository: "org/repo" }, mergedOnly)?.state).toBe(
      "MERGED",
    );
  });

  it("mergePr returns structured failures and never passes --delete-branch", async () => {
    const calls: string[][] = [];
    // Inject a fake gh runner: rejects with the "Pull request is not mergeable" message.
    const result = await mergePr({ rootPath: "/tmp/x", number: 7, strategy: "squash" }, async (args) => {
      calls.push(args);
      throw new Error("Pull request is not mergeable");
    });
    expect(result).toEqual({ ok: false, reason: "not_mergeable", detail: "Pull request is not mergeable" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--squash");
    expect(calls[0]).not.toContain("--delete-branch");
  });

  it("mergePr returns ok:true on successful gh exit", async () => {
    const result = await mergePr({ rootPath: "/tmp/x", number: 8, strategy: "merge" }, async () => "");
    expect(result).toEqual({ ok: true });
  });

  it("mergePr classifies gh failure messages into structured reasons", async () => {
    const auth = await mergePr({ rootPath: "/tmp/x", number: 1, strategy: "squash" }, async () => {
      throw new Error("gh: not authorized");
    });
    expect(auth).toMatchObject({ ok: false, reason: "gh_auth" });

    const strategy = await mergePr({ rootPath: "/tmp/x", number: 1, strategy: "rebase" }, async () => {
      throw new Error("rebase merge is not allowed by repository");
    });
    expect(strategy).toMatchObject({ ok: false, reason: "strategy_disallowed" });

    const unknown = await mergePr({ rootPath: "/tmp/x", number: 1, strategy: "merge" }, async () => {
      throw new Error("network something happened");
    });
    expect(unknown).toMatchObject({ ok: false, reason: "gh_error" });
  });

  it("detectParentPr accepts both string and {nameWithOwner} headRepository shapes (gh JSON returns the object)", () => {
    const candidates = [
      {
        number: 50,
        url: "https://x.test/pr/50",
        headRefName: "feature/ship",
        state: "OPEN",
        headRepository: { nameWithOwner: "org/repo" },
      },
    ];
    expect(detectParentPr({ baseRefName: "feature/ship", headRepository: "org/repo" }, candidates)).toMatchObject({
      number: 50,
      state: "OPEN",
    });
  });

  it("isGhNoPullRequestError recognises gh's 'no pull requests found' messages so transient gh failures stay distinct", () => {
    expect(isGhNoPullRequestError(new Error('no pull requests found for branch "feature/x"'))).toBe(true);
    expect(isGhNoPullRequestError(new Error("no open pull requests found in org/repo"))).toBe(true);
    expect(isGhNoPullRequestError({ stderr: "no pull request found for branch foo" })).toBe(true);
    // Transient failures must not match — those propagate up so the VC summary
    // degrades and the client preserves the cached PR.
    expect(isGhNoPullRequestError(new Error("HTTP 502 from api.github.com"))).toBe(false);
    expect(isGhNoPullRequestError(new Error("gh auth status: not logged in"))).toBe(false);
    expect(isGhNoPullRequestError(undefined)).toBe(false);
  });

  it("fetchParentPr uses cached branch lookup before spawning gh pr list", async () => {
    const repoPath = createGitFixture();
    addOriginRemote(repoPath);
    const gh = fakeGh();
    setGithubCommand(gh.script);

    const summary = await collectGitHubVersionControlSummary(repoPath, {
      resolveNameWithOwner: () => "owner/repo",
      lookupCachedPrByBranch: () => ({
        number: 6,
        title: "Parent",
        url: "https://example.test/pr/6",
        state: "OPEN",
        draft: false,
        reviewDecision: null,
        checks: [],
        additions: null,
        deletions: null,
        reviewers: [],
        commits: [],
        headRefName: "parent",
        parentPr: null,
        mergeable: "unknown",
        allowedMergeStrategies: [],
        mergeStateStatus: null,
        headSha: null,
      }),
    });

    expect(summary.pullRequest?.parentPr).toEqual({
      number: 6,
      url: "https://example.test/pr/6",
      headRefName: "parent",
      state: "OPEN",
    });
    expect(gh.calls().filter((call) => call === "pr list")).toHaveLength(0);
  });

  it("fetchParentPr falls through to cached gh pr list when no global parent is cached", async () => {
    const repoPath = createGitFixture();
    addOriginRemote(repoPath);
    const gh = fakeGh();
    setGithubCommand(gh.script);
    const repoCache = new Map<string, string>();
    const repoCacheLookup = async (key: string, load: () => Promise<string>) => {
      const cached = repoCache.get(key);
      if (cached) return cached;
      const value = await load();
      repoCache.set(key, value);
      return value;
    };

    await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => "owner/repo",
      lookupCachedPrByBranch: () => null,
    });
    const second = await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => "owner/repo",
      lookupCachedPrByBranch: () => null,
    });

    expect(second.pullRequest?.parentPr?.number).toBe(6);
    expect(gh.calls().filter((call) => call === "pr list")).toHaveLength(1);
  });

  it("fetchAllowedMergeStrategies uses the repo cache only when nameWithOwner resolves", async () => {
    const repoPath = createGitFixture();
    addOriginRemote(repoPath);
    const gh = fakeGh();
    setGithubCommand(gh.script);
    const repoCache = new Map<string, string>();
    const repoCacheLookup = async (key: string, load: () => Promise<string>) => {
      const cached = repoCache.get(key);
      if (cached) return cached;
      const value = await load();
      repoCache.set(key, value);
      return value;
    };

    await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => "owner/repo",
      lookupCachedPrByBranch: () => null,
    });
    await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => "owner/repo",
      lookupCachedPrByBranch: () => null,
    });
    expect(gh.calls().filter((call) => call === "repo view")).toHaveLength(1);

    const uncachedGh = fakeGh();
    setGithubCommand(uncachedGh.script);
    await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => null,
      lookupCachedPrByBranch: () => null,
    });
    await collectGitHubVersionControlSummary(repoPath, {
      repoCacheLookup,
      resolveNameWithOwner: () => null,
      lookupCachedPrByBranch: () => null,
    });
    expect(uncachedGh.calls().filter((call) => call === "repo view")).toHaveLength(2);
  });
});

describe("isRateLimitError", () => {
  it("matches the GraphQL rate-limit message gh prints in stderr", () => {
    expect(
      isRateLimitError({
        stderr:
          "could not load events: failed to get current username: GraphQL: API rate limit already exceeded for user ID 15231070",
      }),
    ).toBeTruthy();
  });

  it("matches the REST rate-limit message", () => {
    expect(isRateLimitError({ stderr: "API rate limit exceeded for user ID 1." })).toBeTruthy();
  });

  it("matches secondary/abuse rate-limit messages", () => {
    expect(isRateLimitError({ stderr: "You have exceeded a secondary rate limit." })).toBeTruthy();
    expect(isRateLimitError({ stderr: "abuse-rate-limit triggered" })).toBeTruthy();
  });

  it("does not match unrelated gh errors", () => {
    expect(isRateLimitError({ stderr: "no pull requests found for branch" })).toBe(false);
    expect(isRateLimitError({ stderr: "could not resolve host: api.github.com" })).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-provider-"));
  dirs.push(dir);
  const repoPath = path.join(dir, "repo");
  fs.mkdirSync(repoPath);
  run("git", ["init", "-b", "main"], repoPath);
  run("git", ["config", "user.email", "test@example.test"], repoPath);
  run("git", ["config", "user.name", "Citadel Test"], repoPath);
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  run("git", ["add", "README.md"], repoPath);
  run("git", ["commit", "-m", "initial"], repoPath);
  return repoPath;
}

function run(command: string, args: string[], cwd: string) {
  execFileSync(command, args, { cwd, stdio: "pipe" });
}

function addOriginRemote(repoPath: string) {
  run("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], repoPath);
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], repoPath);
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], repoPath);
}

function fakeGh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-provider-gh-"));
  dirs.push(dir);
  const callsPath = path.join(dir, "calls.txt");
  const script = path.join(dir, "gh");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash
echo "$1 $2" >> "${callsPath}"
if [ "$1 $2" = "pr view" ]; then
  cat <<'JSON'
{"number":7,"title":"Child","url":"https://example.test/pr/7","state":"OPEN","isDraft":false,"reviewDecision":null,"statusCheckRollup":[],"additions":1,"deletions":2,"reviews":[],"reviewRequests":[],"commits":[],"baseRefName":"parent","headRefName":"feature","headRepository":{"nameWithOwner":"owner/repo"},"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","headRefOid":"abc123"}
JSON
elif [ "$1 $2" = "repo view" ]; then
  echo '{"mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":false}'
elif [ "$1 $2" = "pr list" ]; then
  echo '[{"number":6,"url":"https://example.test/pr/6","headRefName":"parent","headRepository":{"nameWithOwner":"owner/repo"},"state":"OPEN"}]'
else
  echo '{}'
fi
`,
  );
  fs.chmodSync(script, 0o755);
  return {
    script,
    calls: () =>
      fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}
