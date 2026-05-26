import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateReviewers,
  buildJiraSearchJql,
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
  parseJiraSearchOutput,
  parseJiraTransitionsOutput,
  resolveJiraTransitionByTargetStatus,
  searchJiraIssues,
  setJiraCommand,
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

  describe("buildJiraSearchJql", () => {
    it("returns the recent-default JQL (assignee OR reporter OR watcher) when query is null or empty", () => {
      const recent = buildJiraSearchJql(null);
      expect(recent).toContain("assignee = currentUser()");
      expect(recent).toContain("reporter = currentUser()");
      expect(recent).toContain("watcher = currentUser()");
      expect(recent).toContain("updated >= -14d");
      expect(recent).toContain("ORDER BY updated DESC");
      expect(buildJiraSearchJql("")).toBe(recent);
      expect(buildJiraSearchJql("   ")).toBe(recent);
    });

    it("routes issue-key-shaped input to a key = JQL and normalises case", () => {
      // Lower-case input should be upper-cased; whitespace trimmed.
      expect(buildJiraSearchJql("auth-123")).toBe('key = "AUTH-123" ORDER BY updated DESC');
      expect(buildJiraSearchJql("  MS-496 ")).toBe('key = "MS-496" ORDER BY updated DESC');
      // Multi-word project keys with digits also match.
      expect(buildJiraSearchJql("CIT2-9")).toBe('key = "CIT2-9" ORDER BY updated DESC');
    });

    it("routes free-text input to a summary ~ JQL and strips Lucene-reserved characters", () => {
      // Lucene reserved set per Jira's docs:
      // + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /  plus newlines.
      // The wrapping quotes around the operand are intentional, so we
      // assert on the operand portion (the substring between the quotes),
      // not on the full JQL string.
      const operandOf = (jql: string): string => jql.match(/^summary ~ "([^"]*)"/)?.[1] ?? "";
      const specials = [
        "+", "-", "&&", "||", "!", "(", ")", "{", "}", "[", "]", "^", '"', "~", "*", "?", ":", "\\", "/",
      ];
      for (const ch of specials) {
        const jql = buildJiraSearchJql(`auth${ch}login`);
        expect(jql).toMatch(/^summary ~ "/);
        expect(operandOf(jql).includes(ch)).toBe(false);
      }
      // Newlines and carriage returns are stripped, not embedded in the JQL.
      expect(buildJiraSearchJql("auth\nlogin\rflow")).toBe('summary ~ "auth login flow" ORDER BY updated DESC');
      // Internal whitespace collapsed, trimmed.
      expect(buildJiraSearchJql("  auth   login  ")).toBe('summary ~ "auth login" ORDER BY updated DESC');
    });

    it("treats almost-key-shaped strings as free text (does not match the key regex)", () => {
      // Looks tempting but contains an OR — must NOT be routed to `key =`.
      const jql = buildJiraSearchJql("AUTH-123 OR DROP");
      expect(jql.startsWith("summary ~")).toBe(true);
      // The stripped query no longer contains a stray dash that would form a bad key match.
      expect(jql).toContain("AUTH 123 OR DROP");
    });
  });

  describe("parseJiraSearchOutput", () => {
    it("parses jtk search output rows into IssueSearchResult[]", () => {
      const output = [
        "KEY | SUMMARY | STATUS | UPDATED",
        "MS-1 | Build picker | In Progress | 2026-05-17",
        "MS-2 | Wire transitions | To Do | 2026-05-16",
      ].join("\n");
      expect(parseJiraSearchOutput(output)).toEqual([
        { key: "MS-1", summary: "Build picker", status: "In Progress", url: null, updated: "2026-05-17" },
        { key: "MS-2", summary: "Wire transitions", status: "To Do", url: null, updated: "2026-05-16" },
      ]);
    });

    it("tolerates missing trailing fields (empty status, no updated)", () => {
      const output = [
        "KEY | SUMMARY | STATUS | UPDATED",
        "MS-3 | Half-row |  | ",
        "MS-4 | Truncated",
      ].join("\n");
      const parsed = parseJiraSearchOutput(output);
      expect(parsed).toEqual([
        { key: "MS-3", summary: "Half-row", status: null, url: null, updated: null },
        { key: "MS-4", summary: "Truncated", status: null, url: null, updated: null },
      ]);
    });

    it("skips header-only and blank-only output safely", () => {
      expect(parseJiraSearchOutput("")).toEqual([]);
      expect(parseJiraSearchOutput("KEY | SUMMARY | STATUS | UPDATED\n")).toEqual([]);
      expect(parseJiraSearchOutput("\n\n   \n")).toEqual([]);
    });
  });

  describe("searchJiraIssues", () => {
    // Force-degrade by pointing the jtk override at a missing binary so the
    // test isn't flaky based on whether the host happens to have `jtk`
    // installed and authed. Mirrors the pattern in collectJiraIssueSummary's
    // existing "not-a-real-issue-key" test — keep failure paths deterministic.
    afterEach(() => setJiraCommand(undefined));

    it("returns a degraded response with empty results when the configured jtk binary is missing", async () => {
      setJiraCommand("citadel-test-no-such-jtk-binary");
      const response = await searchJiraIssues("AUTH-123");
      expect(response.status).toBe("degraded");
      expect(response.reason).toBeTruthy();
      expect(response.results).toEqual([]);
    });

    it("also degrades safely when called with a null/empty query (recent-by-default path)", async () => {
      setJiraCommand("citadel-test-no-such-jtk-binary");
      const response = await searchJiraIssues(null);
      expect(response.status).toBe("degraded");
      expect(response.results).toEqual([]);
    });
  });

  describe("resolveJiraTransitionByTargetStatus", () => {
    it("matches a transition whose toStatus equals the configured target (case-insensitive)", () => {
      const transitions = [
        { id: "21", name: "Start Progress", toStatus: "In Progress" },
        { id: "31", name: "Done", toStatus: "Done" },
      ];
      // The transition's name ("Start Progress") differs from its toStatus
      // ("In Progress"); the resolver matches by toStatus, not by name.
      // This is what makes the config field "target status name" instead
      // of "transition name".
      expect(resolveJiraTransitionByTargetStatus(transitions, "in progress")).toBe("21");
      expect(resolveJiraTransitionByTargetStatus(transitions, "Done")).toBe("31");
    });

    it("falls back to matching by transition.name when no toStatus matches (back-compat)", () => {
      const transitions = [{ id: "11", name: "Triage", toStatus: "Backlog" }];
      // Operators may have already configured `transition: "Triage"`
      // before the semantic clarification; tolerate it.
      expect(resolveJiraTransitionByTargetStatus(transitions, "triage")).toBe("11");
    });

    it("returns null when neither toStatus nor name matches", () => {
      expect(resolveJiraTransitionByTargetStatus([{ id: "11", name: "X", toStatus: "Y" }], "Done")).toBeNull();
      expect(resolveJiraTransitionByTargetStatus([], "Done")).toBeNull();
    });
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
