// Scratchpad drawer panel. Mounted once at the Shell level (sibling to the
// router <Outlet />) so the drawer is reachable from every route without
// replacing the underlying view. Visibility is driven by the shared
// `scratchpad-drawer-store`; when closed, the panel root carries the `hidden`
// HTML attribute so React keeps state mounted (scrollTop, edit state, etc.)
// across close/reopen and across route changes.
//
// The SSE listener is panel-lifetime-scoped (NOT gated on open) so block /
// history updates from other tabs or MCP writers keep converging into local
// state even while the drawer is closed.
import type { ScratchpadBlockSummary, ScratchpadHistorySummary, ScratchpadSnapshot } from "@citadel/contracts";
import type { FuzzyBlockMatch } from "@citadel/core";
import { X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { sideBySideDiff } from "./routes/scratchpad-diff.js";
import { formatBytes, pillLabel, pillSlug } from "./routes/scratchpad-helpers.js";
import { useScratchpadDrawer } from "./scratchpad-drawer-store.js";
import { BlockItem, type UiBlock } from "./scratchpad-panel-block.js";
import { ScratchpadPanelSearch } from "./scratchpad-panel-search.js";

type HistorySummary = ScratchpadHistorySummary;
type BlockSummary = ScratchpadBlockSummary;

type UndoPayload = { block: BlockSummary; previousIds: string[] };

const SAVE_DEBOUNCE_MS = 1000;
const UNDO_WINDOW_MS = 5000;
const PULSE_MS = 800;
// Auto-scroll-to-bottom tolerance: a scroll position within this many pixels of
// the bottom counts as "user was at the bottom" so reopening still scrolls.
const BOTTOM_TOLERANCE = 4;

export function ScratchpadPanel() {
  const { open, setOpen } = useScratchpadDrawer();
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [composer, setComposer] = useState("");
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoPayload | null>(null);
  // "ok" right after a successful cmd+s save, "err" right after a failure.
  // null = no pulse. Reads via [data-saving] on the drawer header element.
  const [savePulse, setSavePulse] = useState<"ok" | "err" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<FuzzyBlockMatch[] | null>(null);

  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const blocksRef = useRef<UiBlock[]>([]);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // First-open behavior + scroll-position memory between close/reopen.
  const hasOpenedOnceRef = useRef(false);
  const wasAtBottomRef = useRef(true);
  const prevOpenRef = useRef(open);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    };
  }, []);

  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);

  const mergeBlocks = useCallback((server: BlockSummary[]) => {
    setBlocks((current) => {
      const localById = new Map(current.map((b) => [b.id, b]));
      const merged: UiBlock[] = server.map((sb) => {
        const local = localById.get(sb.id);
        if (local?.isEditing) {
          return { ...local, ...sb, draft: local.draft, isEditing: true };
        }
        return { ...sb, draft: sb.text, isEditing: false };
      });
      return merged;
    });
  }, []);

  const loadBlocks = useCallback(async () => {
    try {
      const snap = await api<{ blocks: BlockSummary[] }>("/api/scratchpad/blocks");
      if (!mountedRef.current) return;
      mergeBlocks(snap.blocks);
      setLoadError(null);
      setLoaded(true);
    } catch (error) {
      if (!mountedRef.current) return;
      setLoadError(error instanceof Error ? error.message : "load_failed");
    }
  }, [mergeBlocks]);

  const loadCurrentMeta = useCallback(async () => {
    try {
      const snapshot = await api<ScratchpadSnapshot>("/api/scratchpad");
      if (!mountedRef.current) return;
      setUpdatedAt(snapshot.updatedAt);
    } catch {
      /* meta is best-effort */
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api<{ entries: HistorySummary[] }>("/api/scratchpad/history");
      if (!mountedRef.current) return;
      setHistory(result.entries);
    } catch {
      /* sidebar is best-effort */
    }
  }, []);

  useEffect(() => {
    void loadBlocks();
    void loadCurrentMeta();
    void loadHistory();
  }, [loadBlocks, loadCurrentMeta, loadHistory]);

  // Scroll-on-open behavior. Two cases:
  //   (1) First open per session: always scroll to bottom once blocks are loaded.
  //   (2) Subsequent reopens: preserve scrollTop, except auto-scroll if the user
  //       was at the bottom when they last closed (so new content stays visible).
  // useLayoutEffect ensures the scroll happens before paint (no top-snap flash).
  useLayoutEffect(() => {
    if (!open) {
      // Capture "was at bottom" on the open→closed transition for next reopen.
      if (prevOpenRef.current && listRef.current) {
        const el = listRef.current;
        wasAtBottomRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) <= BOTTOM_TOLERANCE;
      }
      prevOpenRef.current = false;
      return;
    }
    const opening = !prevOpenRef.current;
    prevOpenRef.current = true;
    if (!loaded || !listRef.current) return;
    if (opening) {
      // Don't auto-scroll-to-bottom if a search is active — the user's match
      // position takes precedence over latest-block visibility.
      if (!searchResults && (!hasOpenedOnceRef.current || wasAtBottomRef.current)) {
        listRef.current.scrollTop = listRef.current.scrollHeight;
      }
      hasOpenedOnceRef.current = true;
    }
  }, [open, loaded, searchResults]);

  // When new content arrives while the drawer is open and the user is already
  // at the bottom, keep the bottom in view. This is the original auto-scroll
  // behavior (per AC), kept separate from the open-edge effect above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks.length is the intentional trigger; we don't need to re-run when the array reference changes for other reasons.
  useEffect(() => {
    if (!open || !loaded || !listRef.current) return;
    const el = listRef.current;
    const atBottom = el.scrollHeight - (el.scrollTop + el.clientHeight) <= BOTTOM_TOLERANCE;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }, [open, loaded, blocks.length]);

  // Focus the composer on first open after load.
  useEffect(() => {
    if (open && loaded) composerRef.current?.focus();
  }, [open, loaded]);

  // SSE: refetch blocks + history on every scratchpad mutation. Attached for
  // the panel's lifetime — NOT gated on `open` — so closed-drawer state stays
  // fresh from MCP and multi-tab writers.
  useEffect(() => {
    const events = new EventSource("/events");
    const refreshContent = () => {
      void loadBlocks();
      void loadCurrentMeta();
    };
    const refreshHistory = () => {
      void loadHistory();
    };
    events.addEventListener("scratchpad.updated", refreshContent);
    events.addEventListener("scratchpad.history.updated", refreshHistory);
    return () => {
      events.removeEventListener("scratchpad.updated", refreshContent);
      events.removeEventListener("scratchpad.history.updated", refreshHistory);
      events.close();
    };
  }, [loadBlocks, loadCurrentMeta, loadHistory]);

  const setBlockField = useCallback((id: string, patch: Partial<UiBlock>) => {
    setBlocks((current) => current.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const startEditing = useCallback(
    (id: string) => {
      const block = blocksRef.current.find((b) => b.id === id);
      if (!block) return;
      setBlockField(id, { isEditing: true, draft: block.text });
    },
    [setBlockField],
  );

  const cancelEditing = useCallback(
    (id: string) => {
      const block = blocksRef.current.find((b) => b.id === id);
      if (!block) return;
      setBlockField(id, { isEditing: false, draft: block.text });
    },
    [setBlockField],
  );

  // Fire a save-pulse animation. Single timer ref keeps double-press race-safe:
  // every new pulse clears the prior timer before scheduling a new one.
  const firePulse = useCallback((kind: "ok" | "err") => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    setSavePulse(kind);
    pulseTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setSavePulse(null);
      pulseTimerRef.current = null;
    }, PULSE_MS);
  }, []);

  const saveBlock = useCallback(
    async (id: string, draft: string, opts?: { pulse?: boolean }) => {
      const trimmed = draft.trim();
      if (trimmed.length === 0) {
        // Empty edit deletes the block.
        try {
          await api<{ snapshot: ScratchpadSnapshot }>(`/api/scratchpad/blocks/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (opts?.pulse) firePulse("ok");
        } catch {
          if (opts?.pulse) firePulse("err");
        }
        await loadBlocks();
        return;
      }
      try {
        const result = await api<{ block: BlockSummary; snapshot: ScratchpadSnapshot }>(
          `/api/scratchpad/blocks/${encodeURIComponent(id)}`,
          {
            method: "PUT",
            body: JSON.stringify({ text: draft }),
          },
        );
        if (!mountedRef.current) return;
        setBlocks((current) =>
          current.map((b) =>
            b.id === id
              ? {
                  ...b,
                  text: result.block.text,
                  draft: result.block.text,
                  updatedAt: result.block.updatedAt,
                  isEditing: false,
                }
              : b,
          ),
        );
        setUpdatedAt(result.snapshot.updatedAt);
        if (opts?.pulse) firePulse("ok");
      } catch (error) {
        if (!mountedRef.current) return;
        // Drop the local edit state so user can re-engage.
        setBlockField(id, { isEditing: false });
        const message = error instanceof Error ? error.message : "save_failed";
        setComposerError(message);
        if (opts?.pulse) firePulse("err");
      }
    },
    [loadBlocks, setBlockField, firePulse],
  );

  const scheduleAutoSave = useDebouncedSave(saveBlock);

  const onBlockChange = useCallback(
    (id: string, value: string) => {
      setBlockField(id, { draft: value });
      scheduleAutoSave(id, value);
    },
    [scheduleAutoSave, setBlockField],
  );

  const onBlockKey = useCallback(
    (id: string, event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        const draft = event.currentTarget.value;
        void saveBlock(id, draft);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        // Cmd/Ctrl+S inside the editor: flush immediately + animated pulse on
        // result (success/error). preventDefault blocks the browser's "save page".
        event.preventDefault();
        const draft = event.currentTarget.value;
        void saveBlock(id, draft, { pulse: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEditing(id);
      }
    },
    [cancelEditing, saveBlock],
  );

  const onBlockBlur = useCallback(
    (id: string, value: string) => {
      void saveBlock(id, value);
    },
    [saveBlock],
  );

  const submitComposer = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      try {
        await api<{ block: BlockSummary; snapshot: ScratchpadSnapshot }>("/api/scratchpad/blocks", {
          method: "POST",
          body: JSON.stringify({ text }),
        });
        if (!mountedRef.current) return;
        setComposer("");
        setComposerError(null);
        await loadBlocks();
        composerRef.current?.focus();
      } catch (error) {
        if (!mountedRef.current) return;
        setComposerError(error instanceof Error ? error.message : "save_failed");
      }
    },
    [loadBlocks],
  );

  const onComposerKey = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submitComposer(event.currentTarget.value);
      }
    },
    [submitComposer],
  );

  const onComposerBlur = useCallback(() => {
    if (composer.trim().length > 0) void submitComposer(composer);
  }, [composer, submitComposer]);

  const requestDelete = useCallback(
    async (id: string) => {
      const block = blocksRef.current.find((b) => b.id === id);
      if (!block) return;
      const previousIds = blocksRef.current.map((b) => b.id);
      setBlocks((current) => current.filter((b) => b.id !== id));
      try {
        await api<{ snapshot: ScratchpadSnapshot }>(`/api/scratchpad/blocks/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } catch {
        await loadBlocks();
        return;
      }
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
      setUndo({ block, previousIds });
      undoTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setUndo(null);
      }, UNDO_WINDOW_MS);
    },
    [loadBlocks],
  );

  const dismissUndo = useCallback(() => {
    if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
    setUndo(null);
  }, []);

  const performUndo = useCallback(async () => {
    if (!undo) return;
    const { block, previousIds } = undo;
    dismissUndo();
    const beforeIndex = previousIds.findIndex((id) => id === block.id);
    const afterId = beforeIndex > 0 ? previousIds[beforeIndex - 1] : undefined;
    try {
      const body: { text: string; position?: { afterId: string } } = { text: block.text };
      if (afterId) body.position = { afterId };
      await api<{ block: BlockSummary; snapshot: ScratchpadSnapshot }>("/api/scratchpad/blocks", {
        method: "POST",
        body: JSON.stringify(body),
      });
      await loadBlocks();
    } catch {
      await loadBlocks();
    }
  }, [dismissUndo, loadBlocks, undo]);

  // History sidebar + diff modal — unchanged from prior version.
  const openEntry = useCallback(
    async (id: string) => {
      setSelectedEntryId(id);
      setSelectedContent(null);
      setDiffError(null);
      void loadBlocks();
      void loadCurrentMeta();
      try {
        const result = await api<{ entry: { content: string } }>(`/api/scratchpad/history/${encodeURIComponent(id)}`);
        if (!mountedRef.current) return;
        setSelectedContent(result.entry.content);
      } catch (error) {
        if (!mountedRef.current) return;
        setDiffError(error instanceof Error ? error.message : "load_failed");
      }
    },
    [loadBlocks, loadCurrentMeta],
  );

  const closeDiff = useCallback(() => {
    setSelectedEntryId(null);
    setSelectedContent(null);
    setDiffError(null);
  }, []);

  // Esc precedence inside the drawer: (1) searchbar (handled inside its own
  // component, which calls onClose), (2) diff modal, (3) drawer close.
  // Block-edit cancel is handled inside BlockItem's own keydown so it
  // intercepts Esc before this document listener fires.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (searchOpen) return; // searchbar already owns this Esc
      if (selectedEntryId) {
        event.preventDefault();
        closeDiff();
        return;
      }
      // Don't steal Esc if focus is inside a textarea (the block editor wants
      // it for cancel-edit). If focus is on a button/link/the panel chrome,
      // close the drawer.
      const active = document.activeElement as HTMLElement | null;
      const isText =
        active?.tagName === "TEXTAREA" || active?.tagName === "INPUT" || active?.isContentEditable === true;
      if (!isText) {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, searchOpen, selectedEntryId, closeDiff, setOpen]);

  // `/` opens the searchbar when no input/textarea is focused. Listening on
  // window so the keypress fires even when focus is on the drawer chrome.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if (inEditable) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const restoreSelected = useCallback(async () => {
    if (!selectedEntryId) return;
    setRestoring(true);
    try {
      await api<ScratchpadSnapshot>("/api/scratchpad/restore", {
        method: "POST",
        body: JSON.stringify({ entryId: selectedEntryId }),
      });
      await Promise.all([loadBlocks(), loadCurrentMeta(), loadHistory()]);
      if (mountedRef.current) closeDiff();
    } catch (error) {
      if (!mountedRef.current) return;
      setDiffError(error instanceof Error ? error.message : "restore_failed");
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  }, [closeDiff, loadBlocks, loadCurrentMeta, loadHistory, selectedEntryId]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    void loadBlocks();
  }, [loadBlocks]);

  const currentContent = useMemo(
    () =>
      blocks
        .filter((b) => !b.isEditing)
        .map((b) => b.text)
        .join("\n\n"),
    [blocks],
  );

  const diff = useMemo(() => {
    if (selectedContent === null) return null;
    const result = sideBySideDiff(selectedContent, currentContent);
    if (result.kind === "too_large") return result;
    let lastOld = 0;
    let lastNew = 0;
    const mapped = result.rows.map((row) => {
      if (row.kind === "skip") return { row, key: `skip-${lastOld}-${lastNew}-${row.hiddenCount}` };
      if (row.kind === "context") {
        lastOld = row.oldNo;
        lastNew = row.newNo;
        return { row, key: `ctx-${row.oldNo}-${row.newNo}` };
      }
      if (row.kind === "remove") {
        lastOld = row.oldNo;
        return { row, key: `rem-${row.oldNo}` };
      }
      lastNew = row.newNo;
      return { row, key: `add-${row.newNo}` };
    });
    return { kind: "rows" as const, rows: mapped };
  }, [selectedContent, currentContent]);

  // Filter visible blocks by search results when search is active.
  const visibleBlocks = useMemo(() => {
    if (!searchResults) return blocks;
    const order = new Map(searchResults.map((m, i) => [m.block.id, i]));
    return blocks.filter((b) => order.has(b.id)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [blocks, searchResults]);

  return (
    <div className="scratchpad-drawer" hidden={!open} aria-hidden={!open} aria-label="Scratchpad">
      <header className="scratchpad-drawer-header" data-saving={savePulse ?? undefined}>
        <span className="scratchpad-drawer-title">Scratchpad</span>
        <span className="scratchpad-drawer-status command-result-meta" aria-live="polite">
          {renderStatus(updatedAt, savePulse)}
        </span>
        <button
          type="button"
          className="scratchpad-drawer-close"
          aria-label="Close scratchpad"
          title="Close scratchpad (Esc)"
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </header>
      <ScratchpadPanelSearch
        blocks={blocks}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onResultsChange={setSearchResults}
      />
      <div className="scratchpad-drawer-body">
        <div className="scratchpad-blocks-pane">
          {loadError ? (
            <div className="scratchpad-load-error" role="alert">
              <p>Couldn't load the scratchpad: {loadError}</p>
              <button type="button" onClick={retryLoad}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <div ref={listRef} className="scratchpad-block-list">
                {visibleBlocks.length === 0 ? (
                  <p className="scratchpad-block-empty">
                    {searchResults
                      ? "No blocks match the search."
                      : "No blocks yet. Use the composer below to add one."}
                  </p>
                ) : null}
                {visibleBlocks.map((block) => (
                  <BlockItem
                    key={block.id}
                    block={block}
                    onStartEditing={startEditing}
                    onCancel={cancelEditing}
                    onChange={onBlockChange}
                    onBlur={onBlockBlur}
                    onKey={onBlockKey}
                    onDelete={requestDelete}
                  />
                ))}
              </div>
              <div className="scratchpad-composer">
                {composerError ? (
                  <p className="scratchpad-composer-error" role="alert">
                    {composerError}
                  </p>
                ) : null}
                <textarea
                  ref={composerRef}
                  className="scratchpad-composer-input"
                  aria-label="New scratchpad block"
                  placeholder="Add a note. ⌘/Ctrl-Enter creates a new block."
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onInput={(event) => {
                    const el = event.currentTarget;
                    el.style.height = "auto";
                    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
                  }}
                  onKeyDown={onComposerKey}
                  onBlur={onComposerBlur}
                  disabled={!loaded}
                  rows={2}
                />
              </div>
              {undo ? (
                <output className="scratchpad-undo-toast">
                  <span>Block deleted.</span>
                  <button type="button" onClick={() => void performUndo()}>
                    Undo
                  </button>
                  <button type="button" aria-label="Dismiss undo" onClick={dismissUndo}>
                    <X size={12} />
                  </button>
                </output>
              ) : null}
            </>
          )}
        </div>
        <aside className="scratchpad-history" aria-label="Scratchpad version history">
          <header className="scratchpad-history-header">
            <span>Versions</span>
            <span className="scratchpad-history-count">{history.length}</span>
          </header>
          <ul className="scratchpad-history-list">
            {history.length === 0 ? (
              <li className="scratchpad-history-empty">No versions yet.</li>
            ) : (
              history.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`scratchpad-history-row${selectedEntryId === entry.id ? " is-selected" : ""}`}
                    onClick={() => void openEntry(entry.id)}
                  >
                    <div className="scratchpad-history-meta">
                      <span className="scratchpad-history-time">{formatStamp(entry.ts)}</span>
                      <span className={`scratchpad-history-pill source-${pillSlug(entry.source)}`}>
                        {pillLabel(entry.source)}
                      </span>
                      <span className="scratchpad-history-size">{formatBytes(entry.byteLength)}</span>
                    </div>
                    <div className="scratchpad-history-preview">{entry.preview.slice(0, 60)}</div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </aside>
      </div>
      {selectedEntryId ? (
        <dialog className="scratchpad-diff-overlay" open aria-modal="true" aria-label="Scratchpad version diff">
          <button type="button" className="scratchpad-diff-backdrop" onClick={closeDiff} aria-label="Close diff" />
          <div className="scratchpad-diff-panel">
            <header className="scratchpad-diff-header">
              <span>Older version vs current</span>
              <button type="button" className="scratchpad-diff-close" onClick={closeDiff} aria-label="Close diff">
                <X size={14} />
              </button>
            </header>
            <div className="scratchpad-diff-columns">
              <div className="scratchpad-diff-col-label">
                <span>Older version</span>
                <button
                  type="button"
                  className="scratchpad-restore-btn"
                  onClick={() => void restoreSelected()}
                  disabled={restoring || selectedContent === null}
                >
                  {restoring ? "Restoring…" : "Restore this version"}
                </button>
              </div>
              <div className="scratchpad-diff-col-label">
                <span>Current</span>
              </div>
            </div>
            <div className="scratchpad-diff-body">
              {diffError ? (
                <p className="scratchpad-diff-error">{diffError}</p>
              ) : diff === null ? (
                <p className="scratchpad-diff-loading">Loading…</p>
              ) : diff.kind === "too_large" ? (
                <p className="scratchpad-diff-empty">
                  Diff is too large to render ({diff.oldLines} vs {diff.newLines} lines; limit {diff.limit}). Use
                  Restore to swap in this version, or open the file directly.
                </p>
              ) : diff.rows.length === 0 ? (
                <p className="scratchpad-diff-empty">No differences.</p>
              ) : (
                <div className="scratchpad-diff-grid">
                  {diff.rows.map(({ row, key }) => {
                    if (row.kind === "skip") {
                      return (
                        <div key={key} className="scratchpad-diff-skip">
                          ··· {row.hiddenCount} unchanged {row.hiddenCount === 1 ? "line" : "lines"} ···
                        </div>
                      );
                    }
                    if (row.kind === "context") {
                      return (
                        <div key={key} className="scratchpad-diff-row kind-context">
                          <span className="scratchpad-diff-no">{row.oldNo}</span>
                          <pre className="scratchpad-diff-cell">{row.text}</pre>
                          <span className="scratchpad-diff-no">{row.newNo}</span>
                          <pre className="scratchpad-diff-cell">{row.text}</pre>
                        </div>
                      );
                    }
                    if (row.kind === "remove") {
                      return (
                        <div key={key} className="scratchpad-diff-row kind-remove">
                          <span className="scratchpad-diff-no">{row.oldNo}</span>
                          <pre className="scratchpad-diff-cell side-remove">{row.text}</pre>
                          <span className="scratchpad-diff-no" />
                          <pre className="scratchpad-diff-cell is-empty" />
                        </div>
                      );
                    }
                    return (
                      <div key={key} className="scratchpad-diff-row kind-add">
                        <span className="scratchpad-diff-no" />
                        <pre className="scratchpad-diff-cell is-empty" />
                        <span className="scratchpad-diff-no">{row.newNo}</span>
                        <pre className="scratchpad-diff-cell side-add">{row.text}</pre>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}

function useDebouncedSave(save: (id: string, draft: string) => void | Promise<void>) {
  const timerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(
    () => () => {
      for (const t of timerRef.current.values()) clearTimeout(t);
      timerRef.current.clear();
    },
    [],
  );

  return useCallback(
    (id: string, draft: string) => {
      const existing = timerRef.current.get(id);
      if (existing) clearTimeout(existing);
      const handle = setTimeout(() => {
        timerRef.current.delete(id);
        void save(id, draft);
      }, SAVE_DEBOUNCE_MS);
      timerRef.current.set(id, handle);
    },
    [save],
  );
}

function renderStatus(updatedAt: string | null, pulse: "ok" | "err" | null) {
  if (pulse === "ok") return "Saved ✓";
  if (pulse === "err") return "Save failed";
  if (!updatedAt) return "";
  const stamp = new Date(updatedAt);
  return Number.isNaN(stamp.getTime()) ? "Saved" : `Saved · ${stamp.toLocaleTimeString()}`;
}

function formatStamp(ts: string) {
  const stamp = new Date(ts);
  if (Number.isNaN(stamp.getTime())) return ts;
  return stamp.toLocaleString();
}
