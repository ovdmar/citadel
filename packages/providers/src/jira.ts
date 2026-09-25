import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  IssueSearchResponse,
  IssueSearchResult,
  IssueTrackerSummary,
  IssueTransition,
  IssueTransitionActionResult,
} from "@citadel/contracts";

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

// Issue keys per Jira's docs: project key + dash + numeric id. Match
// case-insensitively (we upper-case below) and require the full string so
// "AUTH-123 OR DROP" goes to the summary search, not the key search.
const ISSUE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;

// JQL operands inside `summary ~` are interpreted by Jira's Lucene parser;
// stripping the reserved set is more robust than escaping because most are
// not useful inside a summary search anyway.
const LUCENE_SPECIALS_RE = /[+\-&|!(){}\[\]^"~*?:\\/]/g;

export function buildJiraSearchJql(query: string | null): string {
  const trimmed = (query ?? "").trim();
  if (!trimmed) {
    // Broaden beyond `assignee` so reviewer / watcher tickets surface too —
    // operators commonly attach a ticket assigned to someone else.
    return "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -14d ORDER BY updated DESC";
  }
  if (ISSUE_KEY_RE.test(trimmed)) {
    return `key = "${trimmed.toUpperCase()}" ORDER BY updated DESC`;
  }
  // Strip Lucene-reserved characters and collapse whitespace. JQL is passed
  // to jtk via argv so shell-injection is already moot; this is purely
  // about keeping Lucene from mis-parsing the operand.
  const sanitized = trimmed.replace(LUCENE_SPECIALS_RE, " ").replace(/\s+/g, " ").trim();
  return `summary ~ "${sanitized}" ORDER BY updated DESC`;
}

export function parseJiraSearchOutput(output: string): IssueSearchResult[] {
  const results: IssueSearchResult[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("KEY |")) continue;
    const parts = line.split("|").map((part) => part.trim());
    const key = parts[0];
    if (!key) continue;
    results.push({
      key,
      summary: parts[1] ? parts[1] : null,
      status: parts[2] ? parts[2] : null,
      url: null,
      updated: parts[3] ? parts[3] : null,
    });
  }
  return results;
}

export async function searchJiraIssues(query: string | null): Promise<IssueSearchResponse> {
  const jql = buildJiraSearchJql(query);
  try {
    const raw = await jtk(["issues", "search", "--jql", jql, "--max", "20", "--no-color"]);
    return { status: "healthy", reason: null, results: parseJiraSearchOutput(raw) };
  } catch (error) {
    return {
      status: "degraded",
      reason: error instanceof Error ? error.message : "Jira search failed",
      results: [],
    };
  }
}

// Picks a transition from a list whose `toStatus` matches the configured
// target status (case-insensitive). Falls back to matching by transition
// name so operators who configured the transition name (instead of the
// target status) before the semantic clarification still work.
export function resolveJiraTransitionByTargetStatus(transitions: IssueTransition[], target: string): string | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;
  for (const t of transitions) {
    if (t.toStatus.trim().toLowerCase() === needle) return t.id;
  }
  for (const t of transitions) {
    if (t.name.trim().toLowerCase() === needle) return t.id;
  }
  return null;
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
