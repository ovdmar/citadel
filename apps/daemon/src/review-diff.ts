import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  InternalReviewScopeSummary,
  InternalReviewThread,
  Repo,
  ReviewDiffBase,
  ReviewDiffBucket,
  ReviewDiffCommit,
  ReviewDiffFileContent,
  ReviewDiffFileIdentity,
  ReviewDiffFileStatus,
  ReviewDiffFileSummary,
  ReviewDiffMetadata,
  ReviewDiffSection,
  ReviewDiffWarning,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";

const MAX_SECTION_FILES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

type ResolvedCheckout = { workspace: Workspace; repo: Repo; checkout: WorktreeCheckout };
type DiffEntry = { statusCode: string; path: string; oldPath: string | null };
type Numstat = { additions: number; deletions: number; binary: boolean };
type ThreadStats = { threadCount: number; openThreadCount: number };

export function resolveReviewCheckout(store: SqliteStore, checkoutId: string): ResolvedCheckout | null {
  const checkout = store.findWorkspaceCheckout(checkoutId);
  if (!checkout || checkout.archivedAt) return null;
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === checkout.workspaceId);
  if (!workspace) return null;
  const repo = store.listRepos().find((candidate) => candidate.id === checkout.repoId);
  if (!repo) return null;
  return { workspace, repo, checkout };
}

export function readReviewDiffMetadata(store: SqliteStore, checkoutId: string): ReviewDiffMetadata {
  const resolved = resolveReviewCheckout(store, checkoutId);
  if (!resolved) throw new Error("checkout_not_found");
  const { workspace, repo, checkout } = resolved;
  const base = readBase(checkout.path, checkout.baseBranch);
  const scope = upsertReviewScopeForCheckout(store, resolved, base.headSha);
  const sections = readSections(checkout.path, base);
  const currentThreads = syncThreadAnchorStates(store, scope, sections);
  const stats = threadStatsByFile(currentThreads);
  const viewed = viewedFiles(scope, store);
  const decoratedSections = sections.map((section) => decorateFiles(section, stats, viewed));
  return {
    checkoutId: checkout.id,
    workspaceId: workspace.id,
    repoId: repo.id,
    reviewScope: scope,
    base,
    sections: decoratedSections,
    commits: readCommits(checkout.path, base.mergeBaseSha),
    warnings: diffWarnings(base, sections),
    checkedAt: new Date().toISOString(),
  };
}

export function readReviewDiffFileContent(
  store: SqliteStore,
  checkoutId: string,
  fileId: string,
): ReviewDiffFileContent {
  const resolved = resolveReviewCheckout(store, checkoutId);
  if (!resolved) throw new Error("checkout_not_found");
  const metadata = readReviewDiffMetadata(store, checkoutId);
  const summary = metadata.sections.flatMap((section) => section.files).find((file) => file.id === fileId);
  if (!summary) throw new Error("review_file_not_current");
  const oldBytes = readFileSide(resolved.checkout.path, summary, "old");
  const newBytes = readFileSide(resolved.checkout.path, summary, "new");
  const binary = summary.binary || isBinary(oldBytes) || isBinary(newBytes);
  const tooLarge = isTooLarge(oldBytes) || isTooLarge(newBytes);
  return {
    checkoutId,
    fileId,
    bucket: summary.bucket,
    path: summary.path,
    oldPath: summary.oldPath,
    status: summary.status,
    binary,
    tooLarge,
    truncated: false,
    oldContent: binary || tooLarge ? null : (oldBytes?.toString("utf8") ?? null),
    newContent: binary || tooLarge ? null : (newBytes?.toString("utf8") ?? null),
  };
}

