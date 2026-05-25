import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GetUserPromptsInput, RuntimeTranscriptAdapter, RuntimeUserPrompt } from "./types.js";

/**
 * Map a working directory to Claude Code's project transcript folder.
 * Claude Code replaces every non-alphanumeric character in the absolute path
 * with `-`, e.g. `/home/jonsnow/Workspace/citadel` → `-home-jonsnow-Workspace-citadel`.
 */
export function claudeProjectsDir(workspacePath: string, home: string = os.homedir()): string {
  const dasherized = workspacePath.replace(/[^A-Za-z0-9]/g, "-");
  return path.join(home, ".claude", "projects", dasherized);
}

/**
 * Parse a single Claude Code .jsonl transcript and return user-authored prompts.
 * Filters out tool_result entries (whose content is an array of tool_result
 * blocks) — those are synthetic "user" turns that carry tool output, not a
 * user message.
 */
export function parseClaudeTranscript(filePath: string): RuntimeUserPrompt[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const prompts: RuntimeUserPrompt[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type !== "user") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message || message.role !== "user") continue;
    const text = extractUserText(message.content);
    if (!text) continue;
    const externalId = typeof entry.uuid === "string" ? entry.uuid : "";
    const sentAt = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (!externalId || !sentAt) continue;
    prompts.push({ externalId, text, sentAt });
  }
  return prompts;
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // Tool results live in arrays. Real user follow-ups arrive as text-typed
  // blocks. Treat the entry as a user prompt only if every block is text.
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") return null;
    const record = block as Record<string, unknown>;
    if (record.type !== "text") return null;
    if (typeof record.text !== "string") return null;
    parts.push(record.text);
  }
  const text = parts.join("\n");
  return text.length ? text : null;
}

/**
 * Find the most likely Claude Code transcript for a session that started at
 * `sessionStartedAt` inside `workspacePath`. Pre-filters by mtime so archived
 * transcripts that pre-date the session are skipped without parsing.
 */
export function findClaudeTranscriptForSession(input: GetUserPromptsInput): string | null {
  const dir = claudeProjectsDir(input.workspacePath, input.home ?? os.homedir());
  if (!fs.existsSync(dir)) return null;
  const startMs = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startMs)) return null;
  type Candidate = { path: string; mtimeMs: number };
  const candidates: Candidate[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const candidate = path.join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs < startMs - 60_000) continue;
    candidates.push({ path: candidate, mtimeMs });
  }
  let bestPath: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    let firstMs = Number.POSITIVE_INFINITY;
    const prompts = parseClaudeTranscript(candidate.path);
    if (prompts.length > 0) {
      const parsed = Date.parse(prompts[0]?.sentAt ?? "");
      if (Number.isFinite(parsed)) firstMs = parsed;
    } else {
      firstMs = candidate.mtimeMs;
    }
    const delta = firstMs - startMs;
    if (delta < -60_000) continue;
    const score = Math.abs(delta);
    if (score < bestScore) {
      bestScore = score;
      bestPath = candidate.path;
    }
  }
  return bestPath;
}

/**
 * Render a Claude Code .jsonl transcript as a flat plaintext conversation —
 * `[HH:MM:SS] user|assistant` headers followed by the text body. Tool calls
 * and tool results are skipped: the goal is "what did the human ask, what
 * did the model say", not a full mechanical replay. Returns null if the
 * file is missing/unparseable; callers (e.g. the /log fallback) use that
 * signal to fall through to the next source.
 */
export function renderClaudeTranscriptAsText(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const kind = entry.type;
    if (kind !== "user" && kind !== "assistant") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (!message) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractMessageText(message.content);
    if (!text) continue;
    const stamp = typeof entry.timestamp === "string" ? formatTime(entry.timestamp) : "";
    const header = stamp ? `[${stamp}] ${role}` : role;
    out.push(`${header}\n${text}`);
  }
  if (!out.length) return null;
  return out.join("\n\n");
}

// Like extractUserText but tolerates assistant turns (which may interleave
// text blocks with tool_use blocks). Returns the concatenation of every
// text block in order; tool calls are summarised as "[tool: name]" so the
// reader can see WHERE the model paused without being buried in arguments.
function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    } else if (record.type === "tool_use" && typeof record.name === "string") {
      parts.push(`[tool: ${record.name}]`);
    }
    // tool_result blocks (synthetic "user" turns) are skipped — they're
    // covered by the surrounding assistant's tool_use marker.
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export const claudeCodeAdapter: RuntimeTranscriptAdapter = {
  runtimeId: "claude-code",
  getUserPrompts(input) {
    const transcript = findClaudeTranscriptForSession(input);
    return transcript ? parseClaudeTranscript(transcript) : [];
  },
};
