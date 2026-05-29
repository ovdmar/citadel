// Side-by-side version diff dialog. Extracted from `scratchpad-panel.tsx`
// to keep the panel under the 800-line file-size cap. Owns the row-key memo
// that maps `sideBySideDiff` output into stable React keys; the parent panel
// only owns the selected-entry id + restore state.
import { X } from "lucide-react";
import { useMemo } from "react";
import { sideBySideDiff } from "./routes/scratchpad-diff.js";

export type ScratchpadVersionDiffDialogProps = {
  selectedContent: string | null;
  currentContent: string;
  diffError: string | null;
  restoring: boolean;
  onClose: () => void;
  onRestore: () => void;
};

export function ScratchpadVersionDiffDialog(props: ScratchpadVersionDiffDialogProps) {
  const { selectedContent, currentContent, diffError, restoring, onClose, onRestore } = props;

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
    <dialog className="scratchpad-diff-overlay" open aria-modal="true" aria-label="Scratchpad version diff">
      <button type="button" className="scratchpad-diff-backdrop" onClick={onClose} aria-label="Close diff" />
      <div className="scratchpad-diff-panel">
        <header className="scratchpad-diff-header">
          <span>Older version vs current</span>
          <button type="button" className="scratchpad-diff-close" onClick={onClose} aria-label="Close diff">
            <X size={14} />
          </button>
        </header>
        <div className="scratchpad-diff-columns">
          <div className="scratchpad-diff-col-label">
            <span>Older version</span>
            <button
              type="button"
              className="scratchpad-restore-btn"
              onClick={onRestore}
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
              Diff is too large to render ({diff.oldLines} vs {diff.newLines} lines; limit {diff.limit}). Use Restore to
              swap in this version, or open the file directly.
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
  );
}
