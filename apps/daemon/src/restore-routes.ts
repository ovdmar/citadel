// Restore lost agent conversations. Sources its candidate list from the DB —
// every agent_sessions row whose runtime emitted a UUID (claude-code via
// --session-id, codex via discoverCodexSessionId, or backfilled from a
// transcript scan) is potentially resumable. We surface as candidates the
// workspaces whose most-recent session is stopped + has a recorded UUID,
// because that's the "the agent died and we know how to bring it back"
// signal. The Settings panel renders this list and POSTs back to /run with
// a workspaceId; we then call createAgentSession with `resumeRuntimeSessionId`
// which threads the UUID through the runtime's `resumeArg` (`--resume <uuid>`
// for claude-code).

import type { CitadelConfig } from "@citadel/config";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => express.RequestHandler;

type Deps = {
  store: SqliteStore;
  operations: OperationService;
  config: CitadelConfig;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: AsyncRoute;
};

export type RestoreCandidate = {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeId: string;
  runtimeSessionId: string;
  lastActivityAt: string;
  // Source session row whose UUID we'd resume. Useful for the UI to surface
  // "last seen N hours ago" without a second round-trip.
  sourceSessionId: string;
};

export function registerRestoreRoutes(app: express.Express, deps: Deps) {
  const { store, operations, config, emit, asyncRoute } = deps;

  app.get(
    "/api/restore/candidates",
    asyncRoute(async (_req, res) => {
      res.json({ candidates: collectRestoreCandidates(store) });
    }),
  );

  app.post(
    "/api/restore/run",
    asyncRoute(async (req, res) => {
      const workspaceId = typeof req.body?.workspaceId === "string" ? (req.body.workspaceId as string) : "";
      // Optional: caller can name a specific UUID when a workspace has more
      // than one recoverable conversation. Omitted = "the latest restorable
      // row" (back-compat with single-candidate-per-workspace callers).
      const requestedUuid =
        typeof req.body?.runtimeSessionId === "string" ? (req.body.runtimeSessionId as string) : null;
      if (!workspaceId) return res.status(400).json({ error: "workspace_id_required" });
      const workspace = store.listWorkspaces().find((w) => w.id === workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });

      // Pick the requested session, falling back to the latest with a UUID.
      // Restricting to status=stopped here would falsely refuse to restore
      // workspaces whose row got flipped to 'unknown' or 'failed' during
      // reconciliation; what matters is that there's no LIVE session
      // already attached to this UUID.
      const sessions = store.listSessions(workspace.id);
      const candidate = requestedUuid
        ? sessions.find((s) => s.runtimeSessionId === requestedUuid && !isLive(s))
        : sessions.find((s) => s.runtimeSessionId && !isLive(s));
      if (!candidate || !candidate.runtimeSessionId) {
        return res.status(409).json({ error: "no_restorable_session", workspaceId, requestedUuid });
      }
      const live = sessions.find((s) => s.runtimeSessionId === candidate.runtimeSessionId && isLive(s));
      if (live) return res.status(409).json({ error: "session_already_live", sessionId: live.id });

      const runtime = config.runtimes.find((r) => r.id === candidate.runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found", runtimeId: candidate.runtimeId });
      if (!runtime.resumeArg) {
        return res.status(400).json({ error: "runtime_does_not_support_resume", runtimeId: candidate.runtimeId });
      }

      const session = await operations.createAgentSession(
        {
          workspaceId: workspace.id,
          runtimeId: candidate.runtimeId,
          displayName: candidate.displayName,
          resumeRuntimeSessionId: candidate.runtimeSessionId,
        },
        {
          command: runtime.command,
          args: runtime.args,
          displayName: runtime.displayName,
          promptArg: runtime.promptArg ?? null,
          sessionIdArg: runtime.sessionIdArg ?? null,
          resumeArg: runtime.resumeArg ?? null,
        },
      );
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session, restoredFrom: candidate.id });
    }),
  );
}

// A session "occupies" its UUID when it's still attached to a live tmux
// pane — `idle` and `waiting_for_input` are just "agent hasn't typed in a
// while" / "agent is asking the user", not dead.
function isLive(s: AgentSession): boolean {
  return s.status === "running" || s.status === "starting" || s.status === "idle" || s.status === "waiting_for_input";
}

export function collectRestoreCandidates(store: SqliteStore): RestoreCandidate[] {
  const workspaces = store.listWorkspaces().filter((w) => !w.archivedAt);
  const candidates: RestoreCandidate[] = [];
  for (const ws of workspaces) {
    const sessions = store.listSessions(ws.id);
    if (sessions.length === 0) continue;
    // Surface *every* row with a UUID that's not currently live on that UUID.
    // A workspace with multiple recoverable conversations (e.g. a pre-restart
    // pane plus a post-restart pane) should list each so the user can pick
    // which to bring back — restoring one shouldn't hide the others.
    const seenUuids = new Set<string>();
    for (const candidate of sessions) {
      if (!candidate.runtimeSessionId) continue;
      if (isLive(candidate)) continue;
      // Dedupe by UUID within a workspace — if the same UUID got written onto
      // multiple rows (shouldn't happen, but safety net), surface one.
      if (seenUuids.has(candidate.runtimeSessionId)) continue;
      // Skip when another row holds the same UUID and is currently live
      // (it's already running; no need to offer "restore").
      const live = sessions.find((s) => s.runtimeSessionId === candidate.runtimeSessionId && isLive(s));
      if (live) continue;
      seenUuids.add(candidate.runtimeSessionId);
      candidates.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        workspacePath: ws.path,
        runtimeId: candidate.runtimeId,
        runtimeSessionId: candidate.runtimeSessionId,
        lastActivityAt: candidate.lastOutputAt ?? candidate.updatedAt,
        sourceSessionId: candidate.id,
      });
    }
  }
  // Most recently active first — that matches what the user is mentally
  // tracking ("the session I had mid-flight when it died").
  candidates.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return candidates;
}
