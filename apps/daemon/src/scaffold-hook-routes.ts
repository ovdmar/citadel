import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CitadelConfig } from "@citadel/config";
import type { LaunchAgentInput, Repo } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type express from "express";

// AI-assisted hook scaffolding empty state.
//
// POST /api/repos/:repoId/scaffold-hook spawns a workspace named
// hook-scaffold-<ts> and starts a Claude Code session primed with the
// canonical .citadel/hooks/deploy template (assets/hook-templates/citadel-deploy.sh).
// The operator then commits + PRs through the standard workspace lifecycle.
//
// In-flight reuse: a second click on the same repo finds an existing
// hook-scaffold-* workspace (lifecycle === "ready") and returns its session
// instead of spawning a duplicate. Stops "scaffold + abandon" worktree
// accumulation; respects the workspace-cleanup-safety gate (no auto-delete).

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

// Path to the canonical template, resolved relative to this file. Falls back
// to the repo's working tree assets path when the daemon runs from source.
function templatePath(): string {
  const here = fileURLToPath(import.meta.url);
  // packaged build: apps/daemon/dist/scaffold-hook-routes.js → up to repo root.
  const candidates = [
    path.resolve(path.dirname(here), "..", "..", "..", "assets", "hook-templates", "citadel-deploy.sh"),
    path.resolve(path.dirname(here), "..", "..", "assets", "hook-templates", "citadel-deploy.sh"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Last-resort: relative to cwd (development).
  return path.resolve(process.cwd(), "assets/hook-templates/citadel-deploy.sh");
}

export function loadHookTemplate(): string {
  return fs.readFileSync(templatePath(), "utf8");
}

export function buildHookScaffoldPrompt(input: { repo: Repo; template: string }): string {
  const { repo, template } = input;
  return [
    `You are scaffolding a Citadel deploy hook for repository "${repo.name}".`,
    "",
    `The repository is registered at: ${repo.rootPath}`,
    `Your current working directory is a fresh worktree of that repo on a new branch.`,
    "",
    "## Your task",
    "",
    "1. Write the file `.citadel/hooks/deploy` adapted to this repo's actual app(s).",
    "   - The hook receives a subcommand in $1: `list` returns JSON describing the deployable",
    `     apps; \`redeploy [name]\` (re)starts them. The exact contract is in the canonical`,
    "     template below.",
    "   - Replace the placeholder PORT/HOST derivation with whatever makes sense for this repo",
    "     (Makefile target, an env file, kubectl, docker, etc.).",
    "   - Replace `make dev-deploy` in the redeploy branch with the repo's actual restart command.",
    "",
    "2. Make it executable: `chmod +x .citadel/hooks/deploy`",
    "",
    "3. Validate: run `./.citadel/hooks/deploy list` and confirm it prints",
    `   \`{"apps":[{"name":"...","url":"http://..."}]}\` that parses as JSON.`,
    "",
    "4. Iterate until step 3 succeeds. Then stop — the operator will commit and open a PR through",
    "   the normal Citadel workspace flow.",
    "",
    "## Environment provided at runtime",
    "",
    "- `CITADEL_WORKSPACE_ID` — opaque workspace id",
    "- `CITADEL_WORKSPACE_PATH` — absolute path to the worktree (same as cwd)",
    "- `CITADEL_WORKSPACE_BRANCH`",
    "- `CITADEL_REPO_ID`",
    "",
    "## Canonical template",
    "",
    "Use this as a starting point. Adapt it to the repo — do not copy verbatim.",
    "",
    "```bash",
    template.trim(),
    "```",
    "",
    "Begin.",
  ].join("\n");
}

const HOOK_SCAFFOLD_BRANCH_PREFIX = "hook-scaffold-";

export function findInFlightScaffold(input: {
  store: SqliteStore;
  repoId: string;
}): { workspaceId: string; sessionId: string | null; branchName: string; workspacePath: string } | null {
  const workspaces = input.store.listWorkspaces();
  for (const ws of workspaces) {
    if (ws.repoId !== input.repoId) continue;
    if (ws.lifecycle !== "ready") continue;
    if (!ws.branch.startsWith(HOOK_SCAFFOLD_BRANCH_PREFIX)) continue;
    const sessions = input.store.listSessions(ws.id);
    const running = sessions.find((s) => s.status === "running" || s.status === "starting");
    return {
      workspaceId: ws.id,
      sessionId: running?.id ?? null,
      branchName: ws.branch,
      workspacePath: ws.path,
    };
  }
  return null;
}

export function registerScaffoldHookRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  asyncRoute: AsyncRoute;
  // Test seam — override the template loader so tests don't depend on the
  // physical file on disk.
  loadTemplate?: () => string;
}) {
  const { app, config, store, operations, asyncRoute } = input;
  const loadTemplate = input.loadTemplate ?? loadHookTemplate;

  app.post(
    "/api/repos/:repoId/scaffold-hook",
    asyncRoute(async (req, res) => {
      const rawRepoId = req.params.repoId;
      const repoId = typeof rawRepoId === "string" ? rawRepoId : "";
      const repo = store.listRepos().find((r) => r.id === repoId);
      if (!repo) {
        return res.status(404).json({ error: "repo_not_found" });
      }

      const reused = findInFlightScaffold({ store, repoId });
      if (reused) {
        return res.json({
          workspaceId: reused.workspaceId,
          sessionId: reused.sessionId,
          branchName: reused.branchName,
          workspacePath: reused.workspacePath,
          operationId: null,
          reused: true,
        });
      }

      const ts = Date.now().toString(36);
      const workspaceName = `hook-scaffold-${ts}`;
      const branchName = `hook-scaffold-${ts}`;
      const template = loadTemplate();
      const prompt = buildHookScaffoldPrompt({ repo, template });

      const runtime = config.runtimes.find((r) => r.id === "claude-code") ?? config.runtimes[0];
      if (!runtime) {
        return res.status(500).json({ error: "no_runtime_configured" });
      }

      const launchInput: LaunchAgentInput = {
        repoId: repo.id,
        prompt,
        runtimeId: runtime.id,
        workspaceName,
        branchName,
      };
      const result = await operations.launchAgent(launchInput, {
        command: runtime.command,
        args: runtime.args,
        displayName: runtime.displayName,
        promptArg: runtime.promptArg ?? null,
        sessionIdArg: runtime.sessionIdArg ?? null,
        resumeArg: runtime.resumeArg ?? null,
      });
      if (result.error) {
        return res.status(409).json({ error: "scaffold_failed", detail: result.error });
      }
      return res.status(201).json({
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        branchName: result.branchName,
        workspacePath: result.workspacePath,
        operationId: result.operationId,
        reused: false,
      });
    }),
  );
}
