import type {
  ReviewComment,
  ReviewSuggestion,
  ReviewSuggestionRun,
  Workspace,
  WorkspaceDiff,
} from "@citadel/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "./api.js";

export type ReviewTabProps = {
  workspace: Workspace;
  diff: WorkspaceDiff | undefined;
  hasRequestReviewHook: boolean;
};

export function ReviewTab(props: ReviewTabProps) {
  return (
    <div className="inspector-review">
      <RequestReviewPanel workspace={props.workspace} hasHook={props.hasRequestReviewHook} />
      <ReviewCommentsPanel workspace={props.workspace} diff={props.diff} />
    </div>
  );
}

export function RequestReviewPanel(props: { workspace: Workspace; hasHook: boolean }) {
  const queryClient = useQueryClient();
  const latest = useQuery<{ run: ReviewSuggestionRun | null }>({
    queryKey: ["review-suggestions", props.workspace.id],
    queryFn: () => api(`/api/workspaces/${props.workspace.id}/review-suggestions`),
  });
  const mutation = useMutation({
    mutationFn: () =>
      api<{ run: ReviewSuggestionRun; output: { suggestions: ReviewSuggestion[] } }>(
        `/api/workspaces/${props.workspace.id}/review-requests`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["review-suggestions", props.workspace.id] }),
  });

  const run = latest.data?.run;
  const suggestions = run?.output?.suggestions ?? [];
  const status = mutation.isPending ? "loading" : (run?.status ?? "idle");
  return (
    <section className="inspector-review-request" aria-label="Request review">
      <header>
        <h3>Request review</h3>
        <button
          type="button"
          disabled={!props.hasHook || mutation.isPending}
          onClick={() => mutation.mutate()}
          title={
            props.hasHook
              ? "Run the configured workspace.requestReview hook"
              : "Configure a workspace.requestReview hook in Settings to enable this"
          }
        >
          {mutation.isPending ? "Requesting…" : "Request review"}
        </button>
      </header>
      {status === "failed" || status === "timed_out" ? (
        <p className="inspector-review-error">
          Hook {status === "timed_out" ? "timed out" : "failed"}: {run?.error ?? "unknown error"}
        </p>
      ) : null}
      {mutation.isError ? <p className="inspector-review-error">{(mutation.error as Error).message}</p> : null}
      {status === "succeeded" && suggestions.length === 0 ? (
        <p className="inspector-review-empty">Hook returned no suggestions.</p>
      ) : null}
      {suggestions.length > 0 ? (
        <ul className="inspector-review-suggestions">
          {suggestions.map((s) => (
            <li key={s.id} data-kind={s.kind}>
              <strong>{s.label}</strong>
              {s.detail ? <span>{s.detail}</span> : null}
              {s.url ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  open
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function ReviewCommentsPanel(props: { workspace: Workspace; diff: WorkspaceDiff | undefined }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [filePath, setFilePath] = useState("");
  const [lineStart, setLineStart] = useState("");

  const list = useQuery<{ comments: ReviewComment[] }>({
    queryKey: ["review-comments", props.workspace.id],
    queryFn: () => api(`/api/workspaces/${props.workspace.id}/review-comments`),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["review-comments", props.workspace.id] });

  const addMutation = useMutation({
    mutationFn: (input: { body: string; filePath?: string; lineStart?: number }) =>
      api<{ comment: ReviewComment }>(`/api/workspaces/${props.workspace.id}/review-comments`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      setBody("");
      setFilePath("");
      setLineStart("");
      invalidate();
    },
  });

  const submit = () => {
    if (!body.trim()) return;
    const payload: { body: string; filePath?: string; lineStart?: number } = { body };
    if (filePath) payload.filePath = filePath;
    if (filePath && lineStart) {
      const n = Number.parseInt(lineStart, 10);
      if (Number.isFinite(n) && n >= 1) payload.lineStart = n;
    }
    addMutation.mutate(payload);
  };

  const comments = list.data?.comments ?? [];
  const open = comments.filter((c) => c.status === "open");
  const resolved = comments.filter((c) => c.status === "resolved");

  return (
    <section className="inspector-review-comments" aria-label="Review comments">
      <header>
        <h3>Comments</h3>
      </header>
      <div className="inspector-review-composer">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Leave a comment for the operator + agent"
          rows={3}
        />
        <div className="inspector-review-anchor">
          <select value={filePath} onChange={(e) => setFilePath(e.target.value)}>
            <option value="">(workspace-level)</option>
            {(props.diff?.files ?? []).map((f) => (
              <option key={f.path} value={f.path}>
                {f.path}
              </option>
            ))}
          </select>
          {filePath ? (
            <input
              type="number"
              min={1}
              value={lineStart}
              onChange={(e) => setLineStart(e.target.value)}
              placeholder="line"
            />
          ) : null}
          <button type="button" onClick={submit} disabled={!body.trim() || addMutation.isPending}>
            {addMutation.isPending ? "Adding…" : "Add comment"}
          </button>
        </div>
      </div>
      {open.length === 0 && resolved.length === 0 ? <p className="inspector-review-empty">No comments yet.</p> : null}
      <ul className="inspector-review-list">
        {open.map((c) => (
          <CommentRow key={c.id} comment={c} workspaceId={props.workspace.id} onChanged={invalidate} />
        ))}
        {resolved.length > 0 ? <li className="inspector-review-resolved-header">{resolved.length} resolved</li> : null}
        {resolved.map((c) => (
          <CommentRow key={c.id} comment={c} workspaceId={props.workspace.id} onChanged={invalidate} />
        ))}
      </ul>
    </section>
  );
}

function CommentRow(props: { comment: ReviewComment; workspaceId: string; onChanged: () => void }) {
  const c = props.comment;
  const queryClient = useQueryClient();
  const toggleResolved = useMutation({
    mutationFn: () =>
      api(`/api/review-comments/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: c.status === "open" ? "resolved" : "open",
          ifUpdatedAtMatches: c.updatedAt,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-comments", props.workspaceId] });
      props.onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/review-comments/${c.id}`, {
        method: "DELETE",
        body: JSON.stringify({ ifUpdatedAtMatches: c.updatedAt }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["review-comments", props.workspaceId] });
      props.onChanged();
    },
  });
  return (
    <li className="inspector-review-comment" data-status={c.status}>
      <header>
        <span className="inspector-review-author">{c.author}</span>
        {c.filePath ? (
          <span className="inspector-review-anchor">
            {c.filePath}
            {c.lineStart ? `:${c.lineStart}${c.lineEnd && c.lineEnd !== c.lineStart ? `-${c.lineEnd}` : ""}` : ""}
          </span>
        ) : null}
        <time>{new Date(c.createdAt).toLocaleString()}</time>
      </header>
      <p>{c.body}</p>
      <div className="inspector-review-actions">
        <button type="button" onClick={() => toggleResolved.mutate()}>
          {c.status === "open" ? "Resolve" : "Reopen"}
        </button>
        <button type="button" onClick={() => remove.mutate()}>
          Delete
        </button>
        {toggleResolved.isError || remove.isError ? (
          <span className="inspector-review-error">{((toggleResolved.error ?? remove.error) as Error)?.message}</span>
        ) : null}
      </div>
    </li>
  );
}
