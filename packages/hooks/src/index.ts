import { spawn } from "node:child_process";
import { type HookDiagnostic, type HookOutput, HookOutputSchema } from "@citadel/contracts";

export {
  DEPLOY_HOOK_RELATIVE_PATH,
  buildDeployedApps,
  deployHookEnv,
  parseDeployListOutput,
  probeAppStatus,
  resolveDeployHook,
  runDeployHookList,
  runDeployHookRedeploy,
} from "./deploy.js";
export type {
  DeployHookEnv,
  RedeployStreamHandler,
  ResolveDeployHookInput,
  RunDeployListResult,
  RunDeployRedeployResult,
} from "./deploy.js";
export { TEARDOWN_HOOK_RELATIVE_PATH, resolveTeardownHook, runTeardownHook } from "./teardown.js";
export type {
  ResolveTeardownHookInput,
  RunTeardownHookResult,
  TeardownHookEnv,
  TeardownStreamHandler,
} from "./teardown.js";
export {
  FIX_CONFLICTS_DEFAULT_PROMPT,
  FIX_CONFLICTS_HOOK_RELATIVE_PATH,
  resolveFixConflictsPrompt,
} from "./fix-conflicts.js";
export type { FixConflictsHookEnv, ResolveFixConflictsPromptResult } from "./fix-conflicts.js";
export { CITADEL_NON_FF_POLICY } from "./non-ff-policy.js";

export { describeError, discoverFileHooks } from "./discovery.js";
export type { FileHook, FileHookDiagnostic } from "./discovery.js";
export { parseFrontmatter } from "./frontmatter.js";
export { renderTemplate } from "./template.js";

export type CommandHook = {
  id: string;
  event: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  blocking: boolean;
};

export type CommandHookResult = {
  stdout: string;
  stderr: string;
  durationMs: number;
  exitStatus: number | null;
};

export async function runCommandHook(hook: CommandHook, payload: unknown) {
  const result = await runCommandHookForDiagnostics(hook, payload);
  if (result.exitStatus === 0) return result;
  throw new Error(`Hook exited with ${result.exitStatus}: ${result.stderr || result.stdout}`);
}

export async function runCommandHookForDiagnostics(hook: CommandHook, payload: unknown): Promise<CommandHookResult> {
  const input = JSON.stringify(payload);
  return new Promise<CommandHookResult>((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(hook.command, hook.args, { cwd: hook.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Hook timed out after ${hook.timeoutMs}ms`));
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-65536);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-65536);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, durationMs: Date.now() - startedAt, exitStatus: code });
    });
    // Swallow EPIPE: a short-lived script (e.g. `exit 0`) may close stdin
    // before we finish writing the JSON payload. The exit code is what
    // matters; bubbling EPIPE would surface a spurious failure.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

export function parseHookOutput(stdout: string): HookOutput | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return HookOutputSchema.parse(JSON.parse(trimmed));
}

export function hookDiagnostic(input: {
  hook: CommandHook;
  enabled: boolean;
  lastRunAt?: string | null;
  result?: CommandHookResult | null;
  error?: unknown;
}): HookDiagnostic {
  const output = input.result?.stdout.trim() || input.result?.stderr.trim() || null;
  let structuredPayload: HookOutput | null = null;
  const validationErrors: string[] = [];
  if (input.result?.stdout.trim()) {
    try {
      structuredPayload = parseHookOutput(input.result.stdout);
    } catch (error) {
      validationErrors.push(error instanceof Error ? error.message : "Invalid hook output");
    }
  }
  if (input.error) validationErrors.push(input.error instanceof Error ? input.error.message : "Hook failed");
  if (input.result && input.result.exitStatus !== 0) {
    validationErrors.push(`Hook exited with ${input.result.exitStatus}`);
  }
  return {
    hookId: input.hook.id,
    event: input.hook.event,
    command: input.hook.command,
    args: input.hook.args,
    cwd: input.hook.cwd,
    blocking: input.hook.blocking,
    enabled: input.enabled,
    validationStatus: validationErrors.length ? "invalid" : "valid",
    validationErrors,
    lastRunAt: input.lastRunAt ?? null,
    durationMs: input.result?.durationMs ?? null,
    exitStatus: input.result?.exitStatus ?? null,
    outputSummary: output ? output.slice(0, 4000) : null,
    structuredPayload,
  };
}
