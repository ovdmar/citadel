import { RuntimeModelSchema } from "@citadel/contracts";
import { z } from "zod";

type RuntimeLaunchOptionsConfig = {
  models?: Array<{ id: string; label: string; default?: boolean; deprecated?: boolean }>;
  defaultModel?: string | null;
  effortValues?: string[];
  supportsFastMode?: boolean;
  contextModes?: string[];
  modelArgv?: { argv: string[] };
  effortArgv?: { argv: string[] };
  fastArgv?: { argv: string[] };
  contextArgv?: { argv: string[] };
  systemPromptArgv?: { argv: string[]; valueEncoding: "raw" | "toml-string" };
};

export type BuiltinAgentRuntime = {
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
  launchOptions?: RuntimeLaunchOptionsConfig;
};

export const CODEX_GOALS_FEATURE_ARGS = ["--enable", "goals"] as const;

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
  launchOptions: z
    .object({
      models: z.array(RuntimeModelSchema).default([]),
      defaultModel: z.string().min(1).nullable().default(null),
      effortValues: z.array(z.string().min(1)).default([]),
      supportsFastMode: z.boolean().default(false),
      contextModes: z.array(z.string().min(1)).default([]),
      modelArgv: z.object({ argv: z.array(z.string().min(1)).min(1) }).optional(),
      effortArgv: z.object({ argv: z.array(z.string().min(1)).min(1) }).optional(),
      fastArgv: z.object({ argv: z.array(z.string().min(1)).min(1) }).optional(),
      contextArgv: z.object({ argv: z.array(z.string().min(1)).min(1) }).optional(),
      systemPromptArgv: z
        .object({
          argv: z.array(z.string().min(1)).min(1),
          valueEncoding: z.enum(["raw", "toml-string"]),
        })
        .optional(),
    })
    .optional(),
});

export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;

export const BUILTIN_AGENT_RUNTIMES: BuiltinAgentRuntime[] = [
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
    launchOptions: {
      models: [
        { id: "sonnet", label: "Sonnet", default: true },
        { id: "opus", label: "Opus" },
        { id: "haiku", label: "Haiku" },
      ],
      defaultModel: "sonnet",
      modelArgv: { argv: ["--model", "{value}"] },
      systemPromptArgv: { argv: ["--append-system-prompt", "{value}"], valueEncoding: "raw" },
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    // `--yolo` (alias for `--dangerously-bypass-approvals-and-sandbox`) is a
    // global flag — codex accepts it before the `resume` subcommand, so the
    // same default works for both launch (`codex --yolo`) and resume
    // (`codex --yolo resume <uuid>`). `--enable goals` turns on Codex's
    // experimental goals feature for every Citadel-launched Codex session.
    // Operators can still clear `--yolo` via Settings -> Agents if they
    // want approval prompts back; Citadel keeps the goals flag enabled.
    args: ensureCodexGoalsFeatureArgs("codex", ["--yolo"]),
    // `codex resume <uuid>` is a subcommand (not a flag), but the daemon's
    // resume splice is `[resumeArg, <uuid>]` either way — passing "resume"
    // here yields the right argv. No `sessionIdArg`: codex auto-generates the
    // UUID at spawn and we recover it via discoverCodexSessionId (with a
    // lazy backfill at restore-collection time, see restore-routes.ts).
    resumeArg: "resume",
    supportsResume: true,
    supportsPrompt: true,
    supportsModelSelection: true,
    launchOptions: {
      models: [
        { id: "gpt-5.4", label: "GPT-5.4", default: true },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      ],
      defaultModel: "gpt-5.4",
      effortValues: ["low", "medium", "high", "xhigh"],
      contextModes: ["standard", "max"],
      modelArgv: { argv: ["-m", "{value}"] },
      effortArgv: { argv: ["-c", "model_reasoning_effort={value}"] },
      contextArgv: { argv: ["-c", "model_context_window={value}"] },
      systemPromptArgv: { argv: ["-c", "developer_instructions={value}"], valueEncoding: "toml-string" },
    },
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    command: "cursor-agent",
    args: [],
    supportsPrompt: true,
    supportsModelSelection: true,
    launchOptions: {
      modelArgv: { argv: ["--model", "{value}"] },
      supportsFastMode: true,
      fastArgv: { argv: ["--fast"] },
    },
  },
  { id: "pi", displayName: "Pi", command: "pi", args: [] },
];

export function ensureCodexGoalsFeatureArgs(runtimeId: string, args: readonly string[]): string[] {
  const current = [...args];
  if (runtimeId !== "codex" || hasCodexGoalsFeatureEnabled(current)) return current;
  return [...current, ...CODEX_GOALS_FEATURE_ARGS];
}

function hasCodexGoalsFeatureEnabled(args: readonly string[]): boolean {
  let enabled: boolean | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--enable" && args[index + 1] === "goals") {
      enabled = true;
      index += 1;
      continue;
    }
    if (arg === "--disable" && args[index + 1] === "goals") {
      enabled = false;
      index += 1;
      continue;
    }
    if (arg === "--enable=goals") {
      enabled = true;
      continue;
    }
    if (arg === "--disable=goals") {
      enabled = false;
      continue;
    }
    if (arg === "-c" || arg === "--config") {
      const state = goalsFeatureConfigState(args[index + 1]);
      if (state !== null) enabled = state;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--config=")) {
      const state = goalsFeatureConfigState(arg.slice("--config=".length));
      if (state !== null) enabled = state;
    }
  }
  return enabled === true;
}

function goalsFeatureConfigState(value: string | undefined): boolean | null {
  if (typeof value !== "string") return null;
  const match = /^\s*features\.goals\s*=\s*(true|false)\s*$/i.exec(value);
  if (!match?.[1]) return null;
  return match[1].toLowerCase() === "true";
}
