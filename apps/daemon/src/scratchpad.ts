import fs from "node:fs";
import path from "node:path";

export const SCRATCHPAD_FILENAME = "scratchpad.md";
export const SCRATCHPAD_MAX_BYTES = 1_000_000;
const DEFAULT_STUB = "# Scratchpad\n\n";

export type ScratchpadSnapshot = {
  content: string;
  updatedAt: string;
};

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

export function writeScratchpad(dataDir: string, content: string): ScratchpadSnapshot {
  assertSize(content);
  ensureDataDir(dataDir);
  const filePath = scratchpadPath(dataDir);
  fs.writeFileSync(filePath, content, "utf8");
  const stat = fs.statSync(filePath);
  return { content, updatedAt: stat.mtime.toISOString() };
}

export function appendScratchpad(dataDir: string, chunk: string): ScratchpadSnapshot {
  ensureDataDir(dataDir);
  const filePath = scratchpadPath(dataDir);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  // Normalize whatever the file ends with into a blank-line boundary before the
  // appended chunk, so concurrent agents append clean stanzas instead of run-on text.
  const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const tail = chunk.endsWith("\n") ? chunk : `${chunk}\n`;
  return writeScratchpad(dataDir, `${existing}${separator}${tail}`);
}

function ensureDataDir(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function assertSize(content: string) {
  if (Buffer.byteLength(content, "utf8") > SCRATCHPAD_MAX_BYTES) {
    throw new ScratchpadTooLargeError();
  }
}
