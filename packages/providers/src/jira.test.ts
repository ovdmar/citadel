import { afterEach, describe, expect, it } from "vitest";
import {
  buildJiraSearchJql,
  collectJiraIssueSummary,
  parseJiraIssueOutput,
  parseJiraSearchOutput,
  parseJiraTransitionsOutput,
  resolveJiraTransitionByTargetStatus,
  searchJiraIssues,
  setJiraCommand,
  transitionJiraIssue,
} from "./index.js";

afterEach(() => {
  setJiraCommand(undefined);
});

describe("jira provider", () => {
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
    it("returns the recent-default JQL when query is null or empty", () => {
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
      expect(buildJiraSearchJql("auth-123")).toBe('key = "AUTH-123" ORDER BY updated DESC');
      expect(buildJiraSearchJql("  MS-496 ")).toBe('key = "MS-496" ORDER BY updated DESC');
      expect(buildJiraSearchJql("CIT2-9")).toBe('key = "CIT2-9" ORDER BY updated DESC');
    });

    it("routes free-text input to a summary ~ JQL and strips Lucene-reserved characters", () => {
      const operandOf = (jql: string): string => jql.match(/^summary ~ "([^"]*)"/)?.[1] ?? "";
      const specials = [
        "+",
        "-",
        "&&",
        "||",
        "!",
        "(",
        ")",
        "{",
        "}",
        "[",
        "]",
        "^",
        '"',
        "~",
        "*",
        "?",
        ":",
        "\\",
        "/",
      ];
      for (const ch of specials) {
        const jql = buildJiraSearchJql(`auth${ch}login`);
        expect(jql).toMatch(/^summary ~ "/);
        expect(operandOf(jql).includes(ch)).toBe(false);
      }
      expect(buildJiraSearchJql("auth\nlogin\rflow")).toBe('summary ~ "auth login flow" ORDER BY updated DESC');
      expect(buildJiraSearchJql("  auth   login  ")).toBe('summary ~ "auth login" ORDER BY updated DESC');
    });

    it("treats almost-key-shaped strings as free text", () => {
      const jql = buildJiraSearchJql("AUTH-123 OR DROP");
      expect(jql.startsWith("summary ~")).toBe(true);
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

    it("tolerates missing trailing fields", () => {
      const output = ["KEY | SUMMARY | STATUS | UPDATED", "MS-3 | Half-row |  | ", "MS-4 | Truncated"].join("\n");
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
    it("returns a degraded response with empty results when the configured jtk binary is missing", async () => {
      setJiraCommand("citadel-test-no-such-jtk-binary");
      const response = await searchJiraIssues("AUTH-123");
      expect(response.status).toBe("degraded");
      expect(response.reason).toBeTruthy();
      expect(response.results).toEqual([]);
    });

    it("also degrades safely when called with a null/empty query", async () => {
      setJiraCommand("citadel-test-no-such-jtk-binary");
      const response = await searchJiraIssues(null);
      expect(response.status).toBe("degraded");
      expect(response.results).toEqual([]);
    });
  });

  describe("resolveJiraTransitionByTargetStatus", () => {
    it("matches a transition whose toStatus equals the configured target", () => {
      const transitions = [
        { id: "21", name: "Start Progress", toStatus: "In Progress" },
        { id: "31", name: "Done", toStatus: "Done" },
      ];
      expect(resolveJiraTransitionByTargetStatus(transitions, "in progress")).toBe("21");
      expect(resolveJiraTransitionByTargetStatus(transitions, "Done")).toBe("31");
    });

    it("falls back to matching by transition.name when no toStatus matches", () => {
      const transitions = [{ id: "11", name: "Triage", toStatus: "Backlog" }];
      expect(resolveJiraTransitionByTargetStatus(transitions, "triage")).toBe("11");
    });

    it("returns null when neither toStatus nor name matches", () => {
      expect(resolveJiraTransitionByTargetStatus([{ id: "11", name: "X", toStatus: "Y" }], "Done")).toBeNull();
      expect(resolveJiraTransitionByTargetStatus([], "Done")).toBeNull();
    });
  });
});
