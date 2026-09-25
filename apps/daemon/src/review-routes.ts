import type { CitadelConfig } from "@citadel/config";
import {
  CreateReviewThreadInputSchema,
  MarkReviewFileViewedInputSchema,
  ReplyReviewThreadInputSchema,
  type ReviewActionWarning,
  type ReviewSuggestionRun,
  type ReviewDiffFileSummary,
  type ReviewDiffMetadata,
  type Workspace,
} from "@citadel/contracts";
import { createId } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import {
  addReviewComment as addReviewCommentImpl,
  deleteReviewComment as deleteReviewCommentImpl,
  listReviewComments as listReviewCommentsImpl,
  requestReviewForWorkspace,
  updateReviewComment as updateReviewCommentImpl,
} from "@citadel/operations";
import { createGitHubPullRequest, pushGitHubBranch } from "@citadel/providers";
import type express from "express";
import { z } from "zod";
import {
  readReviewDiffFileContent,
  readReviewDiffMetadata,
  resolveReviewCheckout,
  upsertReviewScopeForCheckout,
} from "./review-diff.js";
import { readWorkspaceDiffSummary } from "./workspace-diff.js";

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

const StatusQuerySchema = z.enum(["open", "resolved", "all"]).default("all");

const AddCommentBodySchema = z
  .object({
    body: z.string().min(1).max(8000),
    filePath: z.string().min(1).max(512).nullable().optional(),
    lineStart: z.number().int().min(1).nullable().optional(),
    lineEnd: z.number().int().min(1).nullable().optional(),
    side: z.enum(["LEFT", "RIGHT"]).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lineEnd != null && value.lineStart != null && value.lineEnd < value.lineStart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["lineEnd"], message: "lineEnd must be >= lineStart" });
    }
    if ((value.lineStart != null || value.lineEnd != null || value.side != null) && !value.filePath) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["filePath"], message: "anchor requires filePath" });
    }
  });

const UpdateCommentBodySchema = z
  .object({
    body: z.string().min(1).max(8000).optional(),
    status: z.enum(["open", "resolved"]).optional(),
    ifUpdatedAtMatches: z.string().min(1),
  })
  .strict()
  .refine((value) => value.body !== undefined || value.status !== undefined, "empty_patch");

const DeleteCommentBodySchema = z.object({ ifUpdatedAtMatches: z.string().min(1) }).strict();

