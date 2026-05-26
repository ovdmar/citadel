import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JiraAutoTransitionSchema } from "@citadel/contracts";
import { z } from "zod";

export { devStatePath, loadDevState, saveDevState, resolveWorktreeRoot, DevStateSchema } from "./dev-state.js";
export type { DevState } from "./dev-state.js";

// Built-in defaults for the runtimes Citadel ships with. Held as a constant so
// we can both seed the schema's default (fresh install) AND backfill missing
// fields onto user-saved configs (existing installs whose `citadel.config.json`
// was written before newer fields like `resumeArg`/`sessionIdArg` existed —
// without backfill those installs silently lose resume support).
type BuiltinRuntime = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  promptArg?: string;
  resumeArg?: string;
  sessionIdArg?: string;
  supportsResume?: boolean;
  supportsPrompt?: boolean;
  supportsModelSelection?: boolean;
};

const BUILTIN_RUNTIMES: BuiltinRuntime[] = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    args: [],
    // No promptArg: Claude Code's `-p` is non-interactive print mode and
    // exits after responding, which is not what Citadel agent sessions
    // want. Interactive prompts are injected into the tmux pane after the
    // runtime is ready (see operations.createAgentSession).
    resumeArg: "--resume",
    sessionIdArg: "--session-id",
    supportsResume: true,
    supportsPrompt: true,
    supportsModelSelection: true,
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    args: [],
    supportsResume: true,
    supportsPrompt: true,
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    command: "cursor-agent",
    args: [],
    supportsPrompt: true,
  },
  { id: "pi", displayName: "Pi", command: "pi", args: [] },
  { id: "shell", displayName: "Shell", command: "bash", args: ["-l"], supportsPrompt: true },
];

export const RuntimeConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptArg: z.string().optional(),
  resumeArg: z.string().optional(),
  // Flag (e.g. "--session-id") this runtime accepts to pin a caller-chosen
  // UUID on a fresh session. Citadel generates the UUID up front, persists
  // it, and uses `resumeArg` to continue the same conversation on respawn.
  // Set only for runtimes that support it (claude-code today); others rely
  // on post-spawn discovery from their transcript directory.
  sessionIdArg: z.string().optional(),
  supportsResume: z.boolean().optional(),
  supportsPrompt: z.boolean().optional(),
  supportsModelSelection: z.boolean().optional(),
  // When true, the cockpit top bar renders a low-contrast usage pill next to
  // the Settings icon for this runtime. Health-gated: a runtime that isn't
  // healthy is silently dropped from the bar regardless of this flag.
  showUsageInTopBar: z.boolean().optional(),
  // Identifies which usage category drives the top-bar pill — by default the
  // first category from the fetcher. Key shape is `<section>/<label>` when the
  // category sits inside a section, else just `<label>`. Stale keys (provider
  // renamed a row) silently fall back to the first available category.
  topBarCategoryKey: z.string().min(1).max(200).optional(),
});

export const UsageProviderConfigSchema = z.object({
  id: z.string().min(1),
  runtimeId: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z
    .string()
    .optional()
    .refine((value) => value === undefined || path.isAbsolute(value), "Usage provider cwd must be an absolute path"),
});

export const HookEventSchema = z.enum([
  "workspace.setup",
  "workspace.teardown",
  "workspace.apps",
  "workspace.action",
  "workspace.created",
  "workspace.archived",
  "workspace.removed",
  "agent.started",
]);

export const HookConfigSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal("command").default("command"),
    event: HookEventSchema,
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z
      .string()
      .optional()
      .refine((value) => value === undefined || path.isAbsolute(value), "Hook cwd must be an absolute path"),
    blocking: z.boolean().optional(),
  })
  .transform((hook) => ({
    ...hook,
    blocking: hook.blocking ?? ["workspace.setup", "workspace.teardown"].includes(hook.event),
  }));

