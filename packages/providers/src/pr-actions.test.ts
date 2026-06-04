import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitHubPullRequest,
  dirtyWarningsFromPorcelain,
  isGraphqlRateLimitError,
  parseGitHubRemoteUrl,
  type CommandRunner,
} from "./pr-actions.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("GitHub PR actions", () => {
  it("parses GitHub remotes and dirty porcelain warnings", () => {
    expect(parseGitHubRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      owner: "owner",
      repo: "repo",
      nameWithOwner: "owner/repo",
    });
    expect(parseGitHubRemoteUrl("git@github.com:owner/repo.git")?.nameWithOwner).toBe("owner/repo");
    expect(parseGitHubRemoteUrl("https://gitlab.example.test/owner/repo.git")).toBeNull();

    expect(
      dirtyWarningsFromPorcelain("M  staged.ts\n M unstaged.ts\n?? new.ts\n").map((warning) => warning.code),
    ).toEqual(["staged_changes_excluded", "unstaged_changes_excluded"]);
  });

  it("returns an existing PR without pushing and warns when local HEAD differs", async () => {
    const fake = fakeRunner();
    fake.ghPrLists.push(
      JSON.stringify([
        {
          number: 42,
          title: "Existing",
          url: "https://github.com/owner/repo/pull/42",
          state: "OPEN",
          headRefName: "feature/review",
          baseRefName: "main",
          headRefOid: "remote_head",
        },
      ]),
    );
    const result = await createGitHubPullRequest(
      {
        rootPath: "/repo",
        baseBranch: "main",
        defaultRemote: "origin",
        title: "Review",
        bodyFallback: "Body",
      },
      { runCommand: fake.runner },
    );

    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.pr?.number).toBe(42);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["staged_changes_excluded", "local_head_differs_from_pr"]),
    );
    expect(fake.calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
  });

  it("blocks PR creation when there are no committed changes ahead of base", async () => {
    const fake = fakeRunner({ aheadCount: "0" });
    fake.ghPrLists.push("[]");
    const result = await createGitHubPullRequest(
      {
        rootPath: "/repo",
        baseBranch: "main",
        defaultRemote: "origin",
        title: "Review",
        bodyFallback: "Body",
      },
      { runCommand: fake.runner },
    );

    expect(result).toMatchObject({ ok: false, error: "zero_commits_ahead_of_base", pushed: false });
    expect(fake.calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(false);
  });

  it("uses repository PR templates and creates a non-draft PR through gh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pr-action-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".github"));
    fs.writeFileSync(path.join(dir, ".github", "pull_request_template.md"), "Template body\n");
    const fake = fakeRunner();
    fake.ghPrLists.push("[]", "[]");
    fake.prCreate = (args) => {
      const bodyFile = args[args.indexOf("--body-file") + 1];
      expect(bodyFile ? fs.readFileSync(bodyFile, "utf8") : "").toBe("Template body\n");
      expect(args).not.toContain("--draft");
      return "https://github.com/owner/repo/pull/99";
    };

    const result = await createGitHubPullRequest(
      {
        rootPath: dir,
        baseBranch: "main",
        defaultRemote: "origin",
        title: "Review",
        bodyFallback: "Fallback",
      },
      { runCommand: fake.runner },
    );

    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.pr?.url).toBe("https://github.com/owner/repo/pull/99");
    expect(fake.calls.some((call) => call.command === "git" && call.args[0] === "push")).toBe(true);
  });

  it("falls back to REST after GraphQL rate limit only after rechecking existing PRs", async () => {
    const fake = fakeRunner();
    fake.ghPrLists.push("[]", "[]", "[]");
    fake.prCreate = () => {
      const error = new Error("GraphQL: API rate limit already exceeded for user ID 1");
      Object.assign(error, { stderr: "GraphQL: API rate limit already exceeded for user ID 1" });
      throw error;
    };
    fake.ghApi = () =>
      JSON.stringify({
        number: 100,
        title: "Review",
        html_url: "https://github.com/owner/repo/pull/100",
        state: "OPEN",
      });

    const result = await createGitHubPullRequest(
      {
        rootPath: "/repo",
        baseBranch: "main",
        defaultRemote: "origin",
        title: "Review",
        bodyFallback: "Body",
      },
      { runCommand: fake.runner },
    );

    expect(result.ok).toBe(true);
    expect(result.pr?.url).toBe("https://github.com/owner/repo/pull/100");
    expect(
      fake.calls.filter((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "list"),
    ).toHaveLength(3);
    expect(fake.calls.some((call) => call.command === "gh" && call.args[0] === "api")).toBe(true);
  });

  it("detects only GraphQL rate limits for REST fallback", () => {
    expect(isGraphqlRateLimitError({ stderr: "GraphQL: API rate limit already exceeded" })).toBe(true);
    expect(isGraphqlRateLimitError({ stderr: "API rate limit exceeded" })).toBe(false);
  });
});

function fakeRunner(input: { aheadCount?: string } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const ghPrLists: string[] = [];
  const fake = {
    calls,
    ghPrLists,
    prCreate: (_args: string[]) => "https://github.com/owner/repo/pull/1",
    ghApi: (_args: string[]) => "{}",
  };
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "git") return { stdout: gitOutput(args, input), stderr: "" };
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return { stdout: ghPrLists.shift() ?? "[]", stderr: "" };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return { stdout: fake.prCreate(args), stderr: "" };
    }
    if (command === "gh" && args[0] === "api") return { stdout: fake.ghApi(args), stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return Object.assign(fake, { runner });
}

function gitOutput(args: string[], input: { aheadCount?: string }): string {
  if (args.join(" ") === "branch --show-current") return "feature/review";
  if (args[0] === "check-ref-format") return "feature/review";
  if (args.join(" ") === "remote get-url origin") return "https://github.com/owner/repo.git";
  if (args[0] === "rev-parse" && args[1] === "--verify") return "base_sha";
  if (args[0] === "merge-base") return "merge_base";
  if (args[0] === "rev-list") return input.aheadCount ?? "2";
  if (args.join(" ") === "rev-parse HEAD") return "local_head";
  if (args.join(" ") === "status --porcelain=v1") return " M README.md\n";
  if (args[0] === "push") return "";
  return "";
}
