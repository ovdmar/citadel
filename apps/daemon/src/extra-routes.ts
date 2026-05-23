import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type express from "express";
import { SCRATCHPAD_MAX_BYTES, readScratchpad, writeScratchpad } from "./scratchpad.js";

type Emit = (type: string, payload: unknown) => void;
type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export function registerWorkspaceExtraRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  emit: Emit;
  asyncRoute: AsyncRoute;
}) {
  const { app, store, config, emit, asyncRoute } = input;

  app.get("/api/scratchpad", (_req, res) => {
    res.json(readScratchpad(config.dataDir));
  });

  app.put("/api/scratchpad", (req, res) => {
    const body = (req.body ?? {}) as { content?: unknown };
    if (typeof body.content !== "string") return res.status(400).json({ error: "content_required" });
    if (Buffer.byteLength(body.content, "utf8") > SCRATCHPAD_MAX_BYTES) {
      return res.status(413).json({ error: "scratchpad_too_large", limit: SCRATCHPAD_MAX_BYTES });
    }
    const snapshot = writeScratchpad(config.dataDir, body.content);
    emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
    res.json(snapshot);
  });

  app.get("/api/workspaces/archived", (_req, res) => {
    res.json({ workspaces: store.listArchivedWorkspaces() });
  });

  app.patch(
    "/api/workspaces/:workspaceId",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const patch = (req.body ?? {}) as Record<string, unknown>;
      const allowed: Parameters<typeof store.updateWorkspace>[1] = {};
      if (typeof patch.name === "string" && patch.name.trim().length) allowed.name = patch.name.trim();
      if (typeof patch.issueKey === "string" || patch.issueKey === null)
        allowed.issueKey = patch.issueKey as string | null;
      if (typeof patch.issueTitle === "string" || patch.issueTitle === null)
        allowed.issueTitle = patch.issueTitle as string | null;
      if (typeof patch.issueUrl === "string" || patch.issueUrl === null)
        allowed.issueUrl = patch.issueUrl as string | null;
      if (typeof patch.slackThreadUrl === "string" || patch.slackThreadUrl === null)
        allowed.slackThreadUrl = patch.slackThreadUrl as string | null;
      if (typeof patch.pinned === "boolean") allowed.pinned = patch.pinned;
      store.updateWorkspace(workspace.id, allowed);
      const next = store.listWorkspaces().find((candidate) => candidate.id === workspace.id);
      emit("workspace.updated", { workspaceId: workspace.id, workspace: next });
      res.json({ workspace: next });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/unarchive",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspace = store.listArchivedWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const exists = Boolean(workspace.path) && fs.existsSync(workspace.path);
      if (!exists) return res.status(409).json({ error: "workspace_path_missing" });
      store.unarchiveWorkspace(workspace.id);
      const next = store.listWorkspaces().find((candidate) => candidate.id === workspace.id);
      emit("workspace.updated", { workspaceId: workspace.id, workspace: next });
      res.json({ workspace: next });
    }),
  );

  app.patch(
    "/api/agent-sessions/:sessionId",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const patch = (req.body ?? {}) as Record<string, unknown>;
      const displayName = typeof patch.displayName === "string" ? patch.displayName.trim() : "";
      if (!displayName) return res.status(400).json({ error: "display_name_required" });
      const session = store.listSessions().find((candidate) => candidate.id === sessionId);
      if (!session) return res.status(404).json({ error: "session_not_found" });
      store.updateSessionDisplayName(sessionId, displayName);
      const updated = store.listSessions().find((candidate) => candidate.id === sessionId);
      emit("agent.updated", { sessionId });
      res.json({ session: updated });
    }),
  );

  // GitHub search/clone helpers used by the AddRepo modal. Both require gh to be
  // available and authenticated; failures surface as structured errors so the UI
  // can render an explicit empty state.
  app.get(
    "/api/integrations/github/search",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const query = typeof req.query.q === "string" ? req.query.q : "";
      if (!query) return res.json({ results: [] });
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFileCb);
        const { stdout } = await exec(
          "gh",
          ["search", "repos", query, "--limit", "8", "--json", "fullName,url,description"],
          { timeout: 10_000 },
        );
        const parsed = JSON.parse(stdout) as Array<{ fullName: string; url: string; description?: string }>;
        res.json({
          results: parsed.map((entry) => ({
            name: entry.fullName,
            url: entry.url,
            description: entry.description ?? undefined,
          })),
        });
      } catch (error) {
        res.status(200).json({ results: [], error: error instanceof Error ? error.message : "gh_search_failed" });
      }
    }),
  );

  app.post(
    "/api/integrations/github/clone",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as { url?: string; targetDir?: string };
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url) return res.status(400).json({ error: "url_required" });
      const parent =
        body.targetDir && typeof body.targetDir === "string" ? body.targetDir : path.join(os.homedir(), "Workspace");
      try {
        fs.mkdirSync(parent, { recursive: true });
      } catch (error) {
        return res
          .status(500)
          .json({ error: "workspace_root_unwritable", detail: error instanceof Error ? error.message : "" });
      }
      const slug = (url.split("/").pop() || "repo").replace(/\.git$/, "");
      const rootPath = path.join(parent, slug);
      if (fs.existsSync(rootPath)) {
        return res.json({ rootPath, cloned: false });
      }
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFileCb);
        await exec("gh", ["repo", "clone", url, rootPath], { timeout: 120_000 });
        res.json({ rootPath, cloned: true });
      } catch (error) {
        res.status(200).json({
          rootPath,
          cloned: false,
          error: error instanceof Error ? error.message : "gh_clone_failed",
        });
      }
    }),
  );

  app.get(
    "/api/integrations/issues/recent",
    asyncRoute(async (_req: express.Request, res: express.Response) => {
      // Issue providers are workspace-scoped today. Without an attached repo or workspace
      // we cannot identify the project, so we return an empty payload with an
      // explanatory error string the UI surfaces verbatim.
      res.status(200).json({ issues: [], error: "Configure a default issue provider to populate suggestions." });
    }),
  );
}
