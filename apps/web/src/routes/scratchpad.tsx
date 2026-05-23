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
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  const inFlightRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<ScratchpadSnapshot>("/api/scratchpad")
      .then((snapshot) => {
        if (cancelled) return;
        setContent(snapshot.content);
        setUpdatedAt(snapshot.updatedAt);
        lastSavedRef.current = snapshot.content;
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setErrorMessage(error instanceof Error ? error.message : "load_failed");
        setSaveState("error");
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const flush = useCallback(async (next: string) => {
    if (inFlightRef.current) await inFlightRef.current;
    if (next === lastSavedRef.current) {
      setSaveState("saved");
      return;
    }
    setSaveState("saving");
    const request = api<ScratchpadSnapshot>("/api/scratchpad", {
      method: "PUT",
      body: JSON.stringify({ content: next }),
    })
      .then((snapshot) => {
        lastSavedRef.current = snapshot.content;
        setUpdatedAt(snapshot.updatedAt);
        setSaveState("saved");
        setErrorMessage(null);
      })
      .catch((error: unknown) => {
        setSaveState("error");
        setErrorMessage(error instanceof Error ? error.message : "save_failed");
      })
      .finally(() => {
        inFlightRef.current = null;
      });
    inFlightRef.current = request;
    await request;
  }, []);

  useEffect(() => {
    if (!loaded) return;
    if (content === lastSavedRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSaveState("saving");
    debounceRef.current = setTimeout(() => {
      void flush(content);
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [content, loaded, flush]);

  return (
    <div className="page dashboard-page" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <header className="dashboard-header" aria-label="Scratchpad navigation">
        <Link to="/" className="dashboard-back" title="Back to cockpit" aria-label="Back to cockpit">
          <ArrowLeft size={14} /> Cockpit
        </Link>
        <span className="dashboard-title">Scratchpad</span>
        <span
          className="command-result-meta"
          style={{ marginLeft: "auto", padding: "0 16px", fontSize: 11 }}
          aria-live="polite"
        >
          {renderStatus(saveState, updatedAt, errorMessage)}
        </span>
      </header>
      <div style={{ flex: 1, display: "flex", padding: 16, minHeight: 0 }}>
        <textarea
          aria-label="Scratchpad markdown"
          spellCheck={false}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Note things here. Orchestrator agents can read this via MCP and spin up work."
          disabled={!loaded}
          style={{
            flex: 1,
            width: "100%",
            resize: "none",
            background: "var(--panel)",
            color: "inherit",
            border: "1px solid var(--line)",
            borderRadius: 6,
            padding: 16,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 13,
            lineHeight: 1.55,
            outline: "none",
          }}
        />
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
