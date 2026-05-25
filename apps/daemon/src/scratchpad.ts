import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ScratchpadBlock,
  ScratchpadBlockPosition,
  ScratchpadBlockSummary,
  ScratchpadSnapshot,
} from "@citadel/contracts";
import { listBlockSummaries, migrateIfNeeded, parseBlocks, serializeBlocks } from "./scratchpad-blocks.js";
import { type HistoryOptions, type HistorySource, readHistory, recordHistoryWrite } from "./scratchpad-history.js";

export const SCRATCHPAD_FILENAME = "scratchpad.md";
export const SCRATCHPAD_MAX_BYTES = 1_000_000;
export const DEFAULT_STUB = "# Scratchpad\n\n";

export type { ScratchpadSnapshot };

export class ScratchpadTooLargeError extends Error {
  constructor(readonly limit: number = SCRATCHPAD_MAX_BYTES) {
    super("scratchpad_too_large");
    this.name = "ScratchpadTooLargeError";
  }
}

export function scratchpadPath(dataDir: string) {
  return path.join(dataDir, SCRATCHPAD_FILENAME);
}

export function readScratchpad(dataDir: string): ScratchpadSnapshot {
  const filePath = scratchpadPath(dataDir);
  if (!fs.existsSync(filePath)) {
    ensureDataDir(dataDir);
    fs.writeFileSync(filePath, DEFAULT_STUB, "utf8");
  }
  // Capture pre-read mtime so a concurrent migrator's write is detectable; on
  // coarse-mtime filesystems this guard may compare equal across rapid concurrent
  // writes, but the 60s same-source coalesce window subsumes the duplicate so
  // AC1 (one migrate-to-blocks history entry) still holds.
  const mtimeBefore = fs.statSync(filePath).mtimeMs;
  const raw = fs.readFileSync(filePath, "utf8");
  const { migrated, content } = migrateIfNeeded(raw);
  if (migrated) {
    const mtimeNow = fs.statSync(filePath).mtimeMs;
    if (mtimeNow === mtimeBefore) {
      writeScratchpad(dataDir, content, "migrate-to-blocks");
    }
  }
  const finalContent = fs.readFileSync(filePath, "utf8");
  const stat = fs.statSync(filePath);
  return { content: finalContent, updatedAt: stat.mtime.toISOString() };
}

export function writeScratchpad(
  dataDir: string,
  content: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): ScratchpadSnapshot {
  assertSize(content);
  ensureDataDir(dataDir);
  const filePath = scratchpadPath(dataDir);
  fs.writeFileSync(filePath, content, "utf8");
  const stat = fs.statSync(filePath);
  recordHistoryWrite(dataDir, { content, source }, historyOptions);
  return { content, updatedAt: stat.mtime.toISOString() };
}

export function appendScratchpad(
  dataDir: string,
  chunk: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): ScratchpadSnapshot {
  const result = addBlock(dataDir, chunk, "end", source, historyOptions);
  if ("error" in result) {
    if (result.error === "scratchpad_too_large") throw new ScratchpadTooLargeError();
    throw new Error(result.error);
  }
  return result.snapshot;
}

export function listBlocks(dataDir: string): { blocks: ScratchpadBlockSummary[] } {
  const snapshot = readScratchpad(dataDir);
  const blocks = parseBlocks(snapshot.content).blocks;
  const fallbackMtime = snapshot.updatedAt;
  const history = readHistory(dataDir);
  return { blocks: listBlockSummaries(blocks, history, fallbackMtime) };
}

export type BlockMutationResult = { block: ScratchpadBlock; snapshot: ScratchpadSnapshot } | { error: string };

export type BlockDeleteResult = { snapshot: ScratchpadSnapshot } | { error: string };

export function addBlock(
  dataDir: string,
  text: string,
  position: ScratchpadBlockPosition,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockMutationResult {
  if (text.trim().length === 0) return { error: "text_required" };
  const snapshot = readScratchpad(dataDir);
  const { blocks } = parseBlocks(snapshot.content);
  const newBlock: ScratchpadBlock = { id: freshId(blocks), text };
  if (position === "end") {
    blocks.push(newBlock);
  } else {
    const idx = blocks.findIndex((b) => b.id === position.afterId);
    if (idx === -1) return { error: "block_not_found" };
    blocks.splice(idx + 1, 0, newBlock);
  }
  return writeBlocks(dataDir, blocks, source, historyOptions, newBlock);
}

export function updateBlock(
  dataDir: string,
  id: string,
  text: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockMutationResult | BlockDeleteResult {
  const snapshot = readScratchpad(dataDir);
  const { blocks } = parseBlocks(snapshot.content);
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx === -1) return { error: "block_not_found" };
  if (text.trim().length === 0) {
    blocks.splice(idx, 1);
    const result = writeBlocks(dataDir, blocks, source, historyOptions);
    if ("error" in result) return result;
    return { snapshot: result.snapshot };
  }
  const updated: ScratchpadBlock = { id, text };
  blocks[idx] = updated;
  return writeBlocks(dataDir, blocks, source, historyOptions, updated);
}

export function deleteBlock(
  dataDir: string,
  id: string,
  source: HistorySource,
  historyOptions?: HistoryOptions,
): BlockDeleteResult {
  const snapshot = readScratchpad(dataDir);
  const { blocks } = parseBlocks(snapshot.content);
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx === -1) return { error: "block_not_found" };
  blocks.splice(idx, 1);
  const result = writeBlocks(dataDir, blocks, source, historyOptions);
  if ("error" in result) return result;
  return { snapshot: result.snapshot };
}

function writeBlocks(
  dataDir: string,
  blocks: ScratchpadBlock[],
  source: HistorySource,
  historyOptions: HistoryOptions | undefined,
  trackBlock?: ScratchpadBlock,
): BlockMutationResult {
  const content = serializeBlocks(blocks);
  try {
    const snapshot = writeScratchpad(dataDir, content, source, historyOptions);
    return { block: trackBlock ?? { id: "", text: "" }, snapshot };
  } catch (error) {
    if (error instanceof ScratchpadTooLargeError) return { error: "scratchpad_too_large" };
    throw error;
  }
}

function freshId(existing: ScratchpadBlock[]): string {
  const seen = new Set(existing.map((b) => b.id));
  for (let i = 0; i < 8; i += 1) {
    const id = crypto.randomUUID();
    if (!seen.has(id)) return id;
  }
  throw new Error("Failed to generate a unique block id");
}

function ensureDataDir(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function assertSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > SCRATCHPAD_MAX_BYTES) {
    throw new ScratchpadTooLargeError();
  }
}
