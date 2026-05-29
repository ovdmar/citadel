import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueTrackerSummary, IssueTransition, IssueTransitionActionResult } from "@citadel/contracts";

const execFileAsync = promisify(execFile);

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
