// Jira-integration HTTP surface, extracted from apps/daemon/src/app.ts to
// keep app.ts under the 800-line file-size gate.
//
// Owns:
//  - POST /api/workspaces/:workspaceId/issue-transition (operator-driven
//    transition; payload validated against TransitionIssueInputSchema).
//  - GET  /api/integrations/jira/search?q=...           (picker backend;
//    empty q returns recent issues by default).
//
// No server-side cache on the search route: every keystroke produces a
// distinct query string, so a server cache would never hit. The 250 ms
// client debounce + React Query 5 s stale-time provide all the
// back-pressure that's needed and keep picker results fresh after attach.

import { TransitionIssueInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type {
  searchJiraIssues as searchJiraIssuesType,
  transitionJiraIssue as transitionJiraIssueType,
} from "@citadel/providers";
import type express from "express";

type Emit = (type: string, payload: unknown) => void;
type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export type JiraRoutesProviders = {
  transitionJiraIssue: typeof transitionJiraIssueType;
  searchJiraIssues: typeof searchJiraIssuesType;
};

export function registerJiraRoutes(input: {
  app: express.Express;
  asyncRoute: AsyncRoute;
  store: SqliteStore;
  providers: JiraRoutesProviders;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  emit: Emit;
}) {
  const { app, asyncRoute, store, providers, providerCache, emit } = input;

  app.post(
    "/api/workspaces/:workspaceId/issue-transition",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const input = TransitionIssueInputSchema.parse(req.body);
      const result = await providers.transitionJiraIssue({
        issueKey: workspace.issueKey,
        transition: input.transition,
        fields: input.fields,
      });
      providerCache.delete(`issue:${workspace.issueKey}`);
      emit("provider.issue_transition", { workspaceId: workspace.id, issueKey: workspace.issueKey, result });
      res.status(result.status === "healthy" ? 202 : 424).json({ result });
    }),
  );

  app.get(
    "/api/integrations/jira/search",
    asyncRoute(async (req, res) => {
      const rawQuery = typeof req.query.q === "string" ? req.query.q : null;
      const response = await providers.searchJiraIssues(rawQuery);
      res.json(response);
    }),
  );
}