export function registerReviewRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  asyncRoute: AsyncRoute;
  emit: (type: string, payload: unknown) => void;
}) {
  const { app, store, config, asyncRoute, emit } = input;
  const activity = (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
  ) =>
    store.addActivity({
      id: createId("evt"),
      type,
      source,
      repoId,
      workspaceId,
      operationId: null,
      message,
      hookOutput: null,
      createdAt: new Date().toISOString(),
    });

  const resolveWorkspace = (workspaceId: string): Workspace | null =>
    store.listWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;

  app.get(
    "/api/checkouts/:checkoutId/review-diff",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      if (!resolveReviewCheckout(store, checkoutId)) return res.status(404).json({ error: "checkout_not_found" });
      res.json(readReviewDiffMetadata(store, checkoutId));
    }),
  );

  app.get(
    "/api/checkouts/:checkoutId/review-diff/file",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const fileId = typeof req.query.fileId === "string" ? req.query.fileId : "";
      if (!fileId) return res.status(400).json({ error: "file_id_required" });
      if (!resolveReviewCheckout(store, checkoutId)) return res.status(404).json({ error: "checkout_not_found" });
      try {
        res.json(readReviewDiffFileContent(store, checkoutId, fileId));
      } catch (error) {
        if (error instanceof Error && error.message === "review_file_not_current") {
          return res.status(404).json({ error: "review_file_not_current" });
        }
        throw error;
      }
    }),
  );

  app.get(
    "/api/checkouts/:checkoutId/review-threads",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const metadata = metadataOr404(store, checkoutId);
      if (!metadata) return res.status(404).json({ error: "checkout_not_found" });
      if (!metadata.reviewScope) return res.json({ reviewScope: null, threads: [] });
      res.json({
        reviewScope: metadata.reviewScope,
        threads: store.listInternalReviewThreads(metadata.reviewScope.id, {
          includeResolved: truthy(req.query.includeResolved),
          includeOutdated: truthy(req.query.includeOutdated),
        }),
      });
    }),
  );

  app.post(
    "/api/checkouts/:checkoutId/review-threads",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const metadata = metadataOr404(store, checkoutId);
      if (!metadata) return res.status(404).json({ error: "checkout_not_found" });
      if (!metadata.reviewScope) return res.status(409).json({ error: "review_scope_required" });
      const parsed = CreateReviewThreadInputSchema.parse({ ...asRecord(req.body), checkoutId });
      if (parsed.reviewScopeId && parsed.reviewScopeId !== metadata.reviewScope.id) {
        return res.status(409).json({ error: "review_scope_mismatch" });
      }
      const file = findMetadataFile(metadata, parsed.bucket, parsed.path, parsed.oldPath ?? null);
      if (!file) return res.status(409).json({ error: "review_anchor_not_current" });
      if (parsed.anchorKind === "line" && (!parsed.side || !parsed.startLine)) {
        return res.status(400).json({ error: "line_anchor_requires_side_and_line" });
      }
      const now = new Date().toISOString();
      const threadId = createId("thread");
      const thread = store.createInternalReviewThread(
        {
          id: threadId,
          reviewScopeId: metadata.reviewScope.id,
          kind: "internal",
          status: "open",
          anchorState: "current",
          anchorKind: parsed.anchorKind,
          bucket: parsed.bucket,
          path: parsed.path,
          oldPath: parsed.oldPath ?? null,
          side: parsed.side ?? null,
          startLine: parsed.startLine ?? null,
          endLine: parsed.endLine ?? parsed.startLine ?? null,
          diffIdentity: file.id,
          selectedText: parsed.selectedText ?? null,
          authorKind: parsed.authorKind,
          authorLabel: parsed.authorLabel ?? null,
          providerThreadId: null,
          resolvedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: createId("reply"),
          threadId,
          body: parsed.body,
          authorKind: parsed.authorKind,
          authorLabel: parsed.authorLabel ?? null,
          providerCommentId: null,
          createdAt: now,
          updatedAt: now,
        },
      );
      emit("review.thread.created", { checkoutId, reviewScopeId: metadata.reviewScope.id, threadId: thread.id });
      res.status(201).json({ thread });
    }),
  );

  app.post(
    "/api/review-threads/:threadId/replies",
    asyncRoute(async (req, res) => {
      const threadId = String(req.params.threadId);
      const thread = store.findInternalReviewThread(threadId);
      if (!thread) return res.status(404).json({ error: "review_thread_not_found" });
      const parsed = ReplyReviewThreadInputSchema.parse({ ...asRecord(req.body), threadId });
      const now = new Date().toISOString();
      const reply = store.addInternalReviewThreadReply({
        id: createId("reply"),
        threadId,
        body: parsed.body,
        authorKind: parsed.authorKind,
        authorLabel: parsed.authorLabel ?? null,
        providerCommentId: null,
        createdAt: now,
        updatedAt: now,
      });
      const nextThread =
        asRecord(req.body).resolve === true ? store.setInternalReviewThreadStatus(threadId, "resolved", now) : null;
      emit("review.thread.replied", { reviewScopeId: thread.reviewScopeId, threadId });
      res.status(201).json({ reply, thread: nextThread ?? store.findInternalReviewThread(threadId) });
    }),
  );

  app.post(
    "/api/review-threads/:threadId/resolve",
    asyncRoute(async (req, res) => {
      const threadId = String(req.params.threadId);
      const thread = store.setInternalReviewThreadStatus(threadId, "resolved", new Date().toISOString());
      if (!thread) return res.status(404).json({ error: "review_thread_not_found" });
      emit("review.thread.resolved", { reviewScopeId: thread.reviewScopeId, threadId });
      res.json({ thread });
    }),
  );

  app.post(
    "/api/review-threads/:threadId/reopen",
    asyncRoute(async (req, res) => {
      const threadId = String(req.params.threadId);
      const thread = store.setInternalReviewThreadStatus(threadId, "open");
      if (!thread) return res.status(404).json({ error: "review_thread_not_found" });
      emit("review.thread.reopened", { reviewScopeId: thread.reviewScopeId, threadId });
      res.json({ thread });
    }),
  );

  app.post(
    "/api/checkouts/:checkoutId/review-viewed-files",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const metadata = metadataOr404(store, checkoutId);
      if (!metadata) return res.status(404).json({ error: "checkout_not_found" });
      if (!metadata.reviewScope) return res.status(409).json({ error: "review_scope_required" });
      const parsed = MarkReviewFileViewedInputSchema.parse({
        ...asRecord(req.body),
        reviewScopeId: metadata.reviewScope.id,
      });
      const file = findMetadataFile(metadata, parsed.bucket, parsed.path, parsed.oldPath);
      if (!file || file.id !== parsed.diffIdentity || file.id !== parsed.fileId) {
        return res.status(409).json({ error: "review_file_not_current" });
      }
      store.markInternalReviewFileViewed(parsed, new Date().toISOString());
      res.status(204).end();
    }),
  );

  app.post(
    "/api/checkouts/:checkoutId/push-branch",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const resolved = resolveReviewCheckout(store, checkoutId);
      if (!resolved) return res.status(404).json({ error: "checkout_not_found" });
      const result = await pushGitHubBranch({
        rootPath: resolved.checkout.path,
        baseBranch: resolved.checkout.baseBranch,
        defaultRemote: resolved.repo.defaultRemote || "origin",
        githubCommand: config.providers.github.command,
      });
      res.status(result.ok ? 202 : 409).json({
        ok: result.ok,
        checkoutId,
        operationId: null,
        warnings: result.warnings.map(reviewWarning),
        error: result.error,
      });
    }),
  );

  app.post(
    "/api/checkouts/:checkoutId/pull-request",
    asyncRoute(async (req, res) => {
      const checkoutId = String(req.params.checkoutId);
      const resolved = resolveReviewCheckout(store, checkoutId);
      if (!resolved) return res.status(404).json({ error: "checkout_not_found" });
      const result = await createGitHubPullRequest({
        rootPath: resolved.checkout.path,
        baseBranch: resolved.checkout.baseBranch,
        defaultRemote: resolved.repo.defaultRemote || "origin",
        title: pullRequestTitle(resolved.workspace.name, resolved.checkout.issue?.title),
        bodyFallback: "## Summary\n\n\n## Test plan\n\n",
        githubCommand: config.providers.github.command,
      });
      let reviewScope = null;
      if (result.ok && result.pr?.url) {
        store.updateWorkspaceCheckoutPr(checkoutId, {
          provider: "github",
          number: result.pr.number ?? prNumberFromUrl(result.pr.url),
          url: result.pr.url,
          headSha: result.pr.headSha,
          baseRef: result.pr.baseRefName ?? resolved.checkout.baseBranch,
          fetchedAt: new Date().toISOString(),
          checksGreen: null,
          mergeStateStatus: null,
          hasConflicts: null,
        });
        const next = resolveReviewCheckout(store, checkoutId);
        if (next) reviewScope = upsertReviewScopeForCheckout(store, next, result.pr.headSha);
        emit("workspace.updated", { workspaceId: resolved.workspace.id, checkoutId });
      }
      res.status(result.ok ? 202 : 409).json({
        ok: result.ok,
        checkoutId,
        reviewScope,
        prUrl: result.pr?.url ?? null,
        operationId: null,
        warnings: result.warnings.map(reviewWarning),
        error: result.error,
      });
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/review-comments",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      if (!resolveWorkspace(workspaceId)) return res.status(404).json({ error: "workspace_not_found" });
      const statusParse = StatusQuerySchema.safeParse(req.query.status ?? "all");
      if (!statusParse.success) return res.status(400).json({ error: "invalid_status" });
      const comments = listReviewCommentsImpl({
        store,
        workspaceId,
        status: statusParse.data,
        includeDeleted: req.query.includeDeleted === "true",
      });
      res.json({ comments });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/review-comments",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const parsed = AddCommentBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
      const comment = addReviewCommentImpl({
        store,
        activity,
        workspaceId,
        body: parsed.data.body,
        author: "operator",
        repoId: workspace.repoId ?? "",
        filePath: parsed.data.filePath ?? null,
        lineStart: parsed.data.lineStart ?? null,
        lineEnd: parsed.data.lineEnd ?? null,
        side: parsed.data.side ?? null,
      });
      res.status(201).json({ comment });
    }),
  );

  app.patch(
    "/api/review-comments/:commentId",
    asyncRoute(async (req, res) => {
      const commentId = String(req.params.commentId);
      const parsed = UpdateCommentBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
      const existing = store.getReviewComment(commentId);
      if (!existing || existing.deletedAt) return res.status(404).json({ error: "comment_not_found" });
      const workspace = resolveWorkspace(existing.workspaceId);
      const updateInput: Parameters<typeof updateReviewCommentImpl>[0] = {
        store,
        activity,
        id: commentId,
        ifUpdatedAtMatches: parsed.data.ifUpdatedAtMatches,
        repoId: workspace?.repoId ?? "",
      };
      if (parsed.data.body !== undefined) updateInput.body = parsed.data.body;
      if (parsed.data.status !== undefined) updateInput.status = parsed.data.status;
      const result = updateReviewCommentImpl(updateInput);
      if (result.kind === "not-found") return res.status(404).json({ error: "comment_not_found" });
      if (result.kind === "conflict") return res.status(409).json({ error: "conflict", latest: result.latest });
      return res.json({ comment: result.row });
    }),
  );

  app.delete(
    "/api/review-comments/:commentId",
    asyncRoute(async (req, res) => {
      const commentId = String(req.params.commentId);
      const parsed = DeleteCommentBodySchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "invalid_body", detail: parsed.error.message });
      const existing = store.getReviewComment(commentId);
      if (!existing) return res.status(404).json({ error: "comment_not_found" });
      if (existing.deletedAt) {
        if (existing.updatedAt === parsed.data.ifUpdatedAtMatches) return res.status(204).end();
        return res.status(409).json({ error: "conflict", latest: existing });
      }
      const workspace = resolveWorkspace(existing.workspaceId);
      const result = deleteReviewCommentImpl({
        store,
        activity,
        id: commentId,
        ifUpdatedAtMatches: parsed.data.ifUpdatedAtMatches,
        repoId: workspace?.repoId ?? "",
      });
      if (result.kind === "not-found") return res.status(404).json({ error: "comment_not_found" });
      if (result.kind === "conflict") return res.status(409).json({ error: "conflict", latest: result.latest });
      return res.status(204).end();
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/review-suggestions",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      if (!resolveWorkspace(workspaceId)) return res.status(404).json({ error: "workspace_not_found" });
      const run: ReviewSuggestionRun | null = store.latestReviewSuggestionRun(workspaceId);
      res.json({ run });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/review-requests",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const result = await requestReviewForWorkspace({
        store,
        config: { hooks: config.hooks, commandPolicy: config.commandPolicy },
        activity,
        repo,
        workspace,
        diff: readWorkspaceDiffSummary(workspace.id, workspace.path),
      });
      if (result.kind === "no-hook") return res.status(400).json({ error: "no-hook" });
      if (result.kind === "succeeded") return res.json({ run: result.run, output: result.output });
      if (result.kind === "timed-out") return res.status(504).json({ error: "timed-out", run: result.run });
      return res.status(502).json({ error: "hook-failed", run: result.run, message: result.error });
    }),
  );
}

function metadataOr404(store: SqliteStore, checkoutId: string): ReviewDiffMetadata | null {
  if (!resolveReviewCheckout(store, checkoutId)) return null;
  return readReviewDiffMetadata(store, checkoutId);
}

function findMetadataFile(
  metadata: ReviewDiffMetadata,
  bucket: string,
  filePath: string,
  oldPath: string | null,
): ReviewDiffFileSummary | null {
  return (
    metadata.sections
      .flatMap((section) => section.files)
      .find((file) => file.bucket === bucket && file.path === filePath && file.oldPath === oldPath) ?? null
  );
}

function reviewWarning(warning: { code: string; message: string; paths: string[] }): ReviewActionWarning {
  return { code: warning.code, message: warning.message, paths: warning.paths };
}

function pullRequestTitle(workspaceName: string, issueTitle: string | null | undefined): string {
  return issueTitle?.trim() || workspaceName;
}

function prNumberFromUrl(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|[/?#])/);
  return match?.[1] ? Number(match[1]) : null;
}

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
