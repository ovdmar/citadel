import fs from "node:fs";
import path from "node:path";
import type { ScratchpadSnapshot } from "@citadel/contracts";
import { type HistoryOptions, type HistorySource, recordHistoryWrite } from "./scratchpad-history.js";

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
  const content = fs.readFileSync(filePath, "utf8");
  const stat = fs.statSync(filePath);
  return { content, updatedAt: stat.mtime.toISOString() };
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
  ensureDataDir(dataDir);
  const filePath = scratchpadPath(dataDir);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const tail = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  return writeScratchpad(dataDir, `${existing}${separator}${tail}`, source, historyOptions);
}

function ensureDataDir(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function assertSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > SCRATCHPAD_MAX_BYTES) {
    throw new ScratchpadTooLargeError();
  }
}