export const CitadelConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    dataDir: z.string().min(1),
    databasePath: z.string().min(1),
    bindHost: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(4010),
    mcp: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
    providers: z
      .object({
        github: z
          .object({
            enabled: z.boolean().default(true),
            command: z.string().min(1).default("gh"),
          })
          .default({ enabled: true, command: "gh" }),
        jira: z
          .object({
            enabled: z.boolean().default(true),
            command: z.string().min(1).default("jtk"),
            projectKey: z.string().min(1).optional(),
            // Lifecycle-event-driven auto-transitions. `transition` names the
            // target status (e.g., "In Progress"); the runtime resolves it
            // to an available transition by matching `toStatus`
            // case-insensitively. Shape canonicalized in @citadel/contracts
            // (see JiraAutoTransitionSchema) — config defers to keep a
            // single source of truth.
            autoTransitions: z.array(JiraAutoTransitionSchema).default([]),
          })
          .default({ enabled: true, command: "jtk", autoTransitions: [] }),
      })
      .default({
        github: { enabled: true, command: "gh" },
        jira: { enabled: true, command: "jtk" },
      }),
    runtimes: z.array(RuntimeConfigSchema).default(() => BUILTIN_RUNTIMES.map((r) => ({ ...r, args: [...r.args] }))),
    usageProviders: z.array(UsageProviderConfigSchema).default([]),
    hooks: z.array(HookConfigSchema).default([]),
    repoDefaults: z
      .object({
        setupHookIds: z.array(z.string()).default([]),
        teardownHookIds: z.array(z.string()).default([]),
        appHookIds: z.array(z.string()).default([]),
        actionHookIds: z.array(z.string()).default([]),
      })
      .default({ setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] }),
    commandPolicy: z
      .object({
        hookTimeoutMs: z.number().int().min(1000).default(120000),
        allowDestructiveWorkspaceCleanup: z.boolean().default(false),
      })
      .default({ hookTimeoutMs: 120000, allowDestructiveWorkspaceCleanup: false }),
  })
  .superRefine((config, context) => {
    const hooksById = new Map<string, z.infer<typeof HookConfigSchema>>();
    for (const hook of config.hooks) {
      if (hooksById.has(hook.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hooks"],
          message: `Duplicate hook id: ${hook.id}`,
        });
      }
      hooksById.set(hook.id, hook);
    }

    validateHookReferences(context, hooksById, config.repoDefaults.setupHookIds, "workspace.setup", [
      "repoDefaults",
      "setupHookIds",
    ]);
    validateHookReferences(context, hooksById, config.repoDefaults.teardownHookIds, "workspace.teardown", [
      "repoDefaults",
      "teardownHookIds",
    ]);
    validateHookReferences(context, hooksById, config.repoDefaults.appHookIds, "workspace.apps", [
      "repoDefaults",
      "appHookIds",
    ]);
    validateHookReferences(context, hooksById, config.repoDefaults.actionHookIds, "workspace.action", [
      "repoDefaults",
      "actionHookIds",
    ]);
  });

export type CitadelConfig = z.infer<typeof CitadelConfigSchema>;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
export type UsageProviderConfig = z.infer<typeof UsageProviderConfigSchema>;
export type HookConfig = z.infer<typeof HookConfigSchema>;

export function defaultDataDir() {
  return process.env.CITADEL_DATA_DIR || path.join(os.homedir(), ".local", "share", "citadel");
}

