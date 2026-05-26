import type { RuntimeModelDescriptor } from "@citadel/contracts";
import { sleep, spawnEphemeralTmux, stripAnsi } from "../usage/tmux-pty.js";
import type { RuntimeModelListerResult } from "./index.js";

const READY_MARKER = "Claude Code v";
// Heuristic detection of the /models picker. Claude Code renders the picker
// as a menu where each row carries the model identifier; the exact format is
// version-dependent. Probe is best-effort — failure surfaces as probeError.
const MODEL_LINE_RE = /\b(claude-(?:opus|sonnet|haiku)-[\d-]+[a-z0-9-]*)\b/gi;
const PROBE_TIMEOUT_MS = 5_000;

export const CLAUDE_CODE_MODELS_FALLBACK: RuntimeModelDescriptor[] = [
  { id: "claude-opus-4-7", displayName: "Opus 4.7", isDefault: false },
  { id: "claude-sonnet-4-6", displayName: "Sonnet 4.6", isDefault: true },
  { id: "claude-haiku-4-5", displayName: "Haiku 4.5", isDefault: false },
];

// Parse model identifiers from a captured /models pane. Picks up any
// `claude-(opus|sonnet|haiku)-N-M[-suffix]` token, dedupes, preserves order.
export function parseClaudeCodeModelsList(rawPaneText: string): string[] {
  const cleaned = stripAnsi(rawPaneText);
  const seen = new Set<string>();
  const out: string[] = [];
  let match: RegExpExecArray | null;
  MODEL_LINE_RE.lastIndex = 0;
  match = MODEL_LINE_RE.exec(cleaned);
  while (match !== null) {
    const id = match[1]?.toLowerCase();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    match = MODEL_LINE_RE.exec(cleaned);
  }
  return out;
}

// Drive `claude` via tmux to render the /models picker, capture the pane,
// extract identifiers. Wrapped in a hard 5s timeout; failure returns the
// fallback list with a probeError so the caller can still render the UI.
//
// Cleanup invariant: tmux session MUST be killed in finally even on parser
// throw or timeout, per the ttyd cleanup-storm lessons documented in the
// project memory.
export async function fetchClaudeCodeModels(input: {
  command: string;
  args?: string[];
}): Promise<RuntimeModelListerResult> {
  try {
    const probe = withTimeout(probeClaudeCodeModels(input), PROBE_TIMEOUT_MS);
    return await probe;
  } catch (err) {
    return {
      models: CLAUDE_CODE_MODELS_FALLBACK,
      probeError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeClaudeCodeModels(input: {
  command: string;
  args?: string[];
}): Promise<RuntimeModelListerResult> {
  const tmux = await spawnEphemeralTmux({
    command: input.command,
    args: input.args ?? [],
    width: 200,
    height: 60,
    scrollback: 300,
    sessionPrefix: "citadel_models_claude",
  });
  try {
    await tmux.waitFor((text) => text.includes(READY_MARKER), { timeoutMs: 4_000 });
    tmux.sendText("/models");
    tmux.sendKey("Enter");
    await sleep(400);
    const ids = parseClaudeCodeModelsList(tmux.capture());
    if (ids.length === 0) {
      return { models: CLAUDE_CODE_MODELS_FALLBACK, probeError: "no_models_parsed" };
    }
    return { models: ids.map((id) => ({ id })) };
  } finally {
    tmux.kill();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe_timeout_${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
