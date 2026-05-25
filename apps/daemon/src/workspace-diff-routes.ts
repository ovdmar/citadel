// `/api/workspaces/:workspaceId/diff` and `/recent-commits`. Extracted from
// app.ts so that file stays under the 800-line size gate.

import type { SqliteStore } from "@citadel/db";
import type express from "express";
import { readWorkspaceDiff, readWorkspaceRecentCommits } from "./workspace-diff.js";

export function registerWorkspaceDiffRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  asyncRoute: (handler: (req: express.Request, res: express.Response) => Promise<unknown>) => express.RequestHandler;
}) {
  const { app, store, asyncRoute } = input;
  app.get("/api/workspaces/:workspaceId/diff", (req, res) => {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
    res.json(readWorkspaceDiff(workspace.id, workspace.path));
  });
  app.get(
    "/api/workspaces/:workspaceId/recent-commits",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const limitParam = Number.parseInt(String(req.query.limit ?? "8"), 10);
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 8;
      res.json(readWorkspaceRecentCommits(workspace.id, workspace.path, limit));
    }),
  );
}
