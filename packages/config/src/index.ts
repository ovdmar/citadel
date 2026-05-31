import { X509Certificate } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export { devStatePath, loadDevState, saveDevState, resolveWorktreeRoot, DevStateSchema } from "./dev-state.js";
export type { DevState } from "./dev-state.js";

// Built-in defaults for the agent runtimes Citadel ships with. Held as a constant so
// we can both seed the schema's default (fresh install) AND backfill missing
// fields onto user-saved configs (existing installs whose `citadel.config.json`
// was written before newer fields like `resumeArg`/`sessionIdArg` existed —
// without backfill those installs silently lose resume support).
type BuiltinAgentRuntime = {
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

const BUILTIN_AGENT_RUNTIMES: BuiltinAgentRuntime[] = [
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
    // `--yolo` (alias for `--dangerously-bypass-approvals-and-sandbox`) is a
    // global flag — codex accepts it before the `resume` subcommand, so the
    // same default works for both launch (`codex --yolo`) and resume
    // (`codex --yolo resume <uuid>`). Operators can clear it via Settings →
    // Agents if they want approval prompts back.
    args: ["--yolo"],
    // `codex resume <uuid>` is a subcommand (not a flag), but the daemon's
    // resume splice is `[resumeArg, <uuid>]` either way — passing "resume"
    // here yields the right argv. No `sessionIdArg`: codex auto-generates the
    // UUID at spawn and we recover it via discoverCodexSessionId (with a
    // lazy backfill at restore-collection time, see restore-routes.ts).
    resumeArg: "resume",
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
];

const DEFAULT_TERMINAL_PROFILE = {
  displayName: "Terminal",
  command: "bash",
  args: ["-l"],
} as const;

export const AgentRuntimeConfigSchema = z.object({
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

export const TerminalProfileConfigSchema = z.object({
  displayName: z.string().min(1).default(DEFAULT_TERMINAL_PROFILE.displayName),
  command: z.string().min(1).default(DEFAULT_TERMINAL_PROFILE.command),
  args: z.array(z.string()).default([...DEFAULT_TERMINAL_PROFILE.args]),
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

export const DEFAULT_FIX_CI_AUTOMATION = {
  enabled: true,
  runtimeId: "claude-code",
  fallbackRuntimeId: "codex",
  idleThresholdMs: 5 * 60 * 1000,
  debounceMs: 30 * 60 * 1000,
  intervalMs: 60 * 1000,
} as const;

export const FixCiAutomationConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_FIX_CI_AUTOMATION.enabled),
  runtimeId: z.string().min(1).default(DEFAULT_FIX_CI_AUTOMATION.runtimeId),
  fallbackRuntimeId: z.string().min(1).nullable().default(DEFAULT_FIX_CI_AUTOMATION.fallbackRuntimeId),
  idleThresholdMs: z.number().int().min(0).default(DEFAULT_FIX_CI_AUTOMATION.idleThresholdMs),
  debounceMs: z.number().int().min(0).default(DEFAULT_FIX_CI_AUTOMATION.debounceMs),
  intervalMs: z.number().int().min(1000).default(DEFAULT_FIX_CI_AUTOMATION.intervalMs),
});

export const AutomationConfigSchema = z
  .object({
    fixCi: FixCiAutomationConfigSchema.default(DEFAULT_FIX_CI_AUTOMATION),
  })
  .default({ fixCi: DEFAULT_FIX_CI_AUTOMATION });

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
    // Optional inline TLS. Both paths must be absolute; both files must exist
    // and be non-zero bytes; the cert must not be expired. Runtime validation
    // (file existence, expiry) lives in validateTlsAssets() — the zod refines
    // stay pure (path-shape only) so the schema has no filesystem side effects.
    tls: z
      .object({
        certPath: z
          .string()
          .min(1)
          .refine((p) => path.isAbsolute(p), "TLS certPath must be absolute"),
        keyPath: z
          .string()
          .min(1)
          .refine((p) => path.isAbsolute(p), "TLS keyPath must be absolute"),
      })
      .optional(),
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
          })
          .default({ enabled: true, command: "jtk" }),
      })
      .default({
        github: { enabled: true, command: "gh" },
        jira: { enabled: true, command: "jtk" },
      }),
    agentRuntimes: z
      .array(AgentRuntimeConfigSchema)
      .default(() => BUILTIN_AGENT_RUNTIMES.map((r) => ({ ...r, args: [...r.args] }))),
    terminal: TerminalProfileConfigSchema.default({
      ...DEFAULT_TERMINAL_PROFILE,
      args: [...DEFAULT_TERMINAL_PROFILE.args],
    }),
    usageProviders: z.array(UsageProviderConfigSchema).default([]),
    automations: AutomationConfigSchema,
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
    scratchpad: z
      .object({
        path: z
          .preprocess(
            (value) => {
              if (typeof value !== "string") return value;
              if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
              return value;
            },
            z
              .string()
              .refine(
                (value) => path.isAbsolute(value),
                "scratchpad.path must be an absolute path (e.g. /Users/you/notes.md). `~/` is expanded to your home directory.",
              ),
          )
          .optional(),
      })
      .default({}),
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
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type TerminalProfileConfig = z.infer<typeof TerminalProfileConfigSchema>;
export type UsageProviderConfig = z.infer<typeof UsageProviderConfigSchema>;
export type AutomationConfig = z.infer<typeof AutomationConfigSchema>;
export type FixCiAutomationConfig = z.infer<typeof FixCiAutomationConfigSchema>;
export type HookConfig = z.infer<typeof HookConfigSchema>;

