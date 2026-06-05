import type {
  CreatePullRequestResult,
  InternalReviewScopeSummary,
  InternalReviewThread,
  InternalReviewThreadReply,
  MarkReviewFileViewedInput,
  PushBranchResult,
  ReviewDiffBucket,
  ReviewDiffFileContent,
  ReviewDiffFileSummary,
  ReviewDiffMetadata,
  ReviewDiffSide,
} from "@citadel/contracts";
import { type DiffLineAnnotation, type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  Loader2,
  MessageSquare,
  RefreshCw,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api.js";
import { useStateQuery } from "../app-state.js";
import { formatLabel } from "../labels.js";
import { useToast } from "../toast.js";
import { useResolvedTheme } from "../use-resolved-theme.js";
import { LineThreadAnnotation, NewThreadForm, type NewThreadInput, ThreadGroup } from "./review-diff-comments.js";

type ThreadsResponse = {
  reviewScope: InternalReviewScopeSummary | null;
  threads: InternalReviewThread[];
};

type CreateThreadResult = { thread: InternalReviewThread };
type ReplyThreadResult = { reply: InternalReviewThreadReply; thread: InternalReviewThread | null };
type ReviewActionResult = CreatePullRequestResult | PushBranchResult;

const SECTION_ORDER: ReviewDiffBucket[] = ["against-base", "staged", "unstaged"];

export function ReviewDiffView() {
  const { checkoutId = "", workspaceId = "" } = useParams({ strict: false }) as {
    checkoutId?: string;
    workspaceId?: string;
  };
  const toast = useToast();
  const queryClient = useQueryClient();
  const state = useStateQuery();
  const metadata = useQuery<ReviewDiffMetadata>({
    queryKey: ["review-diff", checkoutId],
    queryFn: () => api<ReviewDiffMetadata>(`/api/checkouts/${checkoutId}/review-diff`),
    enabled: Boolean(checkoutId),
    refetchInterval: 10_000,
  });
  const threads = useQuery<ThreadsResponse>({
    queryKey: ["review-threads", checkoutId],
    queryFn: () =>
      api<ThreadsResponse>(`/api/checkouts/${checkoutId}/review-threads?includeResolved=true&includeOutdated=true`),
    enabled: Boolean(checkoutId && metadata.data?.reviewScope),
  });
  const [actionResult, setActionResult] = useState<ReviewActionResult | null>(null);

  const checkout = state.data?.checkouts.find((entry) => entry.id === checkoutId) ?? null;
  const workspace =
    state.data?.workspaces.find((entry) => entry.id === (metadata.data?.workspaceId ?? workspaceId)) ?? null;
  const repo = state.data?.repos.find((entry) => entry.id === (metadata.data?.repoId ?? checkout?.repoId)) ?? null;
  const allThreads = threads.data?.threads ?? [];

  const invalidateReview = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["review-diff", checkoutId] }),
      queryClient.invalidateQueries({ queryKey: ["review-threads", checkoutId] }),
      queryClient.invalidateQueries({ queryKey: ["state"] }),
    ]);
  };

  const pushBranch = useMutation({
    mutationFn: () => api<PushBranchResult>(`/api/checkouts/${checkoutId}/push-branch`, postJson({})),
    onSuccess: async (result) => {
      setActionResult(result);
      toast.push({
        tone: result.ok ? "info" : "error",
        message: result.ok ? "Branch push started." : actionError(result),
      });
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const createPullRequest = useMutation({
    mutationFn: () => api<CreatePullRequestResult>(`/api/checkouts/${checkoutId}/pull-request`, postJson({})),
    onSuccess: async (result) => {
      setActionResult(result);
      toast.push({
        tone: result.ok ? "info" : "error",
        message: result.ok ? "Pull request created." : actionError(result),
      });
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const createThread = useMutation({
    mutationFn: (input: NewThreadInput) =>
      api<CreateThreadResult>(
        `/api/checkouts/${checkoutId}/review-threads`,
        postJson({ ...input, authorKind: "user" }),
      ),
    onSuccess: async () => {
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const replyThread = useMutation({
    mutationFn: (input: { threadId: string; body: string }) =>
      api<ReplyThreadResult>(
        `/api/review-threads/${input.threadId}/replies`,
        postJson({ body: input.body, authorKind: "user" }),
      ),
    onSuccess: async () => {
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const resolveThread = useMutation({
    mutationFn: (threadId: string) =>
      api<{ thread: InternalReviewThread }>(`/api/review-threads/${threadId}/resolve`, postJson({})),
    onSuccess: async () => {
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const reopenThread = useMutation({
    mutationFn: (threadId: string) =>
      api<{ thread: InternalReviewThread }>(`/api/review-threads/${threadId}/reopen`, postJson({})),
    onSuccess: async () => {
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const markViewed = useMutation({
    mutationFn: (input: MarkReviewFileViewedInput) =>
      postNoContent(`/api/checkouts/${checkoutId}/review-viewed-files`, input),
    onSuccess: async () => {
      await invalidateReview();
    },
    onError: (error) => toast.push({ tone: "error", message: errorMessage(error) }),
  });

  const flatFiles = useMemo(
    () => metadata.data?.sections.flatMap((section) => section.files.map((file) => ({ section, file }))) ?? [],
    [metadata.data],
  );
  const totals = useMemo(() => summarizeMetadata(metadata.data), [metadata.data]);
  const reviewScope = metadata.data?.reviewScope ?? null;

  return (
    <div className="review-shell">
      <header className="review-topbar">
        <Link className="cit-icon-btn review-back" to="/" aria-label="Back to cockpit" title="Back to cockpit">
          <ArrowLeft size={17} />
        </Link>
        <div className="review-title-block">
          <div className="review-title-row">
            <h1>{checkout?.name ?? workspace?.name ?? "Review diff"}</h1>
            {reviewScope ? (
              <a
                className="review-pr-link"
                href={reviewScope.externalReviewUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                <GitPullRequest size={13} /> #{reviewScope.externalReviewNumber ?? "PR"} <ExternalLink size={11} />
              </a>
            ) : (
              <span className="review-pr-pill">No PR</span>
            )}
          </div>
          <div className="review-meta">
            <span>{repo?.name ?? "Repository"}</span>
            <span>{metadata.data?.base.baseBranch ?? checkout?.baseBranch ?? "base"}</span>
            <span>{checkout?.branch ?? reviewScope?.headRef ?? "branch"}</span>
            {metadata.data?.checkedAt ? <span>{new Date(metadata.data.checkedAt).toLocaleTimeString()}</span> : null}
          </div>
        </div>
        <div className="review-actions">
          <button
            type="button"
            className="review-action-btn"
            onClick={() => metadata.refetch()}
            disabled={metadata.isFetching}
            title="Refresh review diff"
          >
            <RefreshCw size={14} className={metadata.isFetching ? "spin" : undefined} /> Refresh
          </button>
          <button
            type="button"
            className="review-action-btn"
            onClick={() => pushBranch.mutate()}
            disabled={!checkoutId || pushBranch.isPending}
            title="Push branch"
          >
            {pushBranch.isPending ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Push
          </button>
          <button
            type="button"
            className="review-action-btn review-action-btn--primary"
            onClick={() => createPullRequest.mutate()}
            disabled={!checkoutId || createPullRequest.isPending || Boolean(reviewScope)}
            title="Create pull request"
          >
            {createPullRequest.isPending ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />} Create
            PR
          </button>
        </div>
      </header>

      <div className="review-layout">
        <aside className="review-sidebar">
          <section className="review-side-section">
            <div className="review-side-title">Summary</div>
            <div className="review-stat-grid">
              <Metric label="Files" value={totals.files} />
              <Metric label="Added" value={`+${totals.additions}`} tone="add" />
              <Metric label="Removed" value={`-${totals.deletions}`} tone="del" />
              <Metric label="Open" value={totals.openThreads} tone={totals.openThreads ? "warn" : "ok"} />
            </div>
          </section>
          <section className="review-side-section">
            <div className="review-side-title">Files</div>
            <nav className="review-file-nav" aria-label="Review files">
              {flatFiles.map(({ section, file }) => (
                <a key={file.id} href={`#${fileDomId(file.id)}`} className="review-file-link">
                  <span className="review-file-bucket">{shortBucket(section.bucket)}</span>
                  <span className="review-file-path" title={file.path}>
                    {file.path}
                  </span>
                  {file.openThreadCount ? <span className="review-file-count">{file.openThreadCount}</span> : null}
                </a>
              ))}
            </nav>
          </section>
          <section className="review-side-section">
            <div className="review-side-title">Commits</div>
            {metadata.data?.commits.length ? (
              <ol className="review-commit-list">
                {metadata.data.commits.map((commit) => (
                  <li key={commit.sha}>
                    <GitCommitHorizontal size={13} />
                    <span className="review-commit-sha">{commit.shortSha}</span>
                    <span className="review-commit-subject" title={commit.subject}>
                      {commit.subject}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="review-muted">No committed changes.</div>
            )}
          </section>
        </aside>

        <main className="review-main">
          {metadata.isLoading ? <ReviewLoading /> : null}
          {metadata.error ? <ReviewError error={metadata.error} /> : null}
          {metadata.data && !reviewScope ? (
            <ReviewSetupPanel
              pushPending={pushBranch.isPending}
              prPending={createPullRequest.isPending}
              onPush={() => pushBranch.mutate()}
              onCreatePr={() => createPullRequest.mutate()}
            />
          ) : null}
          <ReviewWarnings metadata={metadata.data} actionResult={actionResult} />
          {metadata.data?.sections
            .filter((section) => section.files.length)
            .sort((a, b) => SECTION_ORDER.indexOf(a.bucket) - SECTION_ORDER.indexOf(b.bucket))
            .map((section) => (
              <section key={section.bucket} className="review-section">
                <div className="review-section-head">
                  <h2>{section.label}</h2>
                  <span>
                    {section.fileCount} files / +{section.additions} -{section.deletions}
                  </span>
                </div>
                {section.files.map((file) => (
                  <ReviewFileCard
                    key={file.id}
                    checkoutId={checkoutId}
                    file={file}
                    reviewScope={reviewScope}
                    threads={allThreads.filter((thread) => threadMatchesFile(thread, file))}
                    createPending={createThread.isPending}
                    threadActionPending={
                      replyThread.isPending || resolveThread.isPending || reopenThread.isPending || markViewed.isPending
                    }
                    onCreateThread={(input) => createThread.mutateAsync(input).then(() => undefined)}
                    onReply={(threadId, body) => replyThread.mutateAsync({ threadId, body }).then(() => undefined)}
                    onResolve={(threadId) => resolveThread.mutateAsync(threadId).then(() => undefined)}
                    onReopen={(threadId) => reopenThread.mutateAsync(threadId).then(() => undefined)}
                    onViewed={(input) => markViewed.mutate(input)}
                  />
                ))}
              </section>
            ))}
          {metadata.data && flatFiles.length === 0 ? <div className="review-empty">No changed files.</div> : null}
        </main>
      </div>
    </div>
  );
}

function ReviewFileCard(props: {
  checkoutId: string;
  file: ReviewDiffFileSummary;
  reviewScope: InternalReviewScopeSummary | null;
  threads: InternalReviewThread[];
  createPending: boolean;
  threadActionPending: boolean;
  onCreateThread: (input: NewThreadInput) => Promise<void>;
  onReply: (threadId: string, body: string) => Promise<void>;
  onResolve: (threadId: string) => Promise<void>;
  onReopen: (threadId: string) => Promise<void>;
  onViewed: (input: MarkReviewFileViewedInput) => void;
}) {
  const theme = useResolvedTheme();
  const { ref, ready } = useNearViewport<HTMLElement>();
  const content = useQuery<ReviewDiffFileContent>({
    queryKey: ["review-diff-file", props.checkoutId, props.file.id],
    queryFn: () =>
      api<ReviewDiffFileContent>(
        `/api/checkouts/${props.checkoutId}/review-diff/file?fileId=${encodeURIComponent(props.file.id)}`,
      ),
    enabled: ready && !props.file.binary && !props.file.tooLarge,
    staleTime: 30_000,
  });
  const fileDiff = useMemo(() => (content.data ? parseReviewFileDiff(content.data) : null), [content.data]);
  const annotations = useMemo(() => lineAnnotationsFor(props.threads), [props.threads]);
  const lineThreads = props.threads.filter((thread) => thread.anchorKind === "line");
  const fileThreads = props.threads.filter((thread) => thread.anchorKind === "file");
  const reviewScope = props.reviewScope;
  const [lineDraft, setLineDraft] = useState<{ side: ReviewDiffSide; line: number } | null>(null);
  const canComment = Boolean(reviewScope && props.file.commentable);
  const options = useMemo(
    () => ({
      diffStyle: "split" as const,
      diffIndicators: "bars" as const,
      hunkSeparators: "line-info-basic" as const,
      overflow: "wrap" as const,
      disableFileHeader: true,
      enableGutterUtility: canComment,
      lineHoverHighlight: "both" as const,
      theme: { light: "pierre-light" as const, dark: "pierre-dark-soft" as const },
      themeType: theme,
      tokenizeMaxLength: 180_000,
    }),
    [canComment, theme],
  );

  return (
    <article ref={ref} id={fileDomId(props.file.id)} className="review-file-card">
      <div className="review-file-head">
        <div className="review-file-title">
          <FileText size={15} />
          <span title={props.file.path}>{props.file.path}</span>
          <span className={`review-status-badge review-status-badge--${props.file.status}`}>
            {formatLabel(props.file.status)}
          </span>
        </div>
        <div className="review-file-stats">
          <span className="review-add">+{props.file.additions}</span>
          <span className="review-del">-{props.file.deletions}</span>
          {reviewScope ? (
            <button
              type="button"
              className="review-viewed-btn"
              onClick={() =>
                props.onViewed({
                  reviewScopeId: reviewScope.id,
                  fileId: props.file.id,
                  bucket: props.file.bucket,
                  path: props.file.path,
                  oldPath: props.file.oldPath,
                  diffIdentity: props.file.id,
                  viewed: !props.file.viewed,
                })
              }
              title={props.file.viewed ? "Mark not viewed" : "Mark viewed"}
            >
              {props.file.viewed ? <Eye size={13} /> : <EyeOff size={13} />}
              {props.file.viewed ? "Viewed" : "Unviewed"}
            </button>
          ) : null}
        </div>
      </div>
      {props.file.oldPath && props.file.oldPath !== props.file.path ? (
        <div className="review-rename-line">{props.file.oldPath}</div>
      ) : null}
      <div className="review-diff-frame">
        {props.file.binary ? <DiffNotice message="Binary file" /> : null}
        {props.file.tooLarge ? <DiffNotice message="File too large" /> : null}
        {!ready && !props.file.binary && !props.file.tooLarge ? <DiffNotice message="Queued" /> : null}
        {ready && content.isLoading ? <DiffNotice message="Loading" spin /> : null}
        {content.error ? <DiffNotice message={errorMessage(content.error)} tone="error" /> : null}
        {fileDiff ? (
          <FileDiff<InternalReviewThread[]>
            className="review-pierre-diff"
            fileDiff={fileDiff}
            options={options}
            lineAnnotations={annotations}
            disableWorkerPool
            renderAnnotation={(annotation) => <LineThreadAnnotation threads={annotation.metadata ?? []} />}
            {...(canComment
              ? {
                  renderGutterUtility: (
                    getHoveredLine: () =>
                      | {
                          lineNumber: number;
                          side: "deletions" | "additions";
                        }
                      | undefined,
                  ) => (
                    <button
                      type="button"
                      className="review-gutter-comment"
                      title="Comment on line"
                      onClick={() => {
                        const hovered = getHoveredLine();
                        if (!hovered) return;
                        setLineDraft({
                          side: hovered.side === "deletions" ? "old" : "new",
                          line: hovered.lineNumber,
                        });
                      }}
                    >
                      <MessageSquare size={11} />
                    </button>
                  ),
                }
              : {})}
          />
        ) : null}
      </div>
      {lineThreads.length ? (
        <ThreadGroup
          title="Line comments"
          threads={lineThreads}
          pending={props.threadActionPending}
          onReply={props.onReply}
          onResolve={props.onResolve}
          onReopen={props.onReopen}
        />
      ) : null}
      {fileThreads.length ? (
        <ThreadGroup
          title="File comments"
          threads={fileThreads}
          pending={props.threadActionPending}
          onReply={props.onReply}
          onResolve={props.onResolve}
          onReopen={props.onReopen}
        />
      ) : null}
      {canComment ? (
        <NewThreadForm
          file={props.file}
          pending={props.createPending}
          initialAnchor={lineDraft}
          onSubmit={async (input) => {
            await props.onCreateThread(input);
            setLineDraft(null);
          }}
        />
      ) : null}
    </article>
  );
}

function ReviewSetupPanel(props: {
  pushPending: boolean;
  prPending: boolean;
  onPush: () => void;
  onCreatePr: () => void;
}) {
  return (
    <section className="review-setup">
      <GitPullRequest size={18} />
      <div>
        <h2>No pull request</h2>
        <p>Internal comments start after the checkout has a PR scope.</p>
      </div>
      <button type="button" className="review-action-btn" onClick={props.onPush} disabled={props.pushPending}>
        {props.pushPending ? <Loader2 size={14} className="spin" /> : <Upload size={14} />} Push
      </button>
      <button
        type="button"
        className="review-action-btn review-action-btn--primary"
        onClick={props.onCreatePr}
        disabled={props.prPending}
      >
        {props.prPending ? <Loader2 size={14} className="spin" /> : <GitPullRequest size={14} />} Create PR
      </button>
    </section>
  );
}

function ReviewWarnings(props: { metadata: ReviewDiffMetadata | undefined; actionResult: ReviewActionResult | null }) {
  const warnings = [...(props.metadata?.warnings ?? []), ...(props.actionResult?.warnings ?? [])];
  if (!warnings.length && !props.actionResult?.error) return null;
  return (
    <section className="review-warnings">
      {warnings.map((warning) => (
        <div
          key={`${warning.code}-${warning.message}`}
          className={`review-warning review-warning--${warningSeverity(warning)}`}
        >
          <AlertTriangle size={15} />
          <span>{warning.message}</span>
        </div>
      ))}
      {props.actionResult?.error ? (
        <div className="review-warning review-warning--error">
          <AlertTriangle size={15} />
          <span>{props.actionResult.error}</span>
        </div>
      ) : null}
    </section>
  );
}

function ReviewLoading() {
  return (
    <div className="review-empty">
      <Loader2 size={18} className="spin" /> Reading review diff...
    </div>
  );
}

function ReviewError({ error }: { error: unknown }) {
  return (
    <div className="review-empty review-empty--error">
      <AlertTriangle size={18} /> {errorMessage(error)}
    </div>
  );
}

function DiffNotice({
  message,
  tone = "muted",
  spin = false,
}: { message: string; tone?: "muted" | "error"; spin?: boolean }) {
  return (
    <div className={`review-diff-notice review-diff-notice--${tone}`}>
      {spin ? <Loader2 size={14} className="spin" /> : null}
      {message}
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: { label: string; value: string | number; tone?: "neutral" | "add" | "del" | "ok" | "warn" }) {
  return (
    <div className={`review-metric review-metric--${tone}`}>
      <span>{value}</span>
      <span className="review-metric-label">{label}</span>
    </div>
  );
}

function useNearViewport<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setReady(true);
        observer.disconnect();
      },
      { rootMargin: "900px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [ready]);
  return { ref, ready };
}

function parseReviewFileDiff(content: ReviewDiffFileContent): FileDiffMetadata | null {
  if (content.binary || content.tooLarge) return null;
  try {
    return parseDiffFromFile(
      {
        name: content.oldPath ?? content.path,
        contents: content.oldContent ?? "",
        cacheKey: `${content.fileId}:old`,
      },
      {
        name: content.path,
        contents: content.newContent ?? "",
        cacheKey: `${content.fileId}:new`,
      },
      undefined,
      false,
    );
  } catch {
    return null;
  }
}

function lineAnnotationsFor(threads: InternalReviewThread[]): DiffLineAnnotation<InternalReviewThread[]>[] {
  const grouped = new Map<string, InternalReviewThread[]>();
  for (const thread of threads) {
    if (thread.anchorKind !== "line" || thread.anchorState !== "current" || !thread.startLine || !thread.side) continue;
    const key = `${thread.side}:${thread.startLine}`;
    grouped.set(key, [...(grouped.get(key) ?? []), thread]);
  }
  return [...grouped.entries()].map(([key, groupedThreads]) => {
    const [side, line] = key.split(":");
    return {
      side: side === "old" ? "deletions" : "additions",
      lineNumber: Number.parseInt(line ?? "1", 10),
      metadata: groupedThreads,
    };
  });
}

function threadMatchesFile(thread: InternalReviewThread, file: ReviewDiffFileSummary): boolean {
  return (
    thread.bucket === file.bucket && thread.path === file.path && (thread.oldPath ?? null) === (file.oldPath ?? null)
  );
}

function summarizeMetadata(metadata: ReviewDiffMetadata | undefined) {
  const sections = metadata?.sections ?? [];
  return {
    files: sections.reduce((total, section) => total + section.fileCount, 0),
    additions: sections.reduce((total, section) => total + section.additions, 0),
    deletions: sections.reduce((total, section) => total + section.deletions, 0),
    openThreads: sections.reduce(
      (total, section) => total + section.files.reduce((sum, file) => sum + file.openThreadCount, 0),
      0,
    ),
  };
}

function shortBucket(bucket: ReviewDiffBucket): string {
  if (bucket === "against-base") return "base";
  return bucket;
}

function fileDomId(fileId: string): string {
  return `review-file-${fileId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function postJson(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

async function postNoContent(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const message = await response.text();
    throw new ApiError(message || response.statusText, [], undefined, response.status);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Request failed.";
}

function actionError(result: ReviewActionResult): string {
  return result.error ?? "Action failed.";
}

function warningSeverity(warning: {
  code: string;
  message: string;
  severity?: "info" | "warning" | "error";
}): "info" | "warning" | "error" {
  return warning.severity ?? "warning";
}