export function upsertReviewScopeForCheckout(
  store: SqliteStore,
  resolved: ResolvedCheckout,
  headSha: string | null = null,
): InternalReviewScopeSummary | null {
  const { workspace, repo, checkout } = resolved;
  if (!checkout.intendedPr?.provider || (!checkout.intendedPr.number && !checkout.intendedPr.url)) return null;
  const now = new Date().toISOString();
  const id = reviewScopeId(checkout);
  const existing = store.findInternalReviewScope(id);
  return store.upsertInternalReviewScope({
    id,
    workspaceId: workspace.id,
    checkoutId: checkout.id,
    repoId: repo.id,
    providerType: checkout.intendedPr.provider,
    providerRepositoryKey: providerRepositoryKey(checkout.intendedPr.url),
    externalReviewId: null,
    externalReviewNumber: checkout.intendedPr.number,
    externalReviewUrl: checkout.intendedPr.url,
    baseRef: checkout.intendedPr.baseRef ?? checkout.baseBranch,
    headRef: checkout.branch,
    headSha: checkout.intendedPr.headSha ?? headSha,
    providerState: "open",
    observedAt: now,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

function readBase(cwd: string, baseBranch: string): ReviewDiffBase {
  const headSha = gitOptional(cwd, ["rev-parse", "HEAD"]);
  const baseRef = resolveBaseRef(cwd, baseBranch);
  if (!baseRef) {
    return {
      baseBranch,
      baseRef: null,
      baseTipSha: null,
      mergeBaseSha: null,
      headSha,
      missing: true,
      freshness: "missing",
    };
  }
  const baseTipSha = gitOptional(cwd, ["rev-parse", `${baseRef}^{commit}`]);
  const mergeBaseSha = gitOptional(cwd, ["merge-base", "HEAD", baseRef]);
  return {
    baseBranch,
    baseRef,
    baseTipSha,
    mergeBaseSha,
    headSha,
    missing: !baseTipSha || !mergeBaseSha,
    freshness: baseTipSha && mergeBaseSha ? "not_refreshed" : "missing",
  };
}

function readSections(cwd: string, base: ReviewDiffBase): ReviewDiffSection[] {
  return [
    buildSection({
      cwd,
      bucket: "against-base",
      label: "Committed vs base",
      entries: base.mergeBaseSha ? diffEntries(cwd, [base.mergeBaseSha, "HEAD"]) : [],
      stats: base.mergeBaseSha ? numstats(cwd, [base.mergeBaseSha, "HEAD"]) : new Map(),
      base,
    }),
    buildSection({
      cwd,
      bucket: "staged",
      label: "Staged",
      entries: diffEntries(cwd, ["--cached", "HEAD"]),
      stats: numstats(cwd, ["--cached", "HEAD"]),
      base,
    }),
    buildSection({
      cwd,
      bucket: "unstaged",
      label: "Unstaged",
      entries: [...diffEntries(cwd, []), ...untrackedEntries(cwd)],
      stats: new Map([...numstats(cwd, []), ...untrackedStats(cwd)]),
      base,
    }),
  ];
}

function buildSection(input: {
  cwd: string;
  bucket: ReviewDiffBucket;
  label: string;
  entries: DiffEntry[];
  stats: Map<string, Numstat>;
  base: ReviewDiffBase;
}): ReviewDiffSection {
  const files = input.entries.slice(0, MAX_SECTION_FILES).map((entry) => {
    const stats = input.stats.get(fileKeyForPath(entry.path, entry.oldPath));
    return fileSummary(input.cwd, input.bucket, entry, input.base, stats);
  });
  return {
    bucket: input.bucket,
    label: input.label,
    files,
    fileCount: input.entries.length,
    truncated: input.entries.length > files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
  };
}

function fileSummary(
  cwd: string,
  bucket: ReviewDiffBucket,
  entry: DiffEntry,
  base: ReviewDiffBase,
  stats: Numstat | undefined,
): ReviewDiffFileSummary {
  const status = statusFromCode(entry.statusCode, bucket);
  const identity = fileIdentity(cwd, bucket, entry, base, status);
  const id = encodeIdentity(identity);
  return {
    id,
    bucket,
    path: entry.path,
    oldPath: entry.oldPath,
    status,
    binary: stats?.binary ?? false,
    tooLarge: false,
    truncated: false,
    commentable: true,
    additions: stats?.additions ?? 0,
    deletions: stats?.deletions ?? 0,
    threadCount: 0,
    openThreadCount: 0,
    viewed: false,
    identity,
  };
}

function fileIdentity(
  cwd: string,
  bucket: ReviewDiffBucket,
  entry: DiffEntry,
  base: ReviewDiffBase,
  status: ReviewDiffFileStatus,
): ReviewDiffFileIdentity {
  if (bucket === "against-base") {
    return {
      bucket,
      path: entry.path,
      oldPath: entry.oldPath,
      baseSha: base.mergeBaseSha,
      headSha: base.headSha,
      oldBlobSha: status === "added" ? null : blobAt(cwd, base.mergeBaseSha, entry.oldPath ?? entry.path),
      newBlobSha: status === "deleted" ? null : blobAt(cwd, base.headSha, entry.path),
      worktreeHash: null,
    };
  }
  if (bucket === "staged") {
    return {
      bucket,
      path: entry.path,
      oldPath: entry.oldPath,
      baseSha: base.headSha,
      headSha: base.headSha,
      oldBlobSha: status === "added" ? null : blobAt(cwd, "HEAD", entry.oldPath ?? entry.path),
      newBlobSha: status === "deleted" ? null : blobAtIndex(cwd, entry.path),
      worktreeHash: null,
    };
  }
  return {
    bucket,
    path: entry.path,
    oldPath: entry.oldPath,
    baseSha: base.headSha,
    headSha: base.headSha,
    oldBlobSha: status === "untracked" ? null : blobAtIndex(cwd, entry.oldPath ?? entry.path),
    newBlobSha: status === "deleted" ? null : blobAtWorktree(cwd, entry.path),
    worktreeHash: status === "deleted" ? null : worktreeHash(cwd, entry.path),
  };
}

function diffEntries(cwd: string, args: string[]): DiffEntry[] {
  const output = git(cwd, ["diff", "--no-ext-diff", "--name-status", "-z", "-M", "-C", ...args, "--"]);
  const parts = output.split("\0").filter(Boolean);
  const entries: DiffEntry[] = [];
  for (let index = 0; index < parts.length; ) {
    const statusCode = parts[index++] ?? "";
    if (statusCode.startsWith("R") || statusCode.startsWith("C")) {
      const oldPath = parts[index++] ?? "";
      const newPath = parts[index++] ?? "";
      if (newPath) entries.push({ statusCode, oldPath, path: newPath });
      continue;
    }
    const filePath = parts[index++] ?? "";
    if (filePath) entries.push({ statusCode, oldPath: null, path: filePath });
  }
  return entries;
}

function numstats(cwd: string, args: string[]): Map<string, Numstat> {
  const output = git(cwd, ["diff", "--no-ext-diff", "--numstat", "-z", "-M", "-C", ...args, "--"]);
  const parts = output.split("\0");
  const stats = new Map<string, Numstat>();
  for (let index = 0; index < parts.length; ) {
    const record = parts[index++];
    if (!record) continue;
    const [addedRaw, deletedRaw, inlinePath] = record.split("\t");
    let oldPath: string | null = null;
    let filePath = inlinePath ?? "";
    if (!filePath) {
      oldPath = parts[index++] ?? "";
      filePath = parts[index++] ?? "";
    }
    if (!filePath) continue;
    stats.set(fileKeyForPath(filePath, oldPath || null), {
      additions: parseLineCount(addedRaw),
      deletions: parseLineCount(deletedRaw),
      binary: addedRaw === "-" || deletedRaw === "-",
    });
  }
  return stats;
}

function untrackedEntries(cwd: string): DiffEntry[] {
  return git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((filePath) => ({ statusCode: "??", oldPath: null, path: filePath }));
}

function untrackedStats(cwd: string): Map<string, Numstat> {
  const stats = new Map<string, Numstat>();
  for (const entry of untrackedEntries(cwd)) {
    const bytes = readWorktreeFile(cwd, entry.path);
    const binary = isBinary(bytes);
    stats.set(fileKeyForPath(entry.path, null), {
      additions: bytes && !binary ? countLines(bytes.toString("utf8")) : 0,
      deletions: 0,
      binary,
    });
  }
  return stats;
}

function readCommits(cwd: string, mergeBaseSha: string | null): ReviewDiffCommit[] {
  if (!mergeBaseSha) return [];
  const output = gitOptional(cwd, [
    "log",
    "--max-count=100",
    "--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1e",
    `${mergeBaseSha}..HEAD`,
  ]);
  if (!output) return [];
  return output
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, shortSha, subject, author, isoTime] = chunk.split("\x1f");
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? "",
        subject: subject ?? "",
        author: author ?? "",
        isoTime: isoTime ?? null,
      };
    })
    .filter((commit) => commit.sha && commit.shortSha);
}