// Walk up from `cwd` looking for a `.git` entry. Returns the worktree name if
// `.git` is a FILE pointing at `<mainRepo>/.git/worktrees/<name>`, otherwise
// null (main repo, or not in a git tree at all). Best-effort — any I/O or
// parse failure returns null so the caller falls back to the unscoped path.
export function detectWorktree(cwd: string = process.cwd()): { name: string; gitDir: string } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(dir, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isFile()) {
        const content = fs.readFileSync(gitPath, "utf8").trim();
        const match = /^gitdir:\s*(.+)$/mu.exec(content);
        const gitDir = match?.[1]?.trim();
        if (!gitDir) return null;
        // A worktree's gitdir is `<main>/.git/worktrees/<name>` — the basename
        // of the gitdir IS the worktree name. If the path doesn't include a
        // `/worktrees/` segment it's some other gitdir-redirect (submodule,
        // unusual setup) and we don't risk scoping it.
        if (!gitDir.includes(`${path.sep}worktrees${path.sep}`) && !gitDir.includes("/worktrees/")) {
          return null;
        }
        return { name: path.basename(gitDir), gitDir };
      }
      // .git is a directory → main repo, not a worktree.
      return null;
    } catch {
      // No .git here — climb.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// Where the daemon stores its config file. When the daemon is run from a git
// worktree (and `CITADEL_CONFIG` isn't set explicitly), scope the path to
// `<dataDir>/worktrees/<name>/citadel.config.json` so an ad-hoc dev daemon
// can't overwrite the production install's config. The production daemon
// (systemd-supervised) always passes `CITADEL_CONFIG` explicitly, so it stays
// on the canonical path regardless of `cwd`.
export function defaultConfigPath() {
  if (process.env.CITADEL_CONFIG) return process.env.CITADEL_CONFIG;
  const dataDir = defaultDataDir();
  const worktree = detectWorktree();
  if (worktree) return path.join(dataDir, "worktrees", worktree.name, "citadel.config.json");
  return path.join(dataDir, "citadel.config.json");
}

export function loadConfig(configPath = defaultConfigPath()): CitadelConfig {
  const dataDir = defaultDataDir();
  const defaults = {
    version: 1,
    dataDir,
    databasePath: path.join(dataDir, "citadel.sqlite"),
  };
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const parsed = CitadelConfigSchema.parse(defaults);
    fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    return parsed;
  }
  const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  // Worktree-mode only: strip `dataDir` / `databasePath` from the file before
  // merging, so a worktree daemon that accidentally reads the prod config
  // (leaked CITADEL_CONFIG, misconfigured paths, etc.) cannot inherit the
  // prod data paths from the file — env-derived defaults win instead.
  //
  // Prod mode (no CITADEL_WORKTREE=1): honor the file's `dataDir` /
  // `databasePath` so an operator who has customized those settings in
  // `~/.local/share/citadel/citadel.config.json` actually sees them applied.
  if (process.env.CITADEL_WORKTREE === "1") {
    const { dataDir: _ignoredDataDir, databasePath: _ignoredDbPath, ...rawWithoutPaths } = raw ?? {};
    return backfillBuiltinRuntimes(CitadelConfigSchema.parse({ ...defaults, ...rawWithoutPaths }));
  }
  return backfillBuiltinRuntimes(CitadelConfigSchema.parse({ ...defaults, ...(raw ?? {}) }));
}

// Heal user-saved runtime entries whose on-disk shape predates newer schema
// fields (resumeArg, sessionIdArg, supportsResume, etc.). User overrides win;
// only fields the user didn't set get filled in from the built-in by id.
// Unknown ids are left untouched — those are custom runtimes the user added.
function backfillBuiltinRuntimes(config: CitadelConfig): CitadelConfig {
  const byId = new Map(BUILTIN_RUNTIMES.map((r) => [r.id, r] as const));
  let mutated = false;
  const runtimes = config.runtimes.map((runtime) => {
    const builtin = byId.get(runtime.id);
    if (!builtin) return runtime;
    const merged: Record<string, unknown> = { ...builtin };
    for (const [key, value] of Object.entries(runtime)) {
      if (value !== undefined) merged[key] = value;
    }
    const next = RuntimeConfigSchema.parse(merged);
    if (
      Object.keys(next).some((k) => (next as Record<string, unknown>)[k] !== (runtime as Record<string, unknown>)[k])
    ) {
      mutated = true;
    }
    return next;
  });
  return mutated ? { ...config, runtimes } : config;
}

export function saveConfig(config: CitadelConfig, configPath = defaultConfigPath()) {
  const parsed = CitadelConfigSchema.parse(config);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  return parsed;
}

export function mergeConfigPatch(current: CitadelConfig, patch: unknown) {
  return CitadelConfigSchema.parse({
    ...current,
    ...(typeof patch === "object" && patch !== null ? patch : {}),
  });
}

function validateHookReferences(
  context: z.RefinementCtx,
  hooksById: Map<string, z.infer<typeof HookConfigSchema>>,
  hookIds: string[],
  event: z.infer<typeof HookConfigSchema>["event"],
  pathPrefix: Array<string | number>,
) {
  hookIds.forEach((hookId, index) => {
    const hook = hooksById.get(hookId);
    if (!hook) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index],
        message: `Unknown hook id: ${hookId}`,
      });
      return;
    }
    if (hook.event !== event) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...pathPrefix, index],
        message: `Hook ${hookId} is configured for ${hook.event}, not ${event}`,
      });
    }
  });
}
