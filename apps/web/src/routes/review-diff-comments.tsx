import type {
  CreateReviewThreadInput,
  InternalReviewThread,
  ReviewDiffFileSummary,
  ReviewDiffSide,
} from "@citadel/contracts";
import { CheckCircle2, ChevronDown, Loader2, MessageSquare, RotateCcw, Send } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { formatLabel } from "../labels.js";

export type NewThreadInput = Omit<
  CreateReviewThreadInput,
  "checkoutId" | "reviewScopeId" | "authorKind" | "authorLabel"
>;

export function ThreadGroup(props: {
  title: string;
  threads: InternalReviewThread[];
  pending: boolean;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string) => Promise<void>;
  onReopen: (threadId: string) => Promise<void>;
}) {
  return (
    <section className="review-thread-group">
      <h3>{props.title}</h3>
      {props.threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          pending={props.pending}
          onReply={props.onReply}
          onResolve={props.onResolve}
          onReopen={props.onReopen}
        />
      ))}
    </section>
  );
}

function ThreadCard(props: {
  thread: InternalReviewThread;
  pending: boolean;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string) => Promise<void>;
  onReopen: (threadId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(props.thread.status === "open");
  const [body, setBody] = useState("");
  const readOnly = props.thread.kind !== "internal";
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    await props.onReply(props.thread.id, trimmed);
    setBody("");
    setExpanded(true);
  };
  return (
    <div
      className={`review-thread review-thread--${props.thread.status}`}
      data-outdated={props.thread.anchorState === "outdated" || undefined}
    >
      <button type="button" className="review-thread-toggle" onClick={() => setExpanded((value) => !value)}>
        <ChevronDown size={14} data-open={expanded || undefined} />
        <span>{threadTitle(props.thread)}</span>
        <span className="review-thread-state">{formatLabel(props.thread.status)}</span>
      </button>
      {expanded ? (
        <div className="review-thread-body">
          {props.thread.replies.map((reply) => (
            <div key={reply.id} className={`review-reply review-reply--${reply.authorKind}`}>
              <div className="review-reply-meta">
                <span>{reply.authorLabel ?? formatLabel(reply.authorKind)}</span>
                <span>{new Date(reply.createdAt).toLocaleString()}</span>
              </div>
              <p>{reply.body}</p>
            </div>
          ))}
          {!readOnly ? (
            <form className="review-reply-form" onSubmit={submit}>
              <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={2} />
              <div className="review-thread-actions">
                <button type="submit" className="review-small-btn" disabled={props.pending || !body.trim()}>
                  <Send size={13} /> Reply
                </button>
                {props.thread.status === "open" ? (
                  <button
                    type="button"
                    className="review-small-btn"
                    disabled={props.pending}
                    onClick={() => props.onResolve(props.thread.id)}
                  >
                    <CheckCircle2 size={13} /> Resolve
                  </button>
                ) : (
                  <button
                    type="button"
                    className="review-small-btn"
                    disabled={props.pending}
                    onClick={() => props.onReopen(props.thread.id)}
                  >
                    <RotateCcw size={13} /> Reopen
                  </button>
                )}
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function NewThreadForm(props: {
  file: ReviewDiffFileSummary;
  pending: boolean;
  initialAnchor: { side: ReviewDiffSide; line: number } | null;
  onSubmit: (input: NewThreadInput) => Promise<void>;
}) {
  const [anchorKind, setAnchorKind] = useState<"file" | "line">("file");
  const [side, setSide] = useState<ReviewDiffSide>("new");
  const [line, setLine] = useState("1");
  const [body, setBody] = useState("");
  useEffect(() => {
    if (!props.initialAnchor) return;
    setAnchorKind("line");
    setSide(props.initialAnchor.side);
    setLine(String(props.initialAnchor.line));
  }, [props.initialAnchor]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = body.trim();
    const parsedLine = Number.parseInt(line, 10);
    if (!trimmed || (anchorKind === "line" && (!Number.isFinite(parsedLine) || parsedLine < 1))) return;
    await props.onSubmit({
      bucket: props.file.bucket,
      path: props.file.path,
      oldPath: props.file.oldPath,
      anchorKind,
      side: anchorKind === "line" ? side : undefined,
      startLine: anchorKind === "line" ? parsedLine : undefined,
      body: trimmed,
    });
    setBody("");
  };
  return (
    <form className="review-new-thread" onSubmit={submit}>
      <div className="review-form-row">
        <div className="review-segmented">
          <button type="button" data-active={anchorKind === "file" || undefined} onClick={() => setAnchorKind("file")}>
            File
          </button>
          <button type="button" data-active={anchorKind === "line" || undefined} onClick={() => setAnchorKind("line")}>
            Line
          </button>
        </div>
        {anchorKind === "line" ? (
          <>
            <select value={side} onChange={(event) => setSide(event.target.value as ReviewDiffSide)}>
              <option value="new">New</option>
              <option value="old">Old</option>
            </select>
            <input
              value={line}
              onChange={(event) => setLine(event.target.value)}
              inputMode="numeric"
              aria-label="Line"
            />
          </>
        ) : null}
      </div>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} />
      <div className="review-form-actions">
        <button
          type="submit"
          className="review-small-btn review-small-btn--primary"
          disabled={props.pending || !body.trim()}
        >
          {props.pending ? <Loader2 size={13} className="spin" /> : <MessageSquare size={13} />} Comment
        </button>
      </div>
    </form>
  );
}

export function LineThreadAnnotation({ threads }: { threads: InternalReviewThread[] }) {
  if (threads.length === 0) return null;
  return (
    <div className="review-line-annotation">
      <MessageSquare size={13} />
      <span>{threads.length}</span>
      <span>{threads[0]?.replies[0]?.body ?? "Comment"}</span>
    </div>
  );
}

function threadTitle(thread: InternalReviewThread): string {
  const prefix =
    thread.anchorKind === "file" ? "File" : `${thread.side === "old" ? "Old" : "New"} line ${thread.startLine ?? "?"}`;
  return thread.anchorState === "outdated" ? `${prefix} - outdated` : prefix;
}