function syncThreadAnchorStates(
  store: SqliteStore,
  scope: InternalReviewScopeSummary | null,
  sections: ReviewDiffSection[],
): InternalReviewThread[] {
  if (!scope) return [];
  const current = new Map<string, string>();
  for (const file of sections.flatMap((section) => section.files)) {
    current.set(fileKey(file.bucket, file.path, file.oldPath), file.id);
  }
  const threads = store.listInternalReviewThreads(scope.id, { includeResolved: true, includeOutdated: true });
  for (const thread of threads) {
    const next =
      current.get(fileKey(thread.bucket, thread.path, thread.oldPath)) === thread.diffIdentity ? "current" : "outdated";
    if (next !== thread.anchorState) store.setInternalReviewThreadAnchorState(thread.id, next);
  }
  return store.listInternalReviewThreads(scope.id, { includeResolved: true, includeOutdated: true });
}

function threadStatsByFile(threads: InternalReviewThread[]): Map<string, ThreadStats> {
  const stats = new Map<string, ThreadStats>();
  for (const thread of threads) {
    if (thread.kind !== "internal" || thread.anchorState !== "current") continue;
    const key = fileKey(thread.bucket, thread.path, thread.oldPath);
    const current = stats.get(key) ?? { threadCount: 0, openThreadCount: 0 };
    current.threadCount += 1;
    if (thread.status === "open") current.openThreadCount += 1;
    stats.set(key, current);
  }
  return stats;
}

