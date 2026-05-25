import crypto from "node:crypto";
import type { ScratchpadBlock, ScratchpadBlockSummary, ScratchpadHistoryEntry } from "@citadel/contracts";
import { DEFAULT_STUB } from "./scratchpad.js";

export type Block = ScratchpadBlock;

const UUID_HEX = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OPEN_FENCE_RE = new RegExp(`^<!-- block:(${UUID_HEX}) -->$`);
const CODE_FENCE_RE = /^```/;
const BLOCK_MARKER_RE = /<!-- block:/;

export type ParseResult = { blocks: Block[]; needsRewrite: boolean };

export function parseBlocks(content: string): ParseResult {
  if (content.length === 0) return { blocks: [], needsRewrite: false };

  const lines = content.split("\n");
  const blocks: Block[] = [];
  const seenIds = new Set<string>();
  let needsRewrite = false;
  let pendingLeading: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const match = OPEN_FENCE_RE.exec(line);
    if (!match) {
      pendingLeading.push(line);
      i += 1;
      continue;
    }

    // Flush any unfenced content collected before this block as a promoted block.
    if (pendingLeading.length > 0) {
      const leading = pendingLeading.join("\n");
      const promoted = promoteLeading(leading);
      if (promoted !== null) {
        blocks.push({ id: freshBlockId(seenIds), text: promoted });
        needsRewrite = true;
      }
      pendingLeading = [];
    }

    const openId = match[1] ?? "";
    const closeFence = `<!-- /block:${openId} -->`;
    const bodyLines: string[] = [];
    let codeFenceDepth = 0;
    let j = i + 1;
    let closed = false;
    let nextOpenAt = -1;

    while (j < lines.length) {
      const body = lines[j] ?? "";
      if (codeFenceDepth === 0 && body === closeFence) {
        closed = true;
        break;
      }
      if (codeFenceDepth === 0 && OPEN_FENCE_RE.test(body)) {
        // Another open fence with the code-fence depth at zero means the current
        // block was never closed. Treat everything we've consumed so far as
        // content and stop here so the outer loop picks up the next block.
        nextOpenAt = j;
        break;
      }
      if (CODE_FENCE_RE.test(body)) codeFenceDepth = codeFenceDepth === 0 ? 1 : 0;
      bodyLines.push(body);
      j += 1;
    }

    const bodyText = bodyLines.join("\n");
    let id = openId;
    if (seenIds.has(id)) {
      id = freshBlockId(seenIds);
      needsRewrite = true;
    }
    seenIds.add(id);

    if (closed) {
      blocks.push({ id, text: bodyText });
      i = j + 1;
    } else if (nextOpenAt !== -1) {
      // Unclosed block consumed up to the next open fence.
      blocks.push({ id, text: bodyText });
      needsRewrite = true;
      i = nextOpenAt;
    } else {
      // Unclosed block ran to EOF.
      blocks.push({ id, text: bodyText });
      needsRewrite = true;
      i = lines.length;
    }
  }

  // Trailing unfenced content (after the last block) — promote to a block.
  if (pendingLeading.length > 0) {
    const leading = pendingLeading.join("\n");
    const promoted = promoteLeading(leading);
    if (promoted !== null) {
      blocks.push({ id: freshBlockId(seenIds), text: promoted });
      needsRewrite = true;
    }
  }

  // Drop empty blocks; if any were dropped, that's a rewrite.
  const filtered = blocks.filter((b) => b.text.trim().length > 0);
  if (filtered.length !== blocks.length) needsRewrite = true;

  return { blocks: filtered, needsRewrite };
}

export function serializeBlocks(blocks: Block[]): string {
  const usable = blocks.filter((b) => b.text.trim().length > 0);
  if (usable.length === 0) return "";
  return `${usable.map((b) => `<!-- block:${b.id} -->\n${b.text}\n<!-- /block:${b.id} -->`).join("\n\n")}\n`;
}

export type MigrateResult = { migrated: boolean; content: string };

export function migrateIfNeeded(raw: string): MigrateResult {
  if (raw.length === 0 || raw.trim().length === 0 || raw === DEFAULT_STUB) {
    return { migrated: false, content: raw };
  }
  if (BLOCK_MARKER_RE.test(raw)) {
    const { blocks, needsRewrite } = parseBlocks(raw);
    if (!needsRewrite) return { migrated: false, content: raw };
    return { migrated: true, content: serializeBlocks(blocks) };
  }
  // Legacy path: split on blank-line boundaries.
  const stripped = raw.startsWith(DEFAULT_STUB) ? raw.slice(DEFAULT_STUB.length) : raw;
  const chunks = stripped
    .split(/\n\s*\n/)
    .map((chunk) => chunk.replace(/^\n+|\n+$/g, ""))
    .filter((chunk) => chunk.length > 0);
  if (chunks.length === 0) return { migrated: false, content: raw };
  const seen = new Set<string>();
  const blocks: Block[] = chunks.map((text) => ({ id: freshBlockId(seen), text }));
  return { migrated: true, content: serializeBlocks(blocks) };
}

export type ComputeBlockTimestampsResult = {
  map: Map<string, { createdAt: string; updatedAt: string }>;
  fallbackMtime: string;
};

export function computeBlockTimestamps(
  history: ScratchpadHistoryEntry[],
  blocks: Block[],
  fallbackMtime: string,
): ComputeBlockTimestampsResult {
  // History is ordered oldest → newest in the on-disk JSONL; walk in that order.
  const ordered = [...history].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const map = new Map<string, { createdAt: string; updatedAt: string }>();

  for (const block of blocks) {
    const id = block.id;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;
    let prevExtracted: string | null = null;

    for (const entry of ordered) {
      const extracted = extractBlockText(entry.content, id);
      if (extracted === null) continue;
      if (createdAt === null) {
        createdAt = entry.firstWriteTs;
        updatedAt = entry.ts;
        prevExtracted = extracted;
        continue;
      }
      if (extracted !== prevExtracted) {
        updatedAt = entry.ts;
        prevExtracted = extracted;
      }
    }

    if (createdAt && updatedAt) {
      map.set(id, { createdAt, updatedAt });
    } else {
      map.set(id, { createdAt: fallbackMtime, updatedAt: fallbackMtime });
    }
  }

  return { map, fallbackMtime };
}

export function listBlockSummaries(
  blocks: Block[],
  history: ScratchpadHistoryEntry[],
  fallbackMtime: string,
): ScratchpadBlockSummary[] {
  const { map } = computeBlockTimestamps(history, blocks, fallbackMtime);
  return blocks.map((b) => {
    const ts = map.get(b.id) ?? { createdAt: fallbackMtime, updatedAt: fallbackMtime };
    return { id: b.id, text: b.text, createdAt: ts.createdAt, updatedAt: ts.updatedAt };
  });
}

function extractBlockText(content: string, id: string): string | null {
  const open = `<!-- block:${id} -->`;
  const close = `<!-- /block:${id} -->`;
  const openIdx = content.indexOf(open);
  if (openIdx === -1) return null;
  const bodyStart = openIdx + open.length + 1; // +1 for the trailing newline
  const closeIdx = content.indexOf(close, bodyStart);
  if (closeIdx === -1) return null;
  const body = content.slice(bodyStart, closeIdx);
  return body.endsWith("\n") ? body.slice(0, -1) : body;
}

function promoteLeading(raw: string): string | null {
  // Drop leading/trailing newlines; reject if nothing meaningful remains or it's DEFAULT_STUB.
  const trimmed = raw.replace(/^\n+|\n+$/g, "");
  if (trimmed.length === 0) return null;
  if (`${trimmed}\n\n` === DEFAULT_STUB) return null;
  return trimmed;
}

export function freshBlockId(seen: Set<string>): string {
  for (let i = 0; i < 8; i += 1) {
    const id = crypto.randomUUID();
    if (!seen.has(id)) {
      seen.add(id);
      return id;
    }
  }
  // Statistically unreachable.
  throw new Error("Failed to generate a unique block id");
}
