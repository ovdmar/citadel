import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.js";

type ScratchpadSnapshot = { content: string; updatedAt: string };

type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_DEBOUNCE_MS = 500;

export function ScratchpadView() {
  const [content, setContent] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      // Only adopt the server's content when the user has no unsaved local edits;
      // otherwise an SSE-triggered refetch would clobber what they're typing.
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
      // Deliberately do NOT set `loaded = true` on failure: leaves the textarea
      // disabled so the user can't type into an empty buffer and have the next
      // autosave overwrite the file they failed to load.
    }
  }, []);

  useEffect(() => {
    void loadFromServer();
  }, [loadFromServer]);

  // Single-flight save loop: PUT the latest typed value, and after it returns,
  // re-check whether the editor has drifted again (typed during the request)
  // and chain another PUT. This serializes writes so concurrent debounce fires
  // can't produce out-of-order PUTs and a lost-write race.
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

  // Pick up MCP-driven writes (append_scratchpad etc.) so the cockpit reflects
  // what other agents have appended without requiring a manual refresh. Skip
  // events we triggered ourselves to avoid a save→event→refetch round-trip on
  // every keystroke.
  useEffect(() => {
    const events = new EventSource("/events");
    const refresh = () => {
      if (savingRef.current) return;
      void loadFromServer();
    };
    events.addEventListener("scratchpad.updated", refresh);
    return () => {
      events.removeEventListener("scratchpad.updated", refresh);
      events.close();
    };
  }, [loadFromServer]);

  const retryLoad = useCallback(() => {
    setLoadError(null);
    setSaveState("idle");
    void loadFromServer();
  }, [loadFromServer]);

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
      </div>
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