function viewedFiles(scope: InternalReviewScopeSummary | null, store: SqliteStore): Set<string> {
  if (!scope) return new Set();
  return new Set(
    store
      .listInternalReviewViewedFiles(scope.id)
      .filter((file) => file.viewed)
      .map((file) => fileKey(file.bucket, file.path, file.oldPath) + `\0${file.diffIdentity}`),
  );
}

function decorateFiles(
  section: ReviewDiffSection,
  stats: Map<string, ThreadStats>,
  viewed: Set<string>,
): ReviewDiffSection {
  const files = section.files.map((file) => {
    const key = fileKey(file.bucket, file.path, file.oldPath);
    const threadStats = stats.get(key);
    return {
      ...file,
      threadCount: threadStats?.threadCount ?? 0,
      openThreadCount: threadStats?.openThreadCount ?? 0,
      viewed: viewed.has(`${key}\0${file.id}`),
    };
  });
  return { ...section, files };
}

function readFileSide(cwd: string, file: ReviewDiffFileSummary, side: "old" | "new"): Buffer | null {
  if (side === "old") {
    if (file.status === "added" || file.status === "untracked") return null;
    if (file.bucket === "against-base") return readGitBlob(cwd, file.identity.baseSha, file.oldPath ?? file.path);
    if (file.bucket === "staged") return readGitBlob(cwd, "HEAD", file.oldPath ?? file.path);
    return readGitIndexBlob(cwd, file.oldPath ?? file.path);
  }
  if (file.status === "deleted") return null;
  if (file.bucket === "against-base") return readGitBlob(cwd, file.identity.headSha, file.path);
  if (file.bucket === "staged") return readGitIndexBlob(cwd, file.path);
  return readWorktreeFile(cwd, file.path);
}

function diffWarnings(base: ReviewDiffBase, sections: ReviewDiffSection[]): ReviewDiffWarning[] {
  const warnings: ReviewDiffWarning[] = [];
  if (base.missing) {
    warnings.push({
      code: "base_ref_missing",
      message: `Base branch ${base.baseBranch} is not available locally.`,
      severity: "error",
    });
  } else {
    warnings.push({
      code: "base_not_refreshed",
      message: "Diff is computed from local refs without fetching from the provider.",
      severity: "info",
    });
  }
  for (const section of sections) {
    if (section.truncated) {
      warnings.push({
        code: "section_file_limit",
        message: `${section.label} has more than ${MAX_SECTION_FILES} changed files.`,
        severity: "warning",
      });
    }
  }
  return warnings;
}

