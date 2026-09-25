import { describe, expect, it } from "vitest";
import { jiraStatusTone } from "./jira-picker.js";

// Plan QA strategy required full <JiraIssuePicker> component tests, but
// the repo has no React Testing Library + jsdom infrastructure (no .tsx
// test files are discovered by vitest today). React component testing
// infrastructure is deferred to a separate PR; UI behaviors are covered
// by the Playwright spec in e2e/jira-picker.spec.ts. This file covers the
// only piece of jira-picker.tsx that does not require a DOM — the status
// → tone classifier — so a regression in tone classification (which
// drives the cit-jira-status--{tone} CSS) is caught at unit level.

describe("jiraStatusTone", () => {
  it("maps Jira-style status strings to tone buckets case-insensitively", () => {
    expect(jiraStatusTone("Done")).toBe("done");
    expect(jiraStatusTone("Closed")).toBe("done");
    expect(jiraStatusTone("Resolved")).toBe("done");
    expect(jiraStatusTone("In Review")).toBe("review");
    expect(jiraStatusTone("Code Review")).toBe("review");
    expect(jiraStatusTone("In Progress")).toBe("progress");
    expect(jiraStatusTone("Doing")).toBe("progress");
    expect(jiraStatusTone("Blocked")).toBe("blocked");
    expect(jiraStatusTone("Blocker")).toBe("blocked");
  });

  it("falls back to 'todo' for unknown statuses (including empty string)", () => {
    expect(jiraStatusTone("To Do")).toBe("todo");
    expect(jiraStatusTone("Backlog")).toBe("todo");
    expect(jiraStatusTone("Triage")).toBe("todo");
    expect(jiraStatusTone("")).toBe("todo");
  });

  it("matches substring tokens (mixed-case Jira statuses)", () => {
    // Lots of teams customize Jira statuses with prefixes; the matcher
    // looks for substrings rather than exact equality.
    expect(jiraStatusTone("QA In Progress")).toBe("progress");
    expect(jiraStatusTone("PR Review")).toBe("review");
    expect(jiraStatusTone("BLOCKED ON UPSTREAM")).toBe("blocked");
  });
});
