import { Link } from "@tanstack/react-router";
import { ArrowLeft, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { sideBySideDiff } from "./scratchpad-diff.js";

type ScratchpadSnapshot = { content: string; updatedAt: string };
type HistorySummary = {
  id: string;
  ts: string;
  firstWriteTs: string;
  source: string;
  contentSha256: string;
  byteLength: number;
  coalescedCount: number;
  preview: string;
};

type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 500;

export function ScratchpadView() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const latestRef = useRef<string>("");
  const savingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    latestRef.current = content;
  }, [content]);

  const loadFromServer = useCallback(async () => {
    try {
      const snapshot = await api<ScratchpadSnapshot>("/api/scratchpad");
      if (!mountedRef.current) return;
      if (latestRef.current === lastSavedRef.current) {
        setContent(snapshot.content);
        latestRef.current = snapshot.content;
      }
      lastSavedRef.current = snapshot.content;
      setUpdatedAt(snapshot.updatedAt);
      setErrorMessage(null);
      setLoadError(null);
      setLoaded(true);
      if (!savingRef.current) setSaveState("saved");
    } catch (error) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : "load_failed";
      setLoadError(message);
      setErrorMessage(message);
      setSaveState("error");
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const result = await api<{ entries: HistorySummary[] }>("/api/scratchpad/history");
      if (!mountedRef.current) return;
      setHistory(result.entries);
    } catch {
      /* sidebar refresh is best-effort */
    }
  }, []);

  useEffect(() => {
    void loadFromServer();
    void loadHistory();
  }, [loadFromServer, loadHistory]);

  const saveLatest = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (latestRef.current !== lastSavedRef.current) {
        const snapshot = latestRef.current;
        if (mountedRef.current) setSaveState("saving");
        try {
          const result = await api<ScratchpadSnapshot>("/api/scratchpad", {
            method: "PUT",
            body: JSON.stringify({ content: snapshot }),
          });
          lastSavedRef.current = result.content;
          if (!mountedRef.current) return;
          setUpdatedAt(result.updatedAt);
          setErrorMessage(null);
        } catch (error) {
          if (!mountedRef.current) return;
          setErrorMessage(error instanceof Error ? error.message : "save_failed");
          setSaveState("error");
          return;
        }
      }
      if (mountedRef.current) setSaveState("saved");
    } finally {
      savingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (content === lastSavedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveState("saving");
    debounceRef.current = setTimeout(() => {
      void saveLatest();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, loaded, saveLatest]);

  useEffect(() => {
    const events = new EventSource("/events");
    const refreshContent = () => {
      if (savingRef.current) return;
      void loadFromServer();
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
  }, [loadFromServer, loadHistory]);

  const openEntry = useCallback(async (id: string) => {
    setSelectedEntryId(id);
    setSelectedContent(null);
    setDiffError(null);
    try {
      const result = await api<{ entry: { content: string } }>(`/api/scratchpad/history/${encodeURIComponent(id)}`);
      if (!mountedRef.current) return;
      setSelectedContent(result.entry.content);
    } catch (error) {
      if (!mountedRef.current) return;
      setDiffError(error instanceof Error ? error.message : "load_failed");
    }
  }, []);

  const closeDiff = useCallback(() => {
    setSelectedEntryId(null);
    setSelectedContent(null);
    setDiffError(null);
  }, []);

  const restoreSelected = useCallback(async () => {
    if (!selectedEntryId) return;
    setRestoring(true);
    try {
      await api<ScratchpadSnapshot>("/api/scratchpad/restore", {
        method: "POST",
        body: JSON.stringify({ entryId: selectedEntryId }),
      });
      await Promise.all([loadFromServer(), loadHistory()]);
      if (mountedRef.current) closeDiff();
    } catch (error) {
      if (!mountedRef.current) return;
      setDiffError(error instanceof Error ? error.message : "restore_failed");
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  }, [closeDiff, loadFromServer, loadHistory, selectedEntryId]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setSaveState("idle");
    void loadFromServer();
  }, [loadFromServer]);

  const diff = useMemo(() => {
    if (selectedContent === null) return null;
    const rows = sideBySideDiff(selectedContent, content);
    let lastOld = 0;
    let lastNew = 0;
    return rows.map((row) => {
      if (row.kind === "skip") {
        return { row, key: `skip-${lastOld}-${lastNew}-${row.hiddenCount}` as string };
      }
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
  }, [selectedContent, content]);

  return (
    <div className="page dashboard-page scratchpad-page">
      <header className="dashboard-header" aria-label="Scratchpad navigation">
        <Link to="/" className="dashboard-back" title="Back to cockpit" aria-label="Back to cockpit">
          <ArrowLeft size={14} /> Cockpit
        </Link>
        <span className="dashboard-title">Scratchpad</span>
        <span className="command-result-meta scratchpad-status" aria-live="polite">
          {renderStatus(saveState, updatedAt, errorMessage)}
        </span>
      </header>
      <div className="scratchpad-body">
        {loadError ? (
          <div className="scratchpad-load-error" role="alert">
            <p>Couldn't load the scratchpad: {loadError}</p>
            <button type="button" onClick={retryLoad}>
              Retry
            </button>
          </div>
        ) : (
          <textarea
            className="scratchpad-textarea"
            aria-label="Scratchpad markdown"
            spellCheck={false}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Note things here. Orchestrator agents can read this via MCP and spin up work."
            disabled={!loaded}
          />
        )}
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
          <div
            className="scratchpad-diff-backdrop"
            onClick={closeDiff}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeDiff();
            }}
            role="button"
            tabIndex={-1}
            aria-label="Close diff"
          />
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
              ) : diff.length === 0 ? (
                <p className="scratchpad-diff-empty">No differences.</p>
              ) : (
                <div className="scratchpad-diff-grid">
                  {diff.map(({ row, key }) => {
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

function renderStatus(state: SaveState, updatedAt: string | null, error: string | null) {
  if (state === "saving") return "Saving…";
  if (state === "error") return error ? `Error: ${error}` : "Save failed";
  if (state === "saved" || state === "idle") {
    if (!updatedAt) return "";
    const stamp = new Date(updatedAt);
    return Number.isNaN(stamp.getTime()) ? "Saved" : `Saved · ${stamp.toLocaleTimeString()}`;
  }
  return "";
}

function formatStamp(ts: string) {
  const stamp = new Date(ts);
  if (Number.isNaN(stamp.getTime())) return ts;
  return stamp.toLocaleString();
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function pillSlug(source: string) {
  if (source.startsWith("restore:")) return "restore";
  if (source === "mcp:write_scratchpad") return "mcp-write";
  if (source === "mcp:append_scratchpad") return "mcp-append";
  return source;
}

function pillLabel(source: string) {
  if (source === "ui") return "UI";
  if (source === "mcp:write_scratchpad") return "MCP write";
  if (source === "mcp:append_scratchpad") return "MCP append";
  if (source === "backfill") return "Backfill";
  if (source.startsWith("restore:")) return "Restore";
  return source;
}
