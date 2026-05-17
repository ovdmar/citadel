import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitHubVersionControlSummary, commandHealth } from "./index.js";

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
