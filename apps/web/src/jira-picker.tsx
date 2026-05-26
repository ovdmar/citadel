// Native Jira issue picker: search + recent-by-default attach, hover or
// keyboard-focus unattach, inline transition menu with optimistic updates
// and cancelQueries-based rollback. Replaces the legacy free-form
// key + URL form that lived inline in inspector.tsx.
//
// Lives in its own file because inspector.tsx had crossed the 770-line
// mark and the picker (popover, debounced search, results list with
// keyboard nav, transition menu, attach/unattach/transition mutations,
// "Enter key manually" fallback) easily adds another 100+ lines.

import type {
  IssueSearchResponse,
  IssueSearchResult,
  IssueTransition,
  IssueTransitionActionResult,
  WorkspaceCockpitSummary,
} from "@citadel/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_STALE_MS = 5_000;
const COCKPIT_SUMMARY_QUERY = (workspaceId: string) => ["workspace-cockpit", workspaceId] as const;

export type IssueAttachSlotProps = {
  workspaceId: string;
  issueKey: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  issueUrl: string | null;
  // Transitions surface — sourced from the same cockpit-summary the parent
  // already fetches, so we don't re-request on every chip render.
  transitions?: IssueTransition[];
};

export function IssueAttachSlot(props: IssueAttachSlotProps) {
  if (props.issueKey) {
    return (
      <AttachedChip
        workspaceId={props.workspaceId}
        issueKey={props.issueKey}
        issueTitle={props.issueTitle}
        issueStatus={props.issueStatus}
        issueUrl={props.issueUrl}
        transitions={props.transitions ?? []}
      />
    );
  }
  return <UnattachedPicker workspaceId={props.workspaceId} />;
}

export function jiraStatusTone(status: string): "todo" | "progress" | "review" | "done" | "blocked" {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "done";
  if (s.includes("review")) return "review";
  if (s.includes("progress") || s.includes("doing")) return "progress";
  if (s.includes("block")) return "blocked";
  return "todo";
}

// ─── Attached chip ────────────────────────────────────────────────────────────

