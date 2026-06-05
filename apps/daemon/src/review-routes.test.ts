import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ReviewDiffFileContent, ReviewDiffMetadata } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture,
  createGitFixtureWithRemote,
  getJson,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeFixtureDir(dir);
});

describe("checkout review routes", () => {
  it("serves committed, staged, and unstaged diff metadata with lazy file content", async () => {
    const fixture = createFixture(dirs);
    const git = createReviewGitFixture(fixture.config.dataDir);
    registerReviewCheckout(fixture, git.repoPath, { withPr: true });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const metadata = await getJson<ReviewDiffMetadata>(`${baseUrl}/api/checkouts/checkout_review/review-diff`);

      expect(metadata.reviewScope).toMatchObject({ externalReviewNumber: 42 });
      expect(section(metadata, "against-base")?.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "README.md", status: "modified" })]),
      );
      expect(section(metadata, "staged")?.files).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "staged.txt", status: "added", additions: 1 })]),
      );
      expect(section(metadata, "unstaged")?.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "README.md", status: "modified" }),
          expect.objectContaining({ path: "loose.txt", status: "untracked", additions: 1 }),
        ]),
      );
      expect(metadata.commits.map((commit) => commit.subject)).toContain("committed change");

      const stagedFile = section(metadata, "staged")?.files.find((file) => file.path === "staged.txt");
      expect(stagedFile).toBeTruthy();
      const content = await getJson<ReviewDiffFileContent>(
        `${baseUrl}/api/checkouts/checkout_review/review-diff/file?fileId=${encodeURIComponent(stagedFile?.id ?? "")}`,
      );
      expect(content.oldContent).toBeNull();
      expect(content.newContent).toBe("staged\n");
    } finally {
      await closeServer(server);
    }
  });

  it("creates internal threads, supports agent replies with final resolve, reopen, and viewed files", async () => {
    const fixture = createFixture(dirs);
    const git = createReviewGitFixture(fixture.config.dataDir);
    registerReviewCheckout(fixture, git.repoPath, { withPr: true });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const metadata = await getJson<ReviewDiffMetadata>(`${baseUrl}/api/checkouts/checkout_review/review-diff`);
      const file = section(metadata, "staged")?.files.find((candidate) => candidate.path === "staged.txt");
      expect(file).toBeTruthy();

      const created = await postJson<{ thread: { id: string; status: string; replies: unknown[] } }>(
        `${baseUrl}/api/checkouts/checkout_review/review-threads`,
        {
          bucket: file?.bucket,
          path: file?.path,
          oldPath: file?.oldPath,
          anchorKind: "file",
          body: "Please simplify this.",
        },
      );
      expect(created.thread.status).toBe("open");
      expect(created.thread.replies).toHaveLength(1);

      const counted = await getJson<ReviewDiffMetadata>(`${baseUrl}/api/checkouts/checkout_review/review-diff`);
      expect(section(counted, "staged")?.files.find((candidate) => candidate.path === "staged.txt")).toMatchObject({
        threadCount: 1,
        openThreadCount: 1,
      });

      const replied = await postJson<{ thread: { status: string; replies: unknown[] } }>(
        `${baseUrl}/api/review-threads/${created.thread.id}/replies`,
        { body: "Fixed this.", authorKind: "agent", authorLabel: "Implementation agent", resolve: true },
      );
      expect(replied.thread.status).toBe("resolved");
      expect(replied.thread.replies).toHaveLength(2);

      const defaultThreads = await getJson<{ threads: unknown[] }>(
        `${baseUrl}/api/checkouts/checkout_review/review-threads`,
      );
      expect(defaultThreads.threads).toHaveLength(0);

      const reopened = await postJson<{ thread: { status: string } }>(
        `${baseUrl}/api/review-threads/${created.thread.id}/reopen`,
        {},
      );
      expect(reopened.thread.status).toBe("open");

      const viewedResponse = await fetch(`${baseUrl}/api/checkouts/checkout_review/review-viewed-files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileId: file?.id,
          bucket: file?.bucket,
          path: file?.path,
          oldPath: file?.oldPath,
          diffIdentity: file?.id,
          viewed: true,
        }),
      });
      expect(viewedResponse.status).toBe(204);

      const withViewed = await getJson<ReviewDiffMetadata>(`${baseUrl}/api/checkouts/checkout_review/review-diff`);
      expect(section(withViewed, "staged")?.files.find((candidate) => candidate.path === "staged.txt")?.viewed).toBe(
        true,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("blocks comments before a PR exists and binds an existing GitHub PR without draft creation", async () => {
    const fixture = createFixture(dirs);
    const git = createReviewGitFixture(fixture.config.dataDir);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/owner/repo.git"], {
      cwd: git.repoPath,
      stdio: "pipe",
    });
    fixture.config.providers.github.command = fakeGh(fixture.config.dataDir);
    registerReviewCheckout(fixture, git.repoPath, { withPr: false });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const before = await fetch(`${baseUrl}/api/checkouts/checkout_review/review-threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucket: "against-base", path: "README.md", anchorKind: "file", body: "No PR yet." }),
      });
      expect(before.status).toBe(409);
      expect(await before.json()).toEqual({ error: "review_scope_required" });

      const created = await postJson<{ ok: boolean; prUrl: string; reviewScope: { externalReviewNumber: number } }>(
        `${baseUrl}/api/checkouts/checkout_review/pull-request`,
        {},
      );
      expect(created).toMatchObject({
        ok: true,
        prUrl: "https://github.com/owner/repo/pull/77",
        reviewScope: { externalReviewNumber: 77 },
      });
      expect(fixture.store.findWorkspaceCheckout("checkout_review")?.intendedPr).toMatchObject({
        provider: "github",
        number: 77,
        url: "https://github.com/owner/repo/pull/77",
      });
    } finally {
      await closeServer(server);
    }
  });
});

