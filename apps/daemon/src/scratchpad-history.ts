import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ScratchpadHistoryEntry as HistoryEntry,
  ScratchpadHistorySource as HistorySource,
  ScratchpadHistorySummary as HistorySummary,
} from "@citadel/contracts";

export type { HistoryEntry, HistorySource, HistorySummary };

const HISTORY_FILENAME = "scratchpad-history.jsonl";
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_BYTES = 1_073_741_824;
const COALESCE_WINDOW_MS = 60_000;

export type HistoryOptions = {
  maxEntries?: number;
  maxBytes?: number;
  now?: () => Date;
};

export function historyPath(dataDir: string) {
  return path.join(dataDir, HISTORY_FILENAME);
}

export function readHistory(dataDir: string): HistoryEntry[] {
  const filePath = historyPath(dataDir);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw) return [];
  const entries: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // Skip malformed lines; an entry written mid-crash shouldn't poison the rest.
    }
  }
  return entries;
}

export function findHistoryEntry(dataDir: string, id: string): HistoryEntry | null {
  return readHistory(dataDir).find((entry) => entry.id === id) ?? null;
}

export function listHistorySummaries(dataDir: string): HistorySummary[] {
  return readHistory(dataDir)
    .map(toSummary)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export function recordHistoryWrite(
  dataDir: string,
  input: { content: string; source: HistorySource },
  options: HistoryOptions = {},
): HistoryEntry | null {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = (options.now?.() ?? new Date()).toISOString();
  ensureDir(dataDir);
  const entries = readHistory(dataDir);
  const last = entries[entries.length - 1];
  if (last && last.content === input.content) return null;
  if (last && last.source === input.source && Date.parse(now) - Date.parse(last.firstWriteTs) < COALESCE_WINDOW_MS) {
    last.ts = now;
    last.content = input.content;
    last.contentSha256 = sha256(input.content);
    last.byteLength = Buffer.byteLength(input.content, "utf8");
    last.coalescedCount += 1;
    writeAll(dataDir, prune(entries, maxEntries, maxBytes));
    return last;
  }
  const entry = createEntry({ ts: now, firstWriteTs: now, source: input.source, content: input.content });
  entries.push(entry);
  writeAll(dataDir, prune(entries, maxEntries, maxBytes));
  return entry;
}

export function backfillIfEmpty(
  dataDir: string,
  current: { content: string; updatedAt: string } | null,
  options: HistoryOptions = {},
): HistoryEntry | null {
  if (!current || current.content.length === 0) return null;
  const filePath = historyPath(dataDir);
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return null;
  const ts = current.updatedAt ?? (options.now?.() ?? new Date()).toISOString();
  const entry = createEntry({ ts, firstWriteTs: ts, source: "backfill", content: current.content });
  ensureDir(dataDir);
  writeAll(dataDir, [entry]);
  return entry;
}

function createEntry(input: {
  ts: string;
  firstWriteTs: string;
  source: HistorySource;
  content: string;
}): HistoryEntry {
  return {
    id: `scratch_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
    ts: input.ts,
    firstWriteTs: input.firstWriteTs,
    source: input.source,
    contentSha256: sha256(input.content),
    byteLength: Buffer.byteLength(input.content, "utf8"),
    coalescedCount: 1,
    content: input.content,
  };
}

function toSummary(entry: HistoryEntry): HistorySummary {
  const { content, ...rest } = entry;
  return { ...rest, preview: content.slice(0, 200) };
}

function prune(entries: HistoryEntry[], maxEntries: number, maxBytes: number): HistoryEntry[] {
  let pruned = entries;
  if (pruned.length > maxEntries) pruned = pruned.slice(pruned.length - maxEntries);
  let total = pruned.reduce((sum, entry) => sum + serialized(entry).length + 1, 0);
  while (pruned.length > 1 && total > maxBytes) {
    const removed = pruned.shift();
    if (!removed) break;
    total -= serialized(removed).length + 1;
  }
  return pruned;
}

function writeAll(dataDir: string, entries: HistoryEntry[]) {
  const filePath = historyPath(dataDir);
  const tmpPath = `${filePath}.tmp`;
  const body = entries.map(serialized).join("\n") + (entries.length > 0 ? "\n" : "");
  fs.writeFileSync(tmpPath, body, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function serialized(entry: HistoryEntry) {
  return JSON.stringify(entry);
}

function sha256(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function ensureDir(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
}
