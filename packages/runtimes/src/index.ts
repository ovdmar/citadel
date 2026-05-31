import { execFileSync } from "node:child_process";
import os from "node:os";
import type { AgentRuntimeConfig } from "@citadel/config";
import type { AgentRuntime } from "@citadel/contracts";

export {
  claudeProjectsDir,
  parseClaudeTranscript,
  findClaudeTranscriptForSession,
  renderClaudeTranscriptAsText,
  claudeCodeAdapter,
  codexAdapter,
  cursorAgentAdapter,
  getTranscriptAdapter,
  getUserPromptsForSession,
  parseCodexRollout,
  findCodexRolloutForSession,
  codexSessionsRoot,
  discoverCodexSessionId,
  discoverCodexSessionIdFromProcess,
  extractCodexResumeSessionIdFromArgv,
} from "./transcripts/index.js";
export type { RuntimeUserPrompt, RuntimeTranscriptAdapter, GetUserPromptsInput } from "./transcripts/index.js";
export {
  codexSqliteHomeForWorkspace,
  prepareCodexSqliteHomeForWorkspace,
} from "./codex-sqlite-home.js";

export {
  runtimeUsageFetchers,
  hasRuntimeUsageFetcher,
  fetchClaudeUsageCategories,
  parseClaudeUsageCategories,
  extractClaudeUsagePanel,
  fetchCodexUsageCategories,
  parseCodexUsageCategories,
  extractCodexStatusPanel,
} from "./usage/index.js";
export type { RuntimeUsageFetcher } from "./usage/index.js";

export {
  CODEX_REASON_CURRENT_TURN_DIVIDER,
  CODEX_REASON_INTERRUPT,
  CODEX_REASON_SANDBOX_APPROVAL,
  CODEX_REASON_STABLE_TIMEOUT,
  REASON_ELAPSED_TIMER,
  getStatusAdapter,
  claudeCodeStatusAdapter,
  codexStatusAdapter,
  lastNonEmptyLine,
  observeActiveElapsedTimer,
} from "./status/index.js";
export type {
  RuntimeStatusAdapter,
  SessionAdapterState,
  ObservationContext,
  PaneObservation,
  PaneObservationResult,
  ActiveElapsedTimerProbe,
} from "./status/index.js";

const baseCapabilities = {
  supportsPrompt: false,
  supportsResume: false,
  supportsModelSelection: false,
  supportsTranscript: false,
  supportsStatusDetection: true,
  supportsNonInteractiveGoal: false,
  supportsShell: true,
  supportsUsage: false,
  // Default is false (simple command runtimes emit line-buffered text). The
  // builtin overrides below flip it on for the known TUI runtimes so the
  // scheduled-agents UI can disable runMode='background' for them.
  supportsTui: false,
};

// Built-in capability defaults applied to known runtime IDs.
// Operator config can override these explicitly per runtime.
const builtinCapabilities: Record<string, Partial<typeof baseCapabilities>> = {
  "claude-code": {
    supportsPrompt: true,
    supportsResume: true,
    supportsModelSelection: true,
    supportsTranscript: true,
    supportsNonInteractiveGoal: true,
    supportsUsage: true,
    supportsTui: true,
  },
  codex: {
    supportsPrompt: true,
    supportsResume: true,
    supportsNonInteractiveGoal: true,
    supportsTui: true,
    supportsUsage: true,
  },
  "cursor-agent": {
    supportsPrompt: true,
    supportsNonInteractiveGoal: true,
    supportsTui: true,
  },
  pi: {
    supportsPrompt: true,
  },
};

export function capabilitiesForRuntime(runtime: AgentRuntimeConfig) {
  const built = builtinCapabilities[runtime.id] ?? {};
  const explicit: Partial<typeof baseCapabilities> = {};
  if (runtime.supportsPrompt !== undefined) explicit.supportsPrompt = runtime.supportsPrompt;
  if (runtime.supportsResume !== undefined) explicit.supportsResume = runtime.supportsResume;
  if (runtime.supportsModelSelection !== undefined) explicit.supportsModelSelection = runtime.supportsModelSelection;
  return { ...baseCapabilities, ...built, ...explicit };
}

export type RuntimeHealthState = Pick<AgentRuntime, "health" | "healthReason">;

export type RuntimeCommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

export type RuntimeCommandRunner = (
  command: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
) => RuntimeCommandResult;

export type RuntimeHealthOptions = {
  commandExists?: (command: string) => boolean;
  probeClaudeCode?: (runtime: AgentRuntimeConfig) => RuntimeHealthState;
};

const CLAUDE_CODE_HEALTH_PROBE_PROMPT = "Reply with OK.";
const CLAUDE_CODE_HEALTH_PROBE_ARGS = [
  "--print",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--max-budget-usd",
  "0.000001",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--setting-sources",
  "user",
];
const CLAUDE_CODE_HEALTH_PROBE_TIMEOUT_MS = 8_000;
const CLAUDE_CODE_HEALTH_PROBE_TTL_MS = 5 * 60_000;
const ANSI_ESCAPE_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const AUTH_OR_BILLING_FAILURE_REGEX =
  /\b(401|403|auth|authenticated|authorization|billing|credit|disabled|forbidden|login|organization|payment|subscription|api key)\b/i;
const PROBE_BUDGET_LIMIT_REGEX = /\b(max(?:imum)?[- ]budget|budget (?:exceeded|limit)|exceeded .*budget)\b/i;

const runtimeHealthProbeCache = new Map<string, { expiresAt: number; value: RuntimeHealthState }>();

