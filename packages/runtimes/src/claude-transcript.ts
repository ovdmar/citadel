import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeUserPrompt = {
  uuid: string;
  text: string;
  timestamp: string;
  sessionId: string;
};

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
 * Filters out tool_result entries (whose content is an array) — those are
 * synthetic "user" turns that carry tool output, not a user message.
 */
export function parseClaudeTranscript(filePath: string): ClaudeUserPrompt[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const prompts: ClaudeUserPrompt[] = [];
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
    const uuid = typeof entry.uuid === "string" ? entry.uuid : "";
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : "";
    if (!uuid || !timestamp) continue;
    prompts.push({ uuid, text, timestamp, sessionId });
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
 * `sessionStartedAt` (ISO) inside `workspacePath`. We pick the .jsonl whose
 * earliest user prompt timestamp falls within the session window (or whose
 * mtime is closest to the start when no prompts have been written yet).
 *
 * Returns null if no candidate is found or the directory does not exist.
 */
export function findClaudeTranscriptForSession(input: {
  workspacePath: string;
  sessionStartedAt: string;
  home?: string;
}): string | null {
  const dir = claudeProjectsDir(input.workspacePath, input.home ?? os.homedir());
  if (!fs.existsSync(dir)) return null;
  const startMs = Date.parse(input.sessionStartedAt);
  if (!Number.isFinite(startMs)) return null;
  let bestPath: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const candidate = path.join(dir, name);
    let firstMs = Number.POSITIVE_INFINITY;
    const prompts = parseClaudeTranscript(candidate);
    if (prompts.length > 0) {
      const parsed = Date.parse(prompts[0]?.timestamp ?? "");
      if (Number.isFinite(parsed)) firstMs = parsed;
    } else {
      try {
        firstMs = fs.statSync(candidate).mtimeMs;
      } catch {
        continue;
      }
    }
    // Prefer transcripts whose first event is at-or-after the session start,
    // within a small slack window for clock skew (60s).
    const delta = firstMs - startMs;
    if (delta < -60_000) continue;
    const score = Math.abs(delta);
    if (score < bestScore) {
      bestScore = score;
      bestPath = candidate;
    }
  }
  return bestPath;
}