function createReviewGitFixture(parent: string) {
  const git = createGitFixtureWithRemote(parent);
  execFileSync("git", ["checkout", "-b", "feature/review"], { cwd: git.repoPath, stdio: "pipe" });
  fs.appendFileSync(path.join(git.repoPath, "README.md"), "committed\n");
  execFileSync("git", ["add", "README.md"], { cwd: git.repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "committed change"], { cwd: git.repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(git.repoPath, "staged.txt"), "staged\n");
  execFileSync("git", ["add", "staged.txt"], { cwd: git.repoPath, stdio: "pipe" });
  fs.appendFileSync(path.join(git.repoPath, "README.md"), "unstaged\n");
  fs.writeFileSync(path.join(git.repoPath, "loose.txt"), "loose\n");
  return git;
}

function registerReviewCheckout(
  fixture: ReturnType<typeof createFixture>,
  repoPath: string,
  options: { withPr: boolean },
) {
  const now = new Date().toISOString();
  fixture.config.automations = {
    fixCi: {
      enabled: false,
      runtimeId: "test-agent",
      fallbackRuntimeId: null,
      idleThresholdMs: 5 * 60 * 1000,
      debounceMs: 30 * 60 * 1000,
      intervalMs: 60 * 1000,
    },
  };
  fixture.store.insertRepo({
    id: "repo_review",
    name: "Review Repo",
    rootPath: repoPath,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  fixture.store.insertWorkspace({
    id: "ws_review",
    repoId: "repo_review",
    name: "Review Workspace",
    path: path.join(fixture.config.dataDir, "workspace"),
    rootPath: path.join(fixture.config.dataDir, "workspace"),
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
    parentIssue: null,
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  fixture.store.insertWorkspaceCheckout({
    id: "checkout_review",
    workspaceId: "ws_review",
    repoId: "repo_review",
    name: "Review checkout",
    path: repoPath,
    branch: "feature/review",
    baseBranch: "main",
    issue: { provider: "jira", key: "ENG-1", url: null, title: "Linked issue title", status: null, fetchedAt: now },
    intendedPr: options.withPr
      ? {
          provider: "github",
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          headSha: null,
          baseRef: "main",
          fetchedAt: now,
          checksGreen: null,
          mergeStateStatus: null,
          hasConflicts: null,
        }
      : null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "review_required",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
}

function section(metadata: ReviewDiffMetadata, bucket: string) {
  return metadata.sections.find((candidate) => candidate.bucket === bucket);
}

function fakeGh(parent: string): string {
  const command = path.join(parent, "fake-gh");
  fs.writeFileSync(
    command,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-} ${2:-}" == "pr list" ]]; then',
      '  echo \'[{"number":77,"title":"Existing","url":"https://github.com/owner/repo/pull/77","state":"OPEN","headRefName":"feature/review","baseRefName":"main","headRefOid":"remote_head"}]\'',
      "  exit 0",
      "fi",
      'echo unexpected gh args: "$@" >&2',
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return command;
}

async function removeFixtureDir(dir: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(code ?? "") || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
