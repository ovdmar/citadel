import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const RuntimeConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  promptArg: z.string().optional(),
  resumeArg: z.string().optional(),
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
          })
          .default({ enabled: true, command: "jtk" }),
      })
      .default({
        github: { enabled: true, command: "gh" },
        jira: { enabled: true, command: "jtk" },
      }),
    runtimes: z.array(RuntimeConfigSchema).default([
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
    ]),
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

export function defaultConfigPath() {
  return process.env.CITADEL_CONFIG || path.join(defaultDataDir(), "citadel.config.json");
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
  return CitadelConfigSchema.parse({ ...defaults, ...raw });
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
