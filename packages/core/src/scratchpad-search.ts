// Fuzzy search over scratchpad blocks. Shared between the cockpit's floating
// searchbar and the daemon's `GET /api/scratchpad/blocks/search` endpoint (and
// the `fuzzy_search_scratchpad` MCP tool) so ranking is identical regardless
// of caller.
//
// fuse.js is the scoring engine. It is published as browser+node compatible
// JS with no `fs`/`node:*`/`react` imports — verified at integration time.
// `packages/core` stays pure: this file imports only fuse.js and a type from
// `@citadel/contracts`.
import type { ScratchpadBlockSummary } from "@citadel/contracts";
import Fuse, { type IFuseOptions } from "fuse.js";

export type FuzzyMatchIndex = [number, number];

export type FuzzyBlockMatch = {
  block: ScratchpadBlockSummary;
  score: number;
  matches: { indices: FuzzyMatchIndex[] }[];
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

const FUSE_OPTIONS: IFuseOptions<ScratchpadBlockSummary> = {
  keys: ["text"],
  // 0 = exact match, 1 = match anything. 0.3 is forgiving without being noisy.
  threshold: 0.3,
  includeScore: true,
  includeMatches: true,
  // Don't bail out early on long text — scratchpad blocks can have many
  // words; matching beyond char 60 should still rank.
  ignoreLocation: true,
  isCaseSensitive: false,
};

export function buildFuzzyIndex(blocks: readonly ScratchpadBlockSummary[]): Fuse<ScratchpadBlockSummary> {
  return new Fuse(blocks as ScratchpadBlockSummary[], FUSE_OPTIONS);
}

export function fuzzySearchBlocks(
  blocks: readonly ScratchpadBlockSummary[],
  query: string,
  limit: number = DEFAULT_LIMIT,
): FuzzyBlockMatch[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const clamped = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
  const fuse = buildFuzzyIndex(blocks);
  const raw = fuse.search(q, { limit: clamped });
  return raw.map((result) => ({
    block: result.item,
    // fuse's score: 0 is perfect, 1 is worst. We surface as-is so the UI/MCP
    // caller can interpret consistently (lower = better, no inversion games).
    score: result.score ?? 0,
    matches: (result.matches ?? []).map((m) => ({
      // fuse indices are [start, endInclusive] tuples; we mirror that shape.
      indices: m.indices.map(([a, b]) => [a, b] as FuzzyMatchIndex),
    })),
  }));
}

export const SEARCH_LIMITS = {
  default: DEFAULT_LIMIT,
  max: MAX_LIMIT,
} as const;
