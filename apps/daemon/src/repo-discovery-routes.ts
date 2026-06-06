import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => express.RequestHandler;

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function registerRepoDiscoveryRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  asyncRoute: AsyncRoute;
}) {
  const { app, config, asyncRoute } = input;
  app.post(
    "/api/repos/inspect",
    asyncRoute(async (req, res) => {
      const inputPath = typeof req.body?.rootPath === "string" ? req.body.rootPath : "";
      if (!inputPath) return res.status(400).json({ error: "root_path_required" });
      const resolved = path.resolve(expandTilde(inputPath));
      const exists = fs.existsSync(resolved);
      const isGit = exists && fs.existsSync(path.join(resolved, ".git"));
      let defaultBranch: string | null = null;
      let remotes: string[] = [];
      if (isGit) {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const exec = promisify(execFileCb);
          const headRef = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
            cwd: resolved,
            timeout: 6000,
          }).catch(() => ({ stdout: "" }));
          defaultBranch = (headRef.stdout || "").trim().replace("refs/remotes/origin/", "").trim() || "main";
          const remoteList = await exec("git", ["remote"], { cwd: resolved, timeout: 6000 }).catch(() => ({
            stdout: "",
          }));
          remotes = remoteList.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        } catch {
          defaultBranch = "main";
        }
      }
      res.json({
        rootPath: resolved,
        exists,
        isGit,
        defaultBranch,
        remotes,
        suggestedWorktreeParent: path.join(path.dirname(resolved), `${path.basename(resolved)}-worktrees`),
        providerCandidates: [
          { id: "github-gh", displayName: "GitHub CLI", enabled: config.providers.github.enabled },
          { id: "jira-jtk", displayName: "Jira CLI", enabled: config.providers.jira.enabled },
        ],
      });
    }),
  );

  app.get("/api/fs/complete", (req, res) => {
    const raw = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const seed = raw || "~/";
    const trailingSlash = seed.endsWith("/");
    const expanded = expandTilde(seed);
    const baseDir = trailingSlash ? path.resolve(expanded || os.homedir()) : path.resolve(path.dirname(expanded));
    const filter = trailingSlash ? "" : path.basename(expanded);
    let entries: Array<{ name: string; path: string; isGit: boolean }> = [];
    try {
      const filterLower = filter.toLowerCase();
      const showHidden = filter.startsWith(".");
      const dirents = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        if (!showHidden && dirent.name.startsWith(".")) continue;
        if (filterLower && !dirent.name.toLowerCase().startsWith(filterLower)) continue;
        const full = path.join(baseDir, dirent.name);
        if (dirent.isSymbolicLink()) {
          try {
            if (!fs.statSync(full).isDirectory()) continue;
          } catch {
            continue;
          }
        }
        const isGit = fs.existsSync(path.join(full, ".git"));
        entries.push({ name: dirent.name, path: full, isGit });
        if (entries.length >= 100) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      entries = entries.slice(0, 50);
    } catch {
      entries = [];
    }
    res.json({ baseDir, filter, entries });
  });
}
