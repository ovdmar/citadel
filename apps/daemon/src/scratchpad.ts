import fs from "node:fs";
import path from "node:path";
import { type CitadelConfig, SCRATCHPAD_DEFAULT_FILENAME, defaultNotesPath, effectiveNotesPath } from "@citadel/config";
import type {
  ScratchpadBlock,
  ScratchpadBlockPosition,
  ScratchpadBlockSummary,
  ScratchpadSnapshot,
} from "@citadel/contracts";
import {
  freshBlockId,
  listBlockSummaries,
  migrateIfNeeded,
  parseBlocks,
  serializeBlocks,
} from "./scratchpad-blocks.js";
import {
  type HistoryOptions,
  type HistorySource,
  backfillIfEmpty,
  readHistory,
  recordHistoryWrite,
} from "./scratchpad-history.js";

// Re-export for legacy daemon code paths that still touch the default basename.
export { SCRATCHPAD_DEFAULT_FILENAME };
export const SCRATCHPAD_FILENAME = SCRATCHPAD_DEFAULT_FILENAME;
export const SCRATCHPAD_MAX_BYTES = 1_000_000;
export const DEFAULT_STUB = "# Scratchpad\n\n";

export type { ScratchpadSnapshot };

export class ScratchpadTooLargeError extends Error {
  constructor(readonly limit: number = SCRATCHPAD_MAX_BYTES) {
    super("scratchpad_too_large");
    this.name = "ScratchpadTooLargeError";
  }
}

// Where the notes file lives on disk. Returns notesPath unchanged — kept as a
// thin function so tests and call sites have a single named entry point even
// though the field is now resolved from `effectiveNotesPath(config)` upstream.
export function scratchpadPath(notesPath: string) {
  return notesPath;
}

// Bundle of the two filesystem locations every scratchpad operation needs.
//  - `notesPath` is the user-facing markdown file (today: `<dataDir>/scratchpad.md`,
//    overridable via `config.scratchpad.path`).
//  - `dataDir` remains the home for daemon-internal state — the JSONL history file
//    stays under it even when the notes file is configured to live elsewhere.
export type ScratchpadPaths = { notesPath: string; dataDir: string };

export function readScratchpad(paths: ScratchpadPaths): ScratchpadSnapshot {
  const { notesPath, dataDir } = paths;
  if (!fs.existsSync(notesPath)) {
    ensureNotesParent(notesPath);
    fs.writeFileSync(notesPath, DEFAULT_STUB, "utf8");
  }
  // Capture pre-read mtime so a concurrent migrator's write is detectable; on
  // coarse-mtime filesystems this guard may compare equal across rapid concurrent
  // writes, but the 60s same-source coalesce window subsumes the duplicate so
  // AC1 (one migrate-to-blocks history entry) still holds.
  const mtimeBefore = fs.statSync(notesPath).mtimeMs;
  const raw = fs.readFileSync(notesPath, "utf8");
  const { migrated, content } = migrateIfNeeded(raw);
  if (migrated) {
    // The notes file is at a user-supplied path → warn so a pre-existing
    // hand-curated markdown file getting fenced isn't a silent surprise. Users
    // on the default `<dataDir>/scratchpad.md` are not warned because that path
    // is owned by Citadel.
    if (notesPath !== defaultNotesPath(dataDir)) {
      console.warn(
        `[scratchpad] auto-migrating ${notesPath} to fenced-block format (source: migrate-to-blocks; pre-migration content saved to history under <dataDir>)`,
      );
    }
    const mtimeNow = fs.statSync(notesPath).mtimeMs;
    if (mtimeNow === mtimeBefore) {
      writeScratchpad(paths, content, "migrate-to-blocks");
    }
  }
  const finalContent = fs.readFileSync(notesPath, "utf8");
  const stat = fs.statSync(notesPath);
  return { content: finalContent, updatedAt: stat.mtime.toISOString() };
}

export function writeScratchpad(
  paths: ScratchpadPaths,
  content: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): ScratchpadSnapshot {
  assertSize(content);
  const { notesPath, dataDir } = paths;
  ensureNotesParent(notesPath);
  fs.writeFileSync(notesPath, content, "utf8");
  const stat = fs.statSync(notesPath);
  recordHistoryWrite(dataDir, { content, source }, historyOptions);
  return { content, updatedAt: stat.mtime.toISOString() };
}

export function appendScratchpad(
  paths: ScratchpadPaths,
  chunk: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): ScratchpadSnapshot {
  const result = addBlock(paths, chunk, "end", source, historyOptions);
  if ("error" in result) {
    if (result.error === "scratchpad_too_large") throw new ScratchpadTooLargeError();
    throw new Error(result.error);
  }
  return result.snapshot;
}