function statusFromCode(statusCode: string, bucket: ReviewDiffBucket): ReviewDiffFileStatus {
  if (statusCode === "??") return "untracked";
  if (statusCode.startsWith("A")) return "added";
  if (statusCode.startsWith("M")) return "modified";
  if (statusCode.startsWith("D")) return "deleted";
  if (statusCode.startsWith("R")) return "renamed";
  if (statusCode.startsWith("C")) return "copied";
  if (statusCode.startsWith("U")) return "conflicted";
  if (statusCode.startsWith("T")) return "mode-only";
  return bucket === "unstaged" && statusCode === "!" ? "unknown" : "unknown";
}

function resolveBaseRef(cwd: string, baseBranch: string): string | null {
  const branch = baseBranch.replace(/^origin\//, "");
  for (const candidate of [`origin/${branch}`, baseBranch]) {
    if (gitOptional(cwd, ["rev-parse", "--verify", `${candidate}^{commit}`])) return candidate;
  }
  return null;
}

function blobAt(cwd: string, ref: string | null, filePath: string): string | null {
  return ref ? gitOptional(cwd, ["rev-parse", `${ref}:${filePath}`]) : null;
}

function blobAtIndex(cwd: string, filePath: string): string | null {
  const line = gitOptional(cwd, ["ls-files", "-s", "--", filePath]);
  const match = line?.match(/^\d+\s+([a-f0-9]{40,64})\s+0\t/);
  return match?.[1] ?? null;
}

function blobAtWorktree(cwd: string, filePath: string): string | null {
  const bytes = readWorktreeFile(cwd, filePath);
  return bytes ? createHash("sha1").update(bytes).digest("hex") : null;
}

function worktreeHash(cwd: string, filePath: string): string | null {
  const bytes = readWorktreeFile(cwd, filePath);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

function readGitBlob(cwd: string, ref: string | null, filePath: string): Buffer | null {
  if (!ref) return null;
  return gitBufferOptional(cwd, ["show", `${ref}:${filePath}`]);
}

function readGitIndexBlob(cwd: string, filePath: string): Buffer | null {
  return gitBufferOptional(cwd, ["show", `:${filePath}`]);
}

function readWorktreeFile(cwd: string, filePath: string): Buffer | null {
  const absolutePath = path.resolve(cwd, filePath);
  const root = path.resolve(cwd);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) throw new Error("invalid_review_path");
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) return null;
  return fs.readFileSync(absolutePath);
}

function encodeIdentity(identity: ReviewDiffFileIdentity): string {
  return Buffer.from(JSON.stringify(identity)).toString("base64url");
}

function reviewScopeId(checkout: WorktreeCheckout): string {
  const key = `${checkout.id}:${checkout.intendedPr?.provider ?? ""}:${checkout.intendedPr?.number ?? ""}:${
    checkout.intendedPr?.url ?? ""
  }`;
  return `scope_${hash(key).slice(0, 24)}`;
}

function providerRepositoryKey(url: string | null): string | null {
  const match = url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return match?.[1] ?? null;
}

function fileKey(bucket: ReviewDiffBucket, filePath: string, oldPath: string | null): string {
  return `${bucket}\0${fileKeyForPath(filePath, oldPath)}`;
}

function fileKeyForPath(filePath: string, oldPath: string | null): string {
  return `${oldPath ?? ""}\0${filePath}`;
}

function parseLineCount(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

function isBinary(value: Buffer | null): boolean {
  return value?.includes(0) ?? false;
}

function isTooLarge(value: Buffer | null): boolean {
  return value ? value.length > MAX_FILE_BYTES : false;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    timeout: 12_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: GIT_MAX_BUFFER,
  });
}

function gitOptional(cwd: string, args: string[]): string | null {
  try {
    const output = git(cwd, args).trim();
    return output || null;
  } catch {
    return null;
  }
}

function gitBufferOptional(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout: 12_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch {
    return null;
  }
}
