import type { ScratchpadBlockSummary } from "@citadel/contracts";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { renderBlockMarkdown } from "./routes/scratchpad-markdown.js";

export type UiBlock = ScratchpadBlockSummary & { draft: string; isEditing: boolean };

export type BlockItemProps = {
  block: UiBlock;
  onStartEditing: (id: string) => void;
  onCancel: (id: string) => void;
  onChange: (id: string, value: string) => void;
  onBlur: (id: string, value: string) => void;
  onKey: (id: string, event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onDelete: (id: string) => void;
};

// Per-block line-number count. Blocks are the unit so the counter restarts at
// 1 inside each block (a document-wide counter would reorder when blocks move).
function countLines(text: string): number {
  if (text.length === 0) return 1;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  // A trailing newline visually creates an empty final line that doesn't need a
  // gutter row; drop it to keep gutter rows = visible lines.
  if (text.endsWith("\n")) n -= 1;
  return Math.max(n, 1);
}

function GutterRows({ count }: { count: number }) {
  const rows = useMemo(() => Array.from({ length: count }, (_, i) => i + 1), [count]);
  return (
    <div className="scratchpad-block-gutter" aria-hidden>
      {rows.map((n) => (
        <span key={n} className="scratchpad-block-gutter-row">
          {n}
        </span>
      ))}
    </div>
  );
}

export function BlockItem(props: BlockItemProps) {
  const { block, onStartEditing, onChange, onBlur, onKey, onDelete } = props;
  const renderedHtml = useMemo(
    () => (block.isEditing ? "" : renderBlockMarkdown(block.text)),
    [block.isEditing, block.text],
  );
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCountEdit = useMemo(() => countLines(block.draft), [block.draft]);
  const lineCountRead = useMemo(() => countLines(block.text), [block.text]);

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

  // Mirror textarea scroll to the gutter so long content keeps line numbers
  // aligned. wrap="off" is set on the textarea (see styling) so visual lines
  // map 1:1 to `\n`-counted lines.
  const onTextareaScroll = useCallback((event: React.UIEvent<HTMLTextAreaElement>) => {
    const g = gutterRef.current;
    if (!g) return;
    g.scrollTop = event.currentTarget.scrollTop;
  }, []);

  if (block.isEditing) {
    return (
      <div className="scratchpad-block scratchpad-block-editing">
        <div className="scratchpad-block-gutter-wrap" ref={gutterRef}>
          <GutterRows count={lineCountEdit} />
        </div>
        <textarea
          ref={editorRef}
          className="scratchpad-block-textarea"
          aria-label="Edit block"
          wrap="off"
          value={block.draft}
          onInput={onTextareaInput}
          onScroll={onTextareaScroll}
          onChange={(event) => onChange(block.id, event.target.value)}
          onBlur={(event) => onBlur(block.id, event.target.value)}
          onKeyDown={(event) => onKey(block.id, event)}
        />
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
      <GutterRows count={lineCountRead} />
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

// Exported for unit tests that want to verify the line-count behavior.
export const __testing__ = { countLines };