export function defaultDataDir() {
  return process.env.CITADEL_DATA_DIR || path.join(os.homedir(), ".local", "share", "citadel");
}

export const SCRATCHPAD_DEFAULT_FILENAME = "scratchpad.md";

export function defaultNotesPath(dataDir: string) {
  return path.join(dataDir, SCRATCHPAD_DEFAULT_FILENAME);
}

// Returns the absolute filesystem path the daemon should use for the markdown
// notes file. Honors `scratchpad.path` when set (the user opted in to a custom
// location, e.g. a cloud-sync folder), else falls back to `<dataDir>/scratchpad.md`.
export function effectiveNotesPath(config: Pick<CitadelConfig, "dataDir" | "scratchpad">) {
  return config.scratchpad?.path ?? defaultNotesPath(config.dataDir);
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
    const parsed = backfillBuiltinAgentRuntimes(CitadelConfigSchema.parse(defaults));
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
    const {
      dataDir: _ignoredDataDir,
      databasePath: _ignoredDbPath,
      scratchpad: rawScratchpad,
      ...rawWithoutPaths
    } = raw ?? {};
    // Strip `scratchpad.path` while preserving sibling fields so future
    // `scratchpad.*` additions are not accidentally clobbered when the worktree
    // daemon loads a leaked prod config.
    const cleanedScratchpad =
      rawScratchpad && typeof rawScratchpad === "object"
        ? (({ path: _ignoredScratchpadPath, ...rest }) => rest)(rawScratchpad as Record<string, unknown>)
        : undefined;
    const merged: Record<string, unknown> = { ...defaults, ...rawWithoutPaths };
    if (cleanedScratchpad !== undefined) merged.scratchpad = cleanedScratchpad;
    return parseAndMaybeMigrateConfig(merged, configPath);
  }
  return parseAndMaybeMigrateConfig({ ...defaults, ...(raw ?? {}) }, configPath);
}

function parseAndMaybeMigrateConfig(raw: Record<string, unknown>, configPath: string): CitadelConfig {
  const migration = migrateLegacyRuntimes(raw);
  const parsed = backfillBuiltinAgentRuntimes(CitadelConfigSchema.parse(migration.raw));
  if (migration.didMigrate) {
    warnLegacyRuntimeMigration(configPath, migration);
    writeCanonicalConfigAfterMigration(parsed, configPath);
  }
  return parsed;
}

type LegacyRuntimeMigration = {
  raw: Record<string, unknown>;
  didMigrate: boolean;
  droppedShellLikeNames: string[];
  terminalSourceName: string | null;
};

function migrateLegacyRuntimes(raw: Record<string, unknown>): LegacyRuntimeMigration {
  if ("agentRuntimes" in raw || !Array.isArray(raw.runtimes)) {
    return { raw, didMigrate: false, droppedShellLikeNames: [], terminalSourceName: null };
  }

  const legacyRuntimes: AgentRuntimeConfig[] = [];
  for (const entry of raw.runtimes) {
    const parsed = AgentRuntimeConfigSchema.safeParse(entry);
    if (parsed.success) legacyRuntimes.push(parsed.data);
  }
  const shellLike = legacyRuntimes.filter(isShellLikeRuntime);
  const terminalSource = shellLike.find((runtime) => runtime.id === "shell") ?? shellLike[0] ?? null;
  const shellLikeIds = new Set(shellLike.map((runtime) => runtime.id));
  const agentRuntimes = legacyRuntimes.filter((runtime) => !shellLikeIds.has(runtime.id));
  const terminal = terminalSource
    ? TerminalProfileConfigSchema.parse({
        displayName: terminalSource.displayName || DEFAULT_TERMINAL_PROFILE.displayName,
        command: terminalSource.command,
        args: terminalSource.args,
      })
    : TerminalProfileConfigSchema.parse(DEFAULT_TERMINAL_PROFILE);
  const { runtimes: _legacyRuntimes, ...withoutLegacy } = raw;
  return {
    raw: {
      ...withoutLegacy,
      agentRuntimes,
      terminal,
    },
    didMigrate: true,
    droppedShellLikeNames: shellLike
      .filter((runtime) => runtime.id !== terminalSource?.id)
      .map((runtime) => `${runtime.displayName} (${runtime.id})`),
    terminalSourceName: terminalSource ? `${terminalSource.displayName} (${terminalSource.id})` : null,
  };
}