function AttachedChip(props: {
  workspaceId: string;
  issueKey: string;
  issueTitle: string | null;
  issueStatus: string | null;
  issueUrl: string | null;
  transitions: IssueTransition[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const unattach = useUnattachIssue(props.workspaceId);
  const transition = useTransitionIssue(props.workspaceId);

  // Close the transition menu when focus or pointer leaves the chip.
  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    if (menuOpen) {
      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }
    return undefined;
  }, [menuOpen]);

  const tone = props.issueStatus ? jiraStatusTone(props.issueStatus) : "unknown";

  return (
    <div className="inspector-attach cit-jira-attached" ref={containerRef}>
      <a
        className="cit-jira"
        href={props.issueUrl ?? undefined}
        target="_blank"
        rel="noreferrer"
        title={`Open ${props.issueKey}${props.issueTitle ? `: ${props.issueTitle}` : ""}`}
      >
        <span className="cit-jira-icon" aria-hidden>
          <svg viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="Issue tracker">
            <title>Issue tracker</title>
            <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="oklch(50% 0.16 250)" />
            <path
              d="M5 8.2l2 2 4-4"
              fill="none"
              stroke="#fff"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
        <span className="cit-jira-text">
          <span className="cit-jira-key">{props.issueKey}</span>
          {props.issueTitle ? <span className="cit-jira-title">{props.issueTitle}</span> : null}
        </span>
      </a>
      <button
        type="button"
        className={`cit-jira-status cit-jira-status--${tone} cit-jira-status-button`}
        title={props.issueStatus ? `Issue status: ${props.issueStatus} (click to transition)` : "Status not synced"}
        onClick={() => setMenuOpen((open) => !open)}
        disabled={props.transitions.length === 0 || transition.isPending}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {transition.isPending ? "…" : (props.issueStatus ?? "—")}
      </button>
      <button
        type="button"
        className="cit-jira-unattach"
        onClick={() => unattach.mutate()}
        disabled={unattach.isPending}
        aria-label="Unattach issue"
        title="Unattach issue from workspace"
      >
        <X size={11} aria-hidden />
      </button>
      {menuOpen && props.transitions.length > 0 ? (
        <div className="cit-jira-transitions" role="menu">
          {props.transitions.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                transition.mutate({ transition: t.id, toStatus: t.toStatus });
              }}
            >
              <span className="cit-jira-transition-name">{t.name}</span>
              <span className="cit-jira-transition-status">→ {t.toStatus}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─── Unattached picker ────────────────────────────────────────────────────────

function UnattachedPicker(props: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  return (
    <>
      <div className="inspector-attach">
        <button
          type="button"
          className="cit-jira cit-jira--empty"
          onClick={() => {
            setOpen((value) => !value);
            setManualOpen(false);
          }}
          aria-expanded={open}
          title="Attach a Jira ticket to this workspace"
        >
          <span className="cit-jira-empty-mark" aria-hidden>
            <Plus size={11} />
          </span>
          <span className="cit-jira-empty-text">
            <span className="cit-jira-empty-title">Attach Jira ticket</span>
            <span className="cit-jira-empty-hint">search or pick a recent issue</span>
          </span>
        </button>
      </div>
      {open && !manualOpen ? (
        <SearchPanel
          workspaceId={props.workspaceId}
          onClose={() => setOpen(false)}
          onManualEntry={() => setManualOpen(true)}
        />
      ) : null}
      {manualOpen ? (
        <ManualAttachForm
          workspaceId={props.workspaceId}
          onCancel={() => {
            setManualOpen(false);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function SearchPanel(props: { workspaceId: string; onClose: () => void; onManualEntry: () => void }) {
  const [draft, setDraft] = useState("");
  const debounced = useDebouncedValue(draft, SEARCH_DEBOUNCE_MS);
  const search = useJiraSearch(debounced);
  const attach = useAttachIssue(props.workspaceId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(-1);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setFocused(-1);
  }, []);

  const results = search.data?.results ?? [];
  const degraded = search.data?.status === "degraded";

  function selectIndex(index: number) {
    const item = results[index];
    if (!item) return;
    attach.mutate(
      { issueKey: item.key, issueTitle: item.summary, issueUrl: item.url },
      { onSuccess: () => props.onClose() },
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocused((prev) => Math.min(results.length - 1, prev + 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocused((prev) => Math.max(-1, prev - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const index = focused === -1 ? 0 : focused;
      selectIndex(index);
    }
  }

  return (
    <div className="cit-jira-picker" aria-label="Jira issue picker">
      <input
        ref={inputRef}
        className="cit-jira-picker-input"
        placeholder="Search issues or paste a key…"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label="Jira issue search"
      />
      <div className="cit-jira-picker-results">
        {search.isLoading && results.length === 0 ? (
          <div className="cit-jira-picker-empty">Searching…</div>
        ) : degraded ? (
          <div className="cit-jira-picker-empty cit-jira-picker-empty--degraded">
            Jira CLI unavailable — check Settings → Providers.
          </div>
        ) : results.length === 0 ? (
          <div className="cit-jira-picker-empty">
            {debounced.trim() ? "No matching issues." : "No recent issues to show."}
          </div>
        ) : (
          results.map((result, index) => (
            <button
              key={result.key}
              type="button"
              className={`cit-jira-picker-row${focused === index ? " cit-jira-picker-row--focused" : ""}`}
              onMouseEnter={() => setFocused(index)}
              onClick={() => selectIndex(index)}
              disabled={attach.isPending}
            >
              <span className="cit-jira-picker-key">{result.key}</span>
              {result.summary ? <span className="cit-jira-picker-summary">{result.summary}</span> : null}
              {result.status ? (
                <span className={`cit-jira-status cit-jira-status--${jiraStatusTone(result.status)}`}>
                  {result.status}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
      <div className="cit-jira-picker-footer">
        <button type="button" className="cit-jira-manual-link" onClick={props.onManualEntry}>
          Enter key manually
        </button>
      </div>
    </div>
  );
}

function ManualAttachForm(props: { workspaceId: string; onCancel: () => void }) {
  const [keyDraft, setKeyDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const attach = useAttachIssue(props.workspaceId);
  useEffect(() => {
    keyInputRef.current?.focus();
  }, []);
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = keyDraft.trim();
    if (!key) return;
    attach.mutate(
      { issueKey: key, issueTitle: null, issueUrl: urlDraft.trim() || null },
      { onSuccess: () => props.onCancel() },
    );
  }
  return (
    <form className="cit-jira-attach-form" onSubmit={onSubmit}>
      <label>
        Issue key
        <input
          ref={keyInputRef}
          value={keyDraft}
          onChange={(event) => setKeyDraft(event.target.value)}
          placeholder="ABC-123"
        />
      </label>
      <label>
        Issue URL (optional)
        <input
          value={urlDraft}
          onChange={(event) => setUrlDraft(event.target.value)}
          placeholder="https://jira.example/browse/ABC-123"
        />
      </label>
      <div className="cit-jira-attach-actions">
        <button type="button" onClick={props.onCancel} disabled={attach.isPending}>
          Cancel
        </button>
        <button type="submit" data-primary disabled={!keyDraft.trim() || attach.isPending}>
          {attach.isPending ? "Attaching…" : "Attach"}
        </button>
      </div>
    </form>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useJiraSearch(query: string) {
  return useQuery<IssueSearchResponse>({
    queryKey: ["jira-search", query],
    queryFn: () =>
      api<IssueSearchResponse>(`/api/integrations/jira/search${query ? `?q=${encodeURIComponent(query)}` : ""}`),
    staleTime: SEARCH_STALE_MS,
  });
}

function useAttachIssue(workspaceId: string) {
  return useMutation({
    mutationFn: (input: { issueKey: string; issueTitle: string | null; issueUrl: string | null }) =>
      api(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          issueKey: input.issueKey,
          issueTitle: input.issueTitle,
          issueUrl: input.issueUrl,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: COCKPIT_SUMMARY_QUERY(workspaceId) });
    },
  });
}

function useUnattachIssue(workspaceId: string) {
  return useMutation({
    mutationFn: () =>
      api(`/api/workspaces/${workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({ issueKey: null, issueTitle: null, issueUrl: null }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: COCKPIT_SUMMARY_QUERY(workspaceId) });
    },
  });
}

// Optimistic transition with cancelQueries-based rollback. cancelQueries
// before setQueryData prevents the optimistic → server-cached-old →
// server-fresh flicker that a background refetch would otherwise produce
// while the mutation is in flight.
function useTransitionIssue(workspaceId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { transition: string; toStatus: string }) =>
      api<{ result: IssueTransitionActionResult }>(`/api/workspaces/${workspaceId}/issue-transition`, {
        method: "POST",
        body: JSON.stringify({ transition: input.transition }),
      }),
    onMutate: async (next) => {
      await client.cancelQueries({ queryKey: COCKPIT_SUMMARY_QUERY(workspaceId) });
      const previous = client.getQueryData<WorkspaceCockpitSummary>(COCKPIT_SUMMARY_QUERY(workspaceId));
      if (previous?.issueTracker) {
        client.setQueryData<WorkspaceCockpitSummary>(COCKPIT_SUMMARY_QUERY(workspaceId), {
          ...previous,
          issueTracker: { ...previous.issueTracker, issueStatus: next.toStatus },
        });
      }
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        client.setQueryData(COCKPIT_SUMMARY_QUERY(workspaceId), ctx.previous);
      }
    },
    onSuccess: (data, vars, ctx) => {
      // Degraded transitions return 424 → fetch throws → onError rolls back.
      // Healthy transitions land here; revert the optimistic value too if
      // the response itself reports degraded (the api helper may not throw
      // on 202+degraded JSON depending on shape).
      if (data?.result?.status === "degraded" && ctx?.previous) {
        client.setQueryData(COCKPIT_SUMMARY_QUERY(workspaceId), ctx.previous);
      }
    },
    onSettled: () => {
      client.invalidateQueries({ queryKey: COCKPIT_SUMMARY_QUERY(workspaceId) });
    },
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

// Exposed for tests that want to assert on the search-result shape produced
// by the hook layer without spinning up the full picker UI.
export type { IssueSearchResult };