export function clearRuntimeHealthProbeCache() {
  runtimeHealthProbeCache.clear();
}

export function listRuntimeHealth(
  configured: AgentRuntimeConfig[],
  options: RuntimeHealthOptions = {},
): AgentRuntime[] {
  const checkCommandExists = options.commandExists ?? commandExists;
  const probeClaude =
    options.probeClaudeCode ?? ((runtime: AgentRuntimeConfig) => probeClaudeCodeHealth(runtime.command));
  return configured.map((runtime) => {
    const available = checkCommandExists(runtime.command);
    const healthState = available
      ? runtime.id === "claude-code"
        ? probeClaude(runtime)
        : { health: "healthy" as const, healthReason: null }
      : { health: "unavailable" as const, healthReason: `Command not found on PATH: ${runtime.command}` };
    return {
      id: runtime.id,
      displayName: runtime.displayName,
      command: runtime.command,
      args: runtime.args,
      health: healthState.health,
      healthReason: healthState.healthReason,
      capabilities: capabilitiesForRuntime(runtime),
    };
  });
}

export function probeClaudeCodeHealth(
  command: string,
  options: {
    runner?: RuntimeCommandRunner;
    nowMs?: () => number;
    cacheTtlMs?: number;
  } = {},
): RuntimeHealthState {
  const runner = options.runner ?? runRuntimeCommand;
  const nowMs = options.nowMs ?? Date.now;
  const cacheTtlMs = options.cacheTtlMs ?? CLAUDE_CODE_HEALTH_PROBE_TTL_MS;
  const cacheKey = `claude-code:${command}`;
  const shouldUseCache = options.runner === undefined && cacheTtlMs > 0;
  const now = nowMs();
  if (shouldUseCache) {
    const cached = runtimeHealthProbeCache.get(cacheKey);
    if (cached && cached.expiresAt > now) return cached.value;
  }

  const value = evaluateClaudeCodeHealthProbe(
    runner(command, CLAUDE_CODE_HEALTH_PROBE_ARGS, {
      input: CLAUDE_CODE_HEALTH_PROBE_PROMPT,
      timeoutMs: CLAUDE_CODE_HEALTH_PROBE_TIMEOUT_MS,
    }),
  );
  if (shouldUseCache) runtimeHealthProbeCache.set(cacheKey, { expiresAt: now + cacheTtlMs, value });
  return value;
}

function evaluateClaudeCodeHealthProbe(result: RuntimeCommandResult): RuntimeHealthState {
  if (result.timedOut) {
    return {
      health: "degraded",
      healthReason: `Claude Code health probe timed out after ${CLAUDE_CODE_HEALTH_PROBE_TIMEOUT_MS / 1000}s`,
    };
  }

  const parsed = parseJsonObject(result.stdout);
  if (parsed) {
    if (parsed.is_error === true) {
      const message = cleanRuntimeMessage(
        typeof parsed.result === "string"
          ? parsed.result
          : `Claude Code returned api_error_status=${String(parsed.api_error_status ?? result.status)}`,
      );
      if (PROBE_BUDGET_LIMIT_REGEX.test(message)) return { health: "healthy", healthReason: null };
      return {
        health: isAuthOrBillingFailure(message, parsed.api_error_status) ? "unavailable" : "degraded",
        healthReason: `Claude Code rejected a health probe: ${message}`,
      };
    }
    return { health: "healthy", healthReason: null };
  }

  if (result.status === 0) return { health: "healthy", healthReason: null };

  const message = cleanRuntimeMessage(result.stderr || result.stdout || `exit status ${result.status}`);
  return {
    health: isAuthOrBillingFailure(message, result.status) ? "unavailable" : "degraded",
    healthReason: `Claude Code health probe failed: ${message}`,
  };
}

function runRuntimeCommand(
  command: string,
  args: string[],
  options: { input?: string; timeoutMs: number },
): RuntimeCommandResult {
  try {
    const stdout = execFileSync(command, args, {
      cwd: os.tmpdir(),
      encoding: "utf8",
      input: options.input,
      maxBuffer: 128 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeoutMs,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const execError = asExecFileSyncError(error);
    return {
      status: typeof execError.status === "number" ? execError.status : 1,
      stdout: bufferLikeToString(execError.stdout),
      stderr: bufferLikeToString(execError.stderr) || execError.message || "",
      timedOut: execError.signal === "SIGTERM" || execError.code === "ETIMEDOUT",
    };
  }
}

type ExecFileSyncError = {
  status?: number | null;
  stdout?: Buffer | string | Uint8Array | null;
  stderr?: Buffer | string | Uint8Array | null;
  signal?: NodeJS.Signals | string | null;
  code?: string | number;
  message?: string;
};

function asExecFileSyncError(error: unknown): ExecFileSyncError {
  if (error && typeof error === "object") return error as ExecFileSyncError;
  return {};
}

function bufferLikeToString(value: Buffer | string | Uint8Array | null | undefined): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return "";
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}

function isAuthOrBillingFailure(message: string, status: unknown): boolean {
  return status === 401 || status === 403 || AUTH_OR_BILLING_FAILURE_REGEX.test(message);
}

function cleanRuntimeMessage(input: string): string {
  const normalized = input.replace(ANSI_ESCAPE_REGEX, "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

export function commandExists(command: string) {
  try {
    execFileSync("bash", ["-lc", `command -v ${shellQuote(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function shellQuote(input: string) {
  return `'${input.replace(/'/g, "'\\''")}'`;
}
