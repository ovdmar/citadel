// File-based hook discovery. Reads `<workspacePath>/.citadel/hooks/<event>/`
// and returns the list of hooks (sorted lexicographically by filename) plus
// diagnostics for any files that were skipped. The framework's existing
// config-defined hooks compose with these — see the hooks runner.
//
// Discovery is workspace-scoped (each worktree has its own checked-out
// `.citadel/hooks/`), event-scoped (one folder per event), and synchronous
// (called once per hook firing; no caching). Errors never throw — every
// failure mode produces a diagnostic, so settings UI can surface them.

import fs from "node:fs";
import path from "node:path";
import { AgentHookFrontmatterSchema, type HookEvent } from "@citadel/contracts";
import { parseFrontmatter } from "./frontmatter.js";

export type FileHookCommandFile = {
  kind: "command-file";
  id: string;
  filePath: string;
  event: HookEvent;
};

export type FileHookAgentFile = {
  kind: "agent-file";
  id: string;
  filePath: string;
  event: HookEvent;
  meta: Record<string, string>;
  body: string;
};

export type FileHook = FileHookCommandFile | FileHookAgentFile;

export type FileHookDiagnostic = {
  id: string;
  filePath: string;
  error: string;
};

export type DiscoverFileHooksInput = {
  workspacePath: string;
  event: HookEvent;
};

export type DiscoverFileHooksResult = {
  hooks: FileHook[];
  diagnostics: FileHookDiagnostic[];
};

export function discoverFileHooks(input: DiscoverFileHooksInput): DiscoverFileHooksResult {
  const eventDir = path.join(input.workspacePath, ".citadel", "hooks", input.event);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(eventDir, { withFileTypes: true });
  } catch {
    return { hooks: [], diagnostics: [] };
  }

  const hooks: FileHook[] = [];
  const diagnostics: FileHookDiagnostic[] = [];

  // Sort entries up-front so both hooks and diagnostics are emitted in the
  // same lexicographic order — predictable for tests and for users staring
  // at the settings UI.
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const ext = path.extname(entry.name);
    if (ext !== ".sh" && ext !== ".agent") continue;

    const filePath = path.join(eventDir, entry.name);
    const id = `file:${input.event}/${entry.name}`;

    if (ext === ".sh") {
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
      } catch {
        diagnostics.push({ id, filePath, error: `${filePath} exists but is not executable` });
        continue;
      }
      hooks.push({ kind: "command-file", id, filePath, event: input.event });
      continue;
    }

    // .agent — extra constraint: `agent.started` is forbidden for .agent
    // hooks. Dispatching a fresh session for a hook fired by session-start
    // would loop. .sh under agent.started is fine (subprocess execution
    // doesn't fire agent.started).
    if (input.event === "agent.started") {
      diagnostics.push({
        id,
        filePath,
        error: ".agent hooks are not allowed under agent.started/ (would cause an infinite loop); use .sh instead",
      });
      continue;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      diagnostics.push({ id, filePath, error: `failed to read .agent hook: ${describeError(error)}` });
      continue;
    }

    const parsed = parseFrontmatter(raw);
    if (parsed.error) {
      diagnostics.push({ id, filePath, error: parsed.error });
      continue;
    }

    const validation = AgentHookFrontmatterSchema.safeParse(parsed.meta);
    if (!validation.success) {
      diagnostics.push({
        id,
        filePath,
        error: `invalid frontmatter: ${validation.error.issues.map((issue) => issue.message).join("; ")}`,
      });
      continue;
    }

    if (!parsed.body.trim()) {
      diagnostics.push({ id, filePath, error: "empty body after frontmatter — nothing to send to the agent" });
      continue;
    }

    hooks.push({
      kind: "agent-file",
      id,
      filePath,
      event: input.event,
      meta: parsed.meta,
      body: parsed.body,
    });
  }

  return { hooks, diagnostics };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
