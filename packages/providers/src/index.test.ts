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
  collectJiraIssueSummary,
  collectRuntimeUsage,
  commandHealth,
  normalizeCheck,
  normalizeCiRun,
  normalizeCiRunList,
  normalizeRuntimeUsage,
  parseJiraIssueOutput,
  parseJiraTransitionsOutput,
  transitionJiraIssue,
} from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
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

  it("parses Jira issue details and workflow transitions", () => {
    expect(
      parseJiraIssueOutput(
        "Key: MS-496\nSummary: Citadel: prepare and run v2 headless implementation campaign\nStatus: To Do\nAssignee: Unassigned\nUpdated: 2026-05-17\n",
      ),
    ).toEqual({
      key: "MS-496",
      summary: "Citadel: prepare and run v2 headless implementation campaign",
      issueStatus: "To Do",
      assignee: "Unassigned",
      updated: "2026-05-17",
    });
    expect(
      parseJiraTransitionsOutput("ID | NAME | TO_STATUS\n21 | In Progress | In Progress\n31 | Done | Done\n"),
    ).toEqual([
      { id: "21", name: "In Progress", toStatus: "In Progress" },
      { id: "31", name: "Done", toStatus: "Done" },
    ]);
  });

  it("returns degraded Jira summaries when issue lookup fails", async () => {
    const summary = await collectJiraIssueSummary("not-a-real-issue-key");

    expect(summary.providerId).toBe("jira-jtk");
    expect(summary.status).toBe("degraded");
    expect(summary.key).toBe("NOT-A-REAL-ISSUE-KEY");
    expect(summary.transitions).toEqual([]);
  });

  it("returns degraded Jira transition results when transition fails", async () => {
    const result = await transitionJiraIssue({ issueKey: "not-a-real-issue-key", transition: "31" });

    expect(result.providerId).toBe("jira-jtk");
    expect(result.status).toBe("degraded");
    expect(result.key).toBe("NOT-A-REAL-ISSUE-KEY");
    expect(result.transition).toBe("31");
  });

  it("normalizes runtime usage and reports unsupported runtimes clearly", async () => {
    expect(
      normalizeRuntimeUsage(
        "codex",
        "usage-codex",
        JSON.stringify({ source: "codex-usage", model: "gpt", remaining: "42%", spend: "$1.25" }),
      ),
    ).toMatchObject({ runtimeId: "codex", status: "healthy", remaining: "42%" });

    const unsupported = await collectRuntimeUsage("codex", undefined);
    expect(unsupported).toMatchObject({
      runtimeId: "codex",
      status: "unavailable",
      reason: "No usage provider configured for this runtime",
    });
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
