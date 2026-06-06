// Floating fuzzy searchbar for the scratchpad drawer.
//
// Opens with `/` (caller registers the keydown listener; the searchbar itself
// just exposes an `open` prop). Search input is debounced ~80ms before fuse
// re-runs. The `Fuse` instance is memoized on the blocks array identity so we
// don't rebuild the index on every keystroke.
import type { ScratchpadBlockSummary } from "@citadel/contracts";
import { fuzzySearchBlocks } from "@citadel/core";
import type { FuzzyBlockMatch } from "@citadel/core";
import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type ScratchpadPanelSearchProps = {
  blocks: readonly ScratchpadBlockSummary[];
  open: boolean;
  onClose: () => void;
  onResultsChange: (results: FuzzyBlockMatch[] | null) => void;
};

const DEBOUNCE_MS = 80;

export function ScratchpadPanelSearch(props: ScratchpadPanelSearchProps) {
  const { blocks, open, onClose, onResultsChange } = props;
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce keystrokes — typing 5 chars triggers 1 search, not 5.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  // Focus the input when the searchbar opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);

  // Memoize the search result on (debouncedQuery, blocks identity). fuse.js
  // rebuilds its internal index here too — keeping this tied to blocks identity
  // (not just length) so the index is rebuilt only when the array reference
  // actually changes.
  const results = useMemo<FuzzyBlockMatch[] | null>(() => {
    if (!open) return null;
    if (debouncedQuery.trim().length === 0) return null;
    return fuzzySearchBlocks(blocks, debouncedQuery);
  }, [open, debouncedQuery, blocks]);

  // Forward results upstream so the panel's render path can filter blocks.
  // Use a ref-stable callback identity from the parent to avoid spurious
  // re-notifies; React handles the same-value short-circuit.
  useEffect(() => {
    onResultsChange(results);
  }, [results, onResultsChange]);

  if (!open) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: <input type="search"> would replace the whole bar; this is a search *container* with its own input/button, so role="search" on the wrapper is the right semantic.
    <div className="scratchpad-searchbar" role="search">
      <Search size={14} aria-hidden />
      <input
        ref={inputRef}
        type="text"
        className="scratchpad-searchbar-input"
        placeholder="Fuzzy search blocks…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        aria-label="Search scratchpad blocks"
      />
      <button
        type="button"
        className="scratchpad-searchbar-close"
        onClick={onClose}
        aria-label="Close search"
        title="Close search (Esc)"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// Highlight match indices inside a block's text. Returns React nodes — wraps
// matched ranges in <mark>. Used by the panel when search is active.
export function highlightMatches(text: string, indices: readonly (readonly [number, number])[]): React.ReactNode[] {
  if (indices.length === 0) return [text];
  const sorted = [...indices].sort((a, b) => a[0] - b[0]);
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const range = sorted[i];
    if (!range) continue;
    const [start, endInclusive] = range;
    if (start > cursor) out.push(text.slice(cursor, start));
    out.push(
      <mark key={`${start}-${endInclusive}-${i}`} className="scratchpad-search-hit">
        {text.slice(start, endInclusive + 1)}
      </mark>,
    );
    cursor = endInclusive + 1;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}