function isShellLikeRuntime(runtime: AgentRuntimeConfig): boolean {
  if (runtime.id === "shell") return true;
  const command = path.basename(runtime.command);
  return new Set(["bash", "sh", "zsh", "fish", "nu", "pwsh", "powershell"]).has(command);
}

function warnLegacyRuntimeMigration(configPath: string, migration: LegacyRuntimeMigration) {
  const terminalDetail = migration.terminalSourceName
    ? `terminal profile migrated from ${migration.terminalSourceName}`
    : "terminal profile set to the default bash login shell";
  const dropped = migration.droppedShellLikeNames.length
    ? ` Dropped legacy shell-like entries from agentRuntimes: ${migration.droppedShellLikeNames.join(", ")}.`
    : "";
  console.warn(
    `[citadel-config] Migrated legacy runtimes in ${configPath} to agentRuntimes + terminal; ${terminalDetail}.${dropped}`,
  );
}

function writeCanonicalConfigAfterMigration(config: CitadelConfig, configPath: string) {
  const backupPath = `${configPath}.legacy-runtimes.bak`;
  try {
    if (!fs.existsSync(backupPath) && fs.existsSync(configPath)) {
      fs.copyFileSync(configPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, configPath);
  } catch (error) {
    console.warn(
      `[citadel-config] Could not write canonical config to ${configPath}; using migrated config in memory only: ${
        (error as Error).message
      }`,
    );
  }
}

// Heal user-saved agent runtime entries whose on-disk shape predates newer schema
// fields (resumeArg, sessionIdArg, supportsResume, etc.). User overrides win;
// only fields the user didn't set get filled in from the built-in by id.
// Unknown ids are left untouched — those are custom agent runtimes the user added.
function backfillBuiltinAgentRuntimes(config: CitadelConfig): CitadelConfig {
  const byId = new Map(BUILTIN_AGENT_RUNTIMES.map((r) => [r.id, r] as const));
  let mutated = false;
  const agentRuntimes = config.agentRuntimes.map((runtime) => {
    const builtin = byId.get(runtime.id);
    if (!builtin) return runtime;
    const merged: Record<string, unknown> = { ...builtin };
    for (const [key, value] of Object.entries(runtime)) {
      if (value !== undefined) merged[key] = value;
    }
    const next = AgentRuntimeConfigSchema.parse(merged);
    if (
      Object.keys(next).some((k) => (next as Record<string, unknown>)[k] !== (runtime as Record<string, unknown>)[k])
    ) {
      mutated = true;
    }
    return next;
  });
  return mutated ? { ...config, agentRuntimes } : config;
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

// Runtime TLS-asset validator. Run by the daemon at boot AFTER zod-parsing.
// Refuses if cert/key files don't exist, are empty, or the cert is expired.
// Returns a "validation result" rather than throwing so callers can decide
// whether to fail-fast (daemon boot) or surface as a doctor check.
export type TlsAssetValidationResult = { ok: true; notBefore: Date; notAfter: Date } | { ok: false; reason: string };

export function validateTlsAssets(config: Pick<CitadelConfig, "tls">): TlsAssetValidationResult | null {
  if (!config.tls) return null;
  const { certPath, keyPath } = config.tls;
  let certStat: fs.Stats;
  try {
    certStat = fs.statSync(certPath);
  } catch {
    return { ok: false, reason: `TLS cert not found at ${certPath}` };
  }
  if (!certStat.isFile() || certStat.size === 0) {
    return { ok: false, reason: `TLS cert at ${certPath} is empty or not a regular file` };
  }
  try {
    const keyStat = fs.statSync(keyPath);
    if (!keyStat.isFile() || keyStat.size === 0) {
      return { ok: false, reason: `TLS key at ${keyPath} is empty or not a regular file` };
    }
  } catch {
    return { ok: false, reason: `TLS key not found at ${keyPath}` };
  }
  try {
    const pem = fs.readFileSync(certPath);
    const cert = new X509Certificate(pem);
    const now = Date.now();
    const notAfter = new Date(cert.validTo);
    const notBefore = new Date(cert.validFrom);
    if (Number.isNaN(notAfter.getTime())) {
      return { ok: false, reason: `TLS cert at ${certPath}: unparseable validTo` };
    }
    if (notAfter.getTime() < now) {
      return { ok: false, reason: `TLS cert at ${certPath} expired on ${notAfter.toISOString()}` };
    }
    return { ok: true, notBefore, notAfter };
  } catch (err) {
    return { ok: false, reason: `TLS cert at ${certPath} could not be parsed: ${(err as Error).message}` };
  }
}
