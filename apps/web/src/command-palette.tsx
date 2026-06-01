import type { Workspace } from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ClipboardList, GitBranch, GitPullRequest, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatLabel } from "./labels.js";
import { useOverlayPresent } from "./use-overlay-present.js";

export type CommandPaletteProps = {
  workspaces: Workspace[];
  repoNames: Record<string, string>;
  workspaceMeta: Record<
    string,
    {
      readiness?: string;
      prTone?: string;
      prNumber?: number | null;
      attention?: string;
    }
  >;
  onClose: () => void;
  onPickWorkspace: (workspace: Workspace) => void;
  onNavigate: (path: string) => void;
};

type Hit = {
  type: "workspace";
  workspace: Workspace;
  score: number;
  hint: string;
};

export function CommandPalette(props: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useOverlayPresent();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<Hit[]>(() => {
    const haystack = props.workspaces.map((workspace) => {
      const repoName = workspace.repoId ? (props.repoNames[workspace.repoId] ?? "") : "";
      const meta = props.workspaceMeta[workspace.id] ?? {};
      const tokens = [
        workspace.name,
        workspace.branch,
        workspace.issueKey ?? "",
        workspace.issueTitle ?? "",
        workspace.prUrl ?? "",
        repoName,
        meta.readiness ?? "",
      ]
        .filter(Boolean)
        .map((token) => token.toLowerCase());
      return { workspace, tokens, repoName, meta };
    });
    if (!query.trim()) {
      return haystack.slice(0, 12).map(({ workspace, repoName, meta }) => ({
        type: "workspace" as const,
        workspace,
        score: 0,
        hint: hintFor(repoName, meta, workspace),
      }));
    }
    const needle = query.toLowerCase();
    const scored: Hit[] = [];
    for (const candidate of haystack) {
      const score = fuzzyScore(needle, candidate.tokens);
      if (score > 0) {
        scored.push({
          type: "workspace",
          workspace: candidate.workspace,
          score,
          hint: hintFor(candidate.repoName, candidate.meta, candidate.workspace),
        });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 12);
  }, [props.workspaces, props.repoNames, props.workspaceMeta, query]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: only reset when number of hits changes
  useEffect(() => {
    setFocused(0);
  }, [results.length]);

  const commands = useMemo(
    () =>
      [
        { id: "settings", label: "Open Settings", icon: <Settings size={14} />, target: "/settings" },
        { id: "operations", label: "Open Operations", icon: <ClipboardList size={14} />, target: "/operations" },
        { id: "history", label: "Open History", icon: <GitPullRequest size={14} />, target: "/history" },
        { id: "dashboard", label: "Open Dashboard", icon: <GitBranch size={14} />, target: "/dashboard" },
        { id: "onboarding", label: "Open Onboarding", icon: <ArrowRight size={14} />, target: "/onboarding" },
      ].filter((command) => !query || command.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const total = results.length + commands.length;

  const select = (index: number) => {
    const hit = results[index];
    if (index < results.length && hit) {
      props.onPickWorkspace(hit.workspace);
    } else {
      const command = commands[index - results.length];
      if (command) props.onNavigate(command.target);
    }
  };

  return (
    <div
      className="command-backdrop"
      role="presentation"
      onMouseDown={props.onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") props.onClose();
      }}
    >
      <dialog
        className="command-palette"
        open
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setFocused((current) => Math.min(current + 1, Math.max(total - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setFocused((current) => Math.max(current - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            select(focused);
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
      >
        <div className="command-search-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces by title, branch, issue, PR, repo, or status"
            aria-label="Search workspaces"
          />
          <kbd className="cit-kbd">Esc</kbd>
        </div>
        <div className="command-results">
          {results.length ? <div className="command-section-label">Workspaces</div> : null}
          {results.map((hit, index) => (
            <button
              key={hit.workspace.id}
              type="button"
              className={`command-result ${focused === index ? "focused" : ""}`}
              onMouseEnter={() => setFocused(index)}
              onClick={() => select(index)}
            >
              <GitBranch size={14} />
              <span>
                <strong>{hit.workspace.name}</strong>
                <span className="command-result-meta">{hit.hint}</span>
              </span>
              <span className="command-result-hint">
                {hit.workspace.repoId ? (props.repoNames[hit.workspace.repoId] ?? "") : ""}
              </span>
            </button>
          ))}
          {!results.length && query.trim() ? (
            <div className="empty compact">
              No matching workspaces. Try a different keyword or open a command below.
            </div>
          ) : null}
          {commands.length ? <div className="command-section-label">Go to</div> : null}
          {commands.map((command, index) => (
            <button
              key={command.id}
              type="button"
              className={`command-result ${focused === results.length + index ? "focused" : ""}`}
              onMouseEnter={() => setFocused(results.length + index)}
              onClick={() => select(results.length + index)}
            >
              {command.icon}
              <span>
                <strong>{command.label}</strong>
                <span className="command-result-meta">{command.target}</span>
              </span>
              <Link to={command.target} className="command-result-hint">
                Open
              </Link>
            </button>
          ))}
        </div>
      </dialog>
    </div>
  );
}

function hintFor(
  repoName: string,
  meta: { readiness?: string; prTone?: string; prNumber?: number | null; attention?: string },
  workspace: Workspace,
) {
  const parts = [repoName, workspace.branch];
  if (workspace.issueKey) parts.push(workspace.issueKey);
  if (typeof meta.prNumber === "number") parts.push(`PR #${meta.prNumber}`);
  if (meta.readiness) parts.push(formatLabel(meta.readiness));
  return parts.filter(Boolean).join(" · ");
}

function fuzzyScore(needle: string, tokens: string[]) {
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (token === needle) score += 50;
    else if (token.startsWith(needle)) score += 20;
    else if (token.includes(needle)) score += 8;
    else {
      let n = 0;
      for (const character of token) {
        if (character === needle[n]) {
          n += 1;
          if (n === needle.length) {
            score += 3;
            break;
          }
        }
      }
    }
  }
  return score;
}
