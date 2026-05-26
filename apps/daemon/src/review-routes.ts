import type { CitadelConfig } from "@citadel/config";
import type { HookOutput, ReviewComment, ReviewSuggestionRun, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import {
  addReviewComment as addReviewCommentImpl,
  deleteReviewComment as deleteReviewCommentImpl,
  listReviewComments as listReviewCommentsImpl,
  requestReviewForWorkspace,
  updateReviewComment as updateReviewCommentImpl,
} from "@citadel/operations";
import type express from "express";
import { z } from "zod";
import { readWorkspaceDiff } from "./workspace-diff.js";

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
  .refine((v) => v.body !== undefined || v.status !== undefined, "empty_patch");

const DeleteCommentBodySchema = z.object({ ifUpdatedAtMatches: z.string().min(1) }).strict();

type ReviewRoutesDeps = {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  asyncRoute: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
  ) => express.RequestHandler;
  recordActivity?: (event: {
    type: string;
    source: "user" | "system" | "hook";
    message: string;
    repoId: string | null;
    workspaceId: string | null;
    hookOutput?: HookOutput | null;
  }) => void;
};

export function registerReviewRoutes(deps: ReviewRoutesDeps) {
  const { app, store, config, asyncRoute } = deps;
  const recordActivity =
    deps.recordActivity ??
    ((event) => {
      store.addActivity({
        id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        type: event.type,
        source: event.source,
        repoId: event.repoId,
        workspaceId: event.workspaceId,
        operationId: null,
        message: event.message,
        hookOutput: event.hookOutput ?? null,
        createdAt: new Date().toISOString(),
      });
    });

  const activity = (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
  ) => recordActivity({ type, source, message, repoId, workspaceId });

  const resolveWorkspace = (workspaceId: string): Workspace | null => {
    const list = store.listWorkspaces();
    return list.find((w) => w.id === workspaceId) ?? null;
  };

  app.get(
    "/api/workspaces/:workspaceId/review-comments",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      if (!resolveWorkspace(workspaceId)) return res.status(404).json({ error: "workspace_not_found" });
      const statusParse = StatusQuerySchema.safeParse(req.query.status ?? "all");
      if (!statusParse.success) return res.status(400).json({ error: "invalid_status" });
      const includeDeleted = req.query.includeDeleted === "true";
      const comments = listReviewCommentsImpl({
        store,
        workspaceId,
        status: statusParse.data,
        includeDeleted,
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
      const row = addReviewCommentImpl({
        store,
        activity,
        workspaceId,
        body: parsed.data.body,
        author: "operator",
        repoId: workspace.repoId,
        filePath: parsed.data.filePath ?? null,
        lineStart: parsed.data.lineStart ?? null,
        lineEnd: parsed.data.lineEnd ?? null,
        side: parsed.data.side ?? null,
      });
      res.status(201).json({ comment: row });
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
      if (!existing || existing.deletedAt) return res.status(404).json({ error: "comment_not_found" });
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
      const latest: ReviewSuggestionRun | null = store.latestReviewSuggestionRun(workspaceId);
      res.json({ run: latest });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/review-requests",
    asyncRoute(async (req, res) => {
      const workspaceId = String(req.params.workspaceId);
      const workspace = resolveWorkspace(workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repos = store.listRepos();
      const repo = repos.find((r) => r.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const diffSummary = (() => {
        try {
          const diff = readWorkspaceDiff(workspace.id, workspace.path);
          return {
            files: diff.files.map((f) => f.path),
            addedLines: diff.addedLines,
            deletedLines: diff.deletedLines,
            truncated: diff.truncated,
          };
        } catch {
          return { files: [], addedLines: 0, deletedLines: 0, truncated: false };
        }
      })();
      const result = await requestReviewForWorkspace({
        store,
        config: { hooks: config.hooks, commandPolicy: config.commandPolicy },
        activity,
        repo,
        workspace,
        diff: diffSummary,
      });
      if (result.kind === "no-hook") return res.status(400).json({ error: "no-hook" });
      if (result.kind === "succeeded") return res.json({ run: result.run, output: result.output });
      if (result.kind === "timed-out") return res.status(504).json({ error: "timed-out", run: result.run });
      return res.status(502).json({ error: "hook-failed", run: result.run, message: result.error });
    }),
  );
}

export type RegisteredReviewRoutes = ReturnType<typeof registerReviewRoutes>;
export type { ReviewComment };
