import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GetUserPromptsInput, RuntimeTranscriptAdapter, RuntimeUserPrompt } from "./types.js";

/**
 * Codex stores one rollout `.jsonl` per session at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl`. Each file
 * opens with a `session_meta` line carrying the cwd; subsequent
 * `response_item` lines with `role: "user"` are user inputs.
 *
 * The first user item is a synthetic `<environment_context>` block; we skip
 * lines whose only text is wrapped in that tag.
 */

export function codexSessionsRoot(home: string = os.homedir()): string {
  return path.join(home, ".codex", "sessions");
}

type CodexMeta = { id?: string; cwd?: string; timestamp?: string };

type ParseResult = { meta: CodexMeta; prompts: RuntimeUserPrompt[] };

export function parseCodexRollout(filePath: string): ParseResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { meta: {}, prompts: [] };
  }
  const prompts: RuntimeUserPrompt[] = [];
  let meta: CodexMeta = {};
  let userIndex = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "session_meta") {
      const payload = entry.payload as CodexMeta | undefined;
      if (payload) {
        const next: CodexMeta = {};
        if (typeof payload.id === "string") next.id = payload.id;
        if (typeof payload.cwd === "string") next.cwd = payload.cwd;
        if (typeof payload.timestamp === "string") next.timestamp = payload.timestamp;
        meta = next;
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    const payload = entry.payload as { type?: string; role?: string; content?: unknown; id?: string } | undefined;
    if (!payload || payload.type !== "message" || payload.role !== "user") continue;
    const text = extractInputText(payload.content);
    if (!text) continue;
    if (isEnvironmentContext(text)) continue;
    const sentAt = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (!sentAt) continue;
    // Codex does not emit a stable per-message id; synthesize one from the
    // session id + ordinal so dedup across re-parses is still possible.
    const externalId = `${meta.id ?? path.basename(filePath, ".jsonl")}:${userIndex}`;
    prompts.push({ externalId, text, sentAt });
    userIndex += 1;
  }
  return { meta, prompts };
}

function extractInputText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "input_text") continue;
    if (typeof record.text === "string") parts.push(record.text);
  }
  const text = parts.join("\n");
  return text.length ? text : null;
}

function isEnvironmentContext(text: string) {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") && trimmed.endsWith("</environment_context>");
}

/**
 * Walk the date-partitioned `~/.codex/sessions` tree and return rollout file
 * paths whose mtime is within the session window. Mirrors the claude-code
 * pre-filter so heavy users don't pay full-parse cost on every history read.
 */
function listCandidateRollouts(root: string, startMs: number): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(next);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(next).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < startMs - 60_000) continue;
      out.push(next);
    }
  };
  walk(root);
  return out;
}

/**
 * Poll `~/.codex/sessions` for a rollout file freshly written by a just-spawned
 * codex session, and return its UUID (`session_meta.payload.id`). Used by
 * Citadel right after `ensureTmuxSession` to register the runtime's auto-
 * generated session id so subsequent restarts can `codex resume <uuid>`.
 *
 * Codex auto-generates the UUID at spawn — no `--session-id` flag exists
 * (issue openai/codex#3492, closed not-planned), and the interactive TUI
 * doesn't expose it on stdout. Filesystem polling is the only reliable
 * channel for the TUI flow Citadel uses.
 *
 * `timeoutMs` is conservative (5 s default): on a cold codex startup the
 * rollout file appears within ~1 s; on a busy host it can take longer.
 * Best-effort — returns null on timeout so the caller can decide whether
 * to retry, log, or just live without registration for this session.
 */
export async function discoverCodexSessionId(opts: {
  workspacePath: string;
  spawnTimeMs: number;
  timeoutMs?: number;
  pollMs?: number;
  home?: string;
}): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  const sessionStartedAt = new Date(opts.spawnTimeMs).toISOString();
  while (Date.now() < deadline) {
    const file = findCodexRolloutForSession({
      workspacePath: opts.workspacePath,
      sessionStartedAt,
      ...(opts.home ? { home: opts.home } : {}),
    });
    if (file) {
      const { meta } = parseCodexRollout(file);
      if (meta.id) return meta.id;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

export function findCodexRolloutForSession(input: GetUserPromptsInput): string | null {
  const root = codexSessionsRoot(input.home ?? os.homedir());
  const startMs = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startMs)) return null;
  let bestPath: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of listCandidateRollouts(root, startMs)) {
    const { meta } = parseCodexRollout(candidate);
    if (!meta.cwd || meta.cwd !== input.workspacePath) continue;
    const metaMs = meta.timestamp ? Date.parse(meta.timestamp) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(metaMs)) continue;
    const delta = metaMs - startMs;
    if (delta < -60_000) continue;
    const score = Math.abs(delta);
    if (score < bestScore) {
      bestScore = score;
      bestPath = candidate;
    }
  }
  return bestPath;
}

export const codexAdapter: RuntimeTranscriptAdapter = {
  runtimeId: "codex",
  getUserPrompts(input) {
    const file = findCodexRolloutForSession(input);
    return file ? parseCodexRollout(file).prompts : [];
  },
};