export function listBlocks(paths: ScratchpadPaths): { blocks: ScratchpadBlockSummary[] } {
  const snapshot = readScratchpad(paths);
  const blocks = parseBlocks(snapshot.content).blocks;
  const fallbackMtime = snapshot.updatedAt;
  const history = readHistory(paths.dataDir);
  return { blocks: listBlockSummaries(blocks, history, fallbackMtime) };
}

type BlockMutationResult = { block: ScratchpadBlock; snapshot: ScratchpadSnapshot } | { error: string };

type BlockDeleteResult = { snapshot: ScratchpadSnapshot } | { error: string };

export function addBlock(
  paths: ScratchpadPaths,
  text: string,
  position: ScratchpadBlockPosition,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockMutationResult {
  if (text.trim().length === 0) return { error: "text_required" };
  const snapshot = readScratchpad(paths);
  const { blocks } = parseBlocks(snapshot.content);
  const newBlock: ScratchpadBlock = { id: freshBlockId(new Set(blocks.map((b) => b.id))), text };
  if (position === "end") {
    blocks.push(newBlock);
  } else {
    const idx = blocks.findIndex((b) => b.id === position.afterId);
    if (idx === -1) return { error: "block_not_found" };
    blocks.splice(idx + 1, 0, newBlock);
  }
  const result = persistBlocks(paths, blocks, source, historyOptions);
  if ("error" in result) return result;
  return { block: newBlock, snapshot: result.snapshot };
}

export function updateBlock(
  paths: ScratchpadPaths,
  id: string,
  text: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockMutationResult | BlockDeleteResult {
  const snapshot = readScratchpad(paths);
  const { blocks } = parseBlocks(snapshot.content);
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx === -1) return { error: "block_not_found" };
  if (text.trim().length === 0) {
    blocks.splice(idx, 1);
    return persistBlocks(paths, blocks, source, historyOptions);
  }
  const updated: ScratchpadBlock = { id, text };
  blocks[idx] = updated;
  const result = persistBlocks(paths, blocks, source, historyOptions);
  if ("error" in result) return result;
  return { block: updated, snapshot: result.snapshot };
}

export function deleteBlock(
  paths: ScratchpadPaths,
  id: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockDeleteResult {
  const snapshot = readScratchpad(paths);
  const { blocks } = parseBlocks(snapshot.content);
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx === -1) return { error: "block_not_found" };
  blocks.splice(idx, 1);
  return persistBlocks(paths, blocks, source, historyOptions);
}

// Serialize the block list and write it through writeScratchpad, mapping the
// size-cap error to a structured result. Callers that need to expose a block
// in the response wrap this themselves to keep the return shape narrow.
function persistBlocks(
  paths: ScratchpadPaths,
  blocks: ScratchpadBlock[],
  source: HistorySource,
  historyOptions: HistoryOptions | undefined,
): BlockDeleteResult {
  const content = serializeBlocks(blocks);
  try {
    const snapshot = writeScratchpad(paths, content, source, historyOptions);
    return { snapshot };
  } catch (error) {
    if (error instanceof ScratchpadTooLargeError) return { error: "scratchpad_too_large" };
    throw error;
  }
}

export function parsePosition(raw: unknown): "end" | { afterId: string } | "invalid" {
  if (raw === undefined || raw === "end") return "end";
  if (typeof raw === "object" && raw !== null && "afterId" in raw) {
    const afterId = (raw as { afterId: unknown }).afterId;
    if (typeof afterId === "string" && afterId.length > 0) return { afterId };
  }
  return "invalid";
}

// Convenience for the daemon's startup wiring — replaces the inline
// `scratchpadPath`/`backfillIfEmpty` dance in `app.ts` so the file-size budget
// there has breathing room and the path-resolution logic stays in one place.
export function backfillScratchpadOnStartup(config: Pick<CitadelConfig, "dataDir" | "scratchpad">) {
  try {
    const notesPath = effectiveNotesPath(config);
    if (!fs.existsSync(notesPath)) return;
    const content = fs.readFileSync(notesPath, "utf8");
    if (content.length === 0) return;
    const stat = fs.statSync(notesPath);
    backfillIfEmpty(config.dataDir, { content, updatedAt: stat.mtime.toISOString() });
  } catch (error) {
    console.error(`[scratchpad-history] backfill skipped: ${error instanceof Error ? error.message : error}`);
  }
}

// Make the immediate parent of `notesPath` exist (recursive). Kept separate from
// `ensureDataDir` so the notes file at a user-configured location does NOT
// implicitly create the daemon's dataDir as a side effect.
function ensureNotesParent(notesPath: string) {
  fs.mkdirSync(path.dirname(notesPath), { recursive: true });
}

function assertSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > SCRATCHPAD_MAX_BYTES) {
    throw new ScratchpadTooLargeError();
  }
}
