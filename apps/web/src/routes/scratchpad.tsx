import type { ScratchpadBlockSummary, ScratchpadHistorySummary, ScratchpadSnapshot } from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { VoiceCaptureButton } from "../components/voice-capture-button.js";
import { sideBySideDiff } from "./scratchpad-diff.js";
import { formatBytes, pillLabel, pillSlug } from "./scratchpad-helpers.js";
import { renderBlockMarkdown } from "./scratchpad-markdown.js";

type HistorySummary = ScratchpadHistorySummary;
type BlockSummary = ScratchpadBlockSummary;

type UiBlock = BlockSummary & { draft: string; isEditing: boolean };

type UndoPayload = { block: BlockSummary; previousIds: string[] };

const SAVE_DEBOUNCE_MS = 1000;
const UNDO_WINDOW_MS = 5000;

export function ScratchpadView() {
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

  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);
  const blocksRef = useRef<UiBlock[]>([]);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
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

  // Scroll the list to the bottom whenever blocks are added/removed so the newest
  // content and the composer stay in view. The composer itself is sticky-positioned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: blocks.length is the intentional trigger
  useEffect(() => {
    if (!loaded) return;
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [loaded, blocks.length]);

  // Focus the composer on mount.
  useEffect(() => {
    if (loaded) composerRef.current?.focus();
  }, [loaded]);

  // SSE: refetch blocks + history on every scratchpad mutation.
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

  const saveBlock = useCallback(
    async (id: string, draft: string) => {
      const trimmed = draft.trim();
      if (trimmed.length === 0) {
        // Empty edit deletes the block.
        try {
          await api<{ snapshot: ScratchpadSnapshot }>(`/api/scratchpad/blocks/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
        } catch {
          /* error already surfaced via SSE refresh */
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
      } catch (error) {
        if (!mountedRef.current) return;
        // Drop the local edit state so user can re-engage.
        setBlockField(id, { isEditing: false });
        const message = error instanceof Error ? error.message : "save_failed";
        setComposerError(message);
      }
    },
    [loadBlocks, setBlockField],
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
        // Re-focus composer for rapid entry.
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
      // Optimistically remove from local state.
      setBlocks((current) => current.filter((b) => b.id !== id));
      try {
        await api<{ snapshot: ScratchpadSnapshot }>(`/api/scratchpad/blocks/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      } catch {
        // Rollback on server failure.
        await loadBlocks();
        return;
      }
      // Offer undo via a transient toast.
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
      /* user dismissed expectation; reload to converge on server truth */
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

  useEffect(() => {
    if (!selectedEntryId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDiff();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selectedEntryId, closeDiff]);

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

  return (
    <div className="page dashboard-page scratchpad-page">
      <header className="dashboard-header" aria-label="Scratchpad navigation">
        <Link to="/" className="dashboard-back" title="Back to cockpit" aria-label="Back to cockpit">
          <ArrowLeft size={14} /> Cockpit
        </Link>
        <span className="dashboard-title">Scratchpad</span>
        <span className="command-result-meta scratchpad-status" aria-live="polite">
          {renderStatus(updatedAt)}
        </span>
      </header>
      <div className="scratchpad-body">
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
                {blocks.length === 0 ? (
                  <p className="scratchpad-block-empty">No blocks yet. Use the composer below to add one.</p>
                ) : null}
                {blocks.map((block) => (
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
                <div className="scratchpad-composer-row">
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
                  <VoiceCaptureButton
                    onTranscript={(text) =>
                      setComposer((prev) => (prev.trim().length === 0 ? text : `${prev.trim()} ${text}`))
                    }
                  />
                </div>
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

type BlockItemProps = {
  block: UiBlock;
  onStartEditing: (id: string) => void;
  onCancel: (id: string) => void;
  onChange: (id: string, value: string) => void;
  onBlur: (id: string, value: string) => void;
  onKey: (id: string, event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onDelete: (id: string) => void;
};

function BlockItem(props: BlockItemProps) {
  const { block, onStartEditing, onChange, onBlur, onKey, onDelete } = props;
  const renderedHtml = useMemo(
    () => (block.isEditing ? "" : renderBlockMarkdown(block.text)),
    [block.isEditing, block.text],
  );
  const editorRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (block.isEditing) {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      // Auto-size to content so the editing surface keeps the rendered block's
      // visual height (no "shrink to small textarea" feeling).
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [block.isEditing]);

  const onTextareaInput = useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  if (block.isEditing) {
    return (
      <div className="scratchpad-block scratchpad-block-editing">
        <div className="scratchpad-block-edit-row">
          <textarea
            ref={editorRef}
            className="scratchpad-block-textarea"
            aria-label="Edit block"
            value={block.draft}
            onInput={onTextareaInput}
            onChange={(event) => onChange(block.id, event.target.value)}
            onBlur={(event) => onBlur(block.id, event.target.value)}
            onKeyDown={(event) => onKey(block.id, event)}
          />
          <VoiceCaptureButton
            onTranscript={(text) => {
              const merged = block.draft.trim().length === 0 ? text : `${block.draft.trim()} ${text}`;
              onChange(block.id, merged);
            }}
          />
        </div>
      </div>
    );
  }

  // Non-editing block: a full-width clickable surface that opens edit mode.
  // We deliberately use a div with role="button" (not a <button>) so links
  // and other interactive content in the rendered markdown stay valid HTML
  // and aren't swallowed by a button-in-button.
  const open = () => onStartEditing(block.id);
  return (
    <div
      className="scratchpad-block"
      // biome-ignore lint/a11y/useSemanticElements: a <button> here would invalidate links rendered from markdown (nested-interactive), so div+role=button is the right structure.
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
    >
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is sanitized via DOMPurify in renderBlockMarkdown */}
      <div className="scratchpad-block-rendered" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      <button
        type="button"
        className="scratchpad-block-delete"
        aria-label="Delete block"
        title="Delete block"
        onClick={(event) => {
          event.stopPropagation();
          onDelete(block.id);
        }}
      >
        <Trash2 size={14} />
      </button>
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

function renderStatus(updatedAt: string | null) {
  if (!updatedAt) return "";
  const stamp = new Date(updatedAt);
  return Number.isNaN(stamp.getTime()) ? "Saved" : `Saved · ${stamp.toLocaleTimeString()}`;
}

function formatStamp(ts: string) {
  const stamp = new Date(ts);
  if (Number.isNaN(stamp.getTime())) return ts;
  return stamp.toLocaleString();
}
