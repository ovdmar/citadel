import type { AgentRuntime, Namespace, Repo, RoleTemplate, Workspace } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { type GroupKey, type NavigatorGrouping, normalizeNavigatorGrouping } from "./navigator-groups.js";
import { defaultAgentRuntimeId } from "./runtime-defaults.js";
import { useToast } from "./toast.js";
import { useOverlayPresent } from "./use-overlay-present.js";

const GROUP_BY_OPTIONS: Array<{ id: GroupKey; label: string; hint: string }> = [
  { id: "workspace", label: "Workspace", hint: "workspace → worktrees" },
  { id: "repo", label: "Repository", hint: "citadel · skills · …" },
  { id: "status", label: "Status", hint: "running · review · idle" },
  { id: "namespace", label: "Namespace", hint: "demo · platform · uncategorized" },
];

type GroupByMenuProps = {
  value: NavigatorGrouping;
  onChange: (next: NavigatorGrouping) => void;
  onClose: () => void;
  // When provided, the click-outside check uses this container instead of
  // the menu's inner ref. The wrapping container in the navigator includes
  // BOTH the menu and its trigger button, so clicking the trigger doesn't
  // fire onClose just before the trigger's own onClick toggles state back
  // on (the bug the user reported as "doesn't close when clicking outside").
  containerRef?: { current: HTMLElement | null };
};

export function GroupByMenu(props: GroupByMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Re-read on every event from the ref objects, not from the props closure,
  // so the listener installs once. Capturing props in the effect deps caused
  // the effect to re-run every render (props is a fresh object identity).
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const containerRefProp = props.containerRef;
  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const container = containerRefProp?.current ?? ref.current;
      if (container && !container.contains(target)) onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [containerRefProp]);
  return (
    <div ref={ref} className="cit-gb-menu" role="menu" aria-label="Group worktrees">
      <div className="cit-gb-menu-head">Group worktrees by</div>
      {GROUP_BY_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={props.value.includes(option.id)}
          className={`cit-gb-opt ${props.value.includes(option.id) ? "is-active" : ""}`}
          onClick={() => props.onChange(nextGroupingSelection(props.value, option.id))}
        >
          <span className="cit-gb-opt-check">{props.value.includes(option.id) ? <Check size={11} /> : null}</span>
          <span className="cit-gb-opt-text">
            <span className="cit-gb-opt-label">{option.label}</span>
            <span className="cit-gb-opt-hint">{option.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function nextGroupingSelection(current: NavigatorGrouping, option: GroupKey): NavigatorGrouping {
  const selected = current.includes(option);
  if (selected) {
    const next = current.filter((key) => key !== option);
    return normalizeNavigatorGrouping(next.length ? next : ["workspace"]);
  }
  if (option === "workspace") {
    return normalizeNavigatorGrouping([...current.filter((key) => key === "namespace"), "workspace"]);
  }
  if (option === "namespace") {
    return normalizeNavigatorGrouping(["namespace", "workspace"]);
  }
  const next = current.filter((key) => key !== "workspace");
  next.push(option);
  return normalizeNavigatorGrouping(next);
}

type CreateWorkspaceModalProps = {
  repos: Repo[];
  lastRepoId?: string;
  runtimes: AgentRuntime[];
  namespaces?: Namespace[];
  onClose: () => void;
  onCreated: (workspaceId: string) => void;
};

type LinkedContext = {
  source: "scratch" | "issue" | "pr";
  issueKey?: string;
  issueUrl?: string;
  prUrl?: string;
  slackThreadUrl?: string;
};

type WorkspaceLaunchMode = "pm" | "prototype" | "freestyle";

const JIRA_KEY_FROM_URL = /\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const JIRA_KEY_BARE = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_PR_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;
const SLACK_URL = /^https?:\/\/[a-z0-9.-]*slack\.com\//i;
const WORKSPACE_READY_POLL_MS = 1000;
const WORKSPACE_READY_MAX_ATTEMPTS = 180;

// Parse the freeform "link" field — Jira issue, GitHub PR, or Slack thread —
// into the structured fields the workspace API expects. Returning a `source`
// here is what flips workspaceBranchName into JIRA-style branch generation.
function parseLinkedContext(input: string): LinkedContext {
  const value = input.trim();
  if (!value) return { source: "scratch" };
  const jiraUrl = value.match(JIRA_KEY_FROM_URL);
  if (jiraUrl?.[1]) return { source: "issue", issueKey: jiraUrl[1].toUpperCase(), issueUrl: value };
  if (JIRA_KEY_BARE.test(value)) return { source: "issue", issueKey: value.toUpperCase() };
  if (GITHUB_PR_URL.test(value)) return { source: "pr", prUrl: value };
  if (SLACK_URL.test(value)) return { source: "scratch", slackThreadUrl: value };
  return { source: "scratch" };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

// Mirror packages/core's workspaceBranchName so we can preview the branch the
// daemon will create without round-tripping. Keep in sync if that helper moves.
function defaultBranchPreview(linked: LinkedContext, name: string): string {
  if (linked.source === "issue" && linked.issueKey) return linked.issueKey;
  const slug = slugify(name);
  return slug || "workspace";
}

// Hint shown in the modal's name input placeholder. For scratch workspaces
// the daemon generates a memorable funny-name (e.g. funny-cat) when none
// is provided, so the placeholder telegraphs that. For issue-linked
// workspaces the placeholder shows the derived name (issue key lowercased).
function defaultNameHint(linked: LinkedContext): string {
  if (linked.source === "issue" && linked.issueKey) return linked.issueKey.toLowerCase();
  return "e.g. funny-cat (auto)";
}

// Effective name to send to the daemon when the user leaves the field
// blank. Empty string lets the daemon generate. Issue-linked workspaces
// still derive from the issue key client-side to keep branch preview
// accurate.
function defaultNameForSubmit(linked: LinkedContext): string {
  if (linked.source === "issue" && linked.issueKey) return linked.issueKey.toLowerCase();
  return "";
}

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  useOverlayPresent();
  const toast = useToast();
  const initialRepo = props.repos.find((repo) => repo.id === props.lastRepoId)?.id ?? props.repos[0]?.id ?? "";
  const [launchMode, setLaunchMode] = useState<WorkspaceLaunchMode>("pm");
  const [repoId, setRepoId] = useState(initialRepo);
  const [prompt, setPrompt] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [namespaceId, setNamespaceId] = useState("");

  const launchableRuntimes = useMemo(
    () => props.runtimes.filter((runtime) => runtime.health === "healthy"),
    [props.runtimes],
  );
  const defaultRuntimeId = useMemo(() => defaultAgentRuntimeId(props.runtimes), [props.runtimes]);
  const [runtimeId, setRuntimeId] = useState(defaultRuntimeId);
  useEffect(() => {
    if (!runtimeId && defaultRuntimeId) setRuntimeId(defaultRuntimeId);
  }, [defaultRuntimeId, runtimeId]);

  const agentTemplates = useQuery({
    queryKey: ["agent-templates"],
    queryFn: () => api<{ roles: RoleTemplate[] }>("/api/agent-templates"),
    staleTime: 30_000,
  });
  const prototypeTemplate = agentTemplates.data?.roles.find((role) => role.role === "prototype") ?? null;

  const linked = useMemo(() => parseLinkedContext(linkInput), [linkInput]);
  const namePreview = defaultNameHint(linked);
  // Branch preview: when the user has neither typed a name nor attached
  // an issue, the daemon will generate the name (and the branch name
  // follows from it), so we can't honestly preview either. Show
  // `<auto>` in that case rather than fabricating "workspace" — which
  // the user never typed and the daemon won't use.
  const trimmedName = name.trim();
  const submitName = defaultNameForSubmit(linked);
  const branchPreview = trimmedName || submitName ? defaultBranchPreview(linked, trimmedName || submitName) : "<auto>";

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const create = useMutation({
    mutationFn: async () => {
      if (launchMode === "pm") {
        const result = await api<{
          result: { ok?: boolean; workspaceId?: string; error?: string; detail?: string };
        }>("/api/mcp/tools/call", {
          method: "POST",
          body: JSON.stringify({
            name: "launch_pm_agent",
            arguments: {
              idea: prompt.trim() || undefined,
              workspaceName: name.trim() || undefined,
              ...(linked.source === "issue" && linked.issueKey
                ? {
                    parentIssue: {
                      provider: "jira",
                      key: linked.issueKey,
                      url: linked.issueUrl ?? null,
                      title: null,
                      status: null,
                      fetchedAt: null,
                    },
                  }
                : {}),
            },
          }),
        });
        if (result.result.error || result.result.ok === false || !result.result.workspaceId) {
          throw new Error(result.result.detail ?? result.result.error ?? "pm_launch_failed");
        }
        return { workspaceId: result.result.workspaceId };
      }

      const trimmed = name.trim();
      const payload: Record<string, unknown> = {
        repoId,
        // Empty string signals "daemon should generate a funny-name". The
        // issue-linked path still sends the issue-key-lowercased default
        // for backwards-compatible branch-name derivation.
        name: trimmed || defaultNameForSubmit(linked),
        source: linked.source,
      };
      if (linked.issueKey) payload.issueKey = linked.issueKey;
      if (linked.issueUrl) payload.issueUrl = linked.issueUrl;
      if (linked.prUrl) payload.prUrl = linked.prUrl;
      if (linked.slackThreadUrl) payload.slackThreadUrl = linked.slackThreadUrl;
      const customBranch = branch.trim();
      if (customBranch) payload.existingBranch = customBranch;
      if (namespaceId) payload.namespaceId = namespaceId;
      const result = await api<{ workspaceId: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (launchMode === "prototype") {
        if (!prototypeTemplate) throw new Error("prototype_template_unavailable");
        void launchRoleWhenWorkspaceReady(result.workspaceId, prototypeTemplate, prompt.trim()).catch((error) => {
          toast.push({
            tone: "error",
            message: `Prototype launch failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        });
      } else if (runtimeId) {
        void launchAgentWhenWorkspaceReady(result.workspaceId, runtimeId, prompt.trim()).catch((error) => {
          toast.push({
            tone: "error",
            message: `Agent launch failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        });
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onCreated(result.workspaceId);
    },
    onError: (err) => {
      toast.push({
        tone: "error",
        message: `Workspace creation failed: ${err instanceof Error ? err.message : "create_failed"}`,
      });
    },
  });

  const linkBadge =
    linked.source === "issue"
      ? `Linked Jira: ${linked.issueKey}`
      : linked.source === "pr"
        ? "Linked GitHub PR"
        : linked.slackThreadUrl
          ? "Linked Slack thread"
          : "";

  return (
    <Modal title="New workspace" onClose={props.onClose}>
      <div className="modal-form workspace-modal">
        <label className="workspace-modal-prompt">
          Initial prompt
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the agent do? (optional — leave empty to start the agent with no instructions)"
            rows={4}
          />
        </label>
        <div className="workspace-modal-row">
          <label>
            Mode
            <select value={launchMode} onChange={(event) => setLaunchMode(event.target.value as WorkspaceLaunchMode)}>
              <option value="pm">PM</option>
              <option value="prototype">Prototype</option>
              <option value="freestyle">Freestyle</option>
            </select>
          </label>
          {launchMode === "freestyle" ? (
            <label>
              Agent
              <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
                <option value="">No agent — workspace only</option>
                {launchableRuntimes.map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>
                    {runtime.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {launchMode === "pm" ? null : (
          <div className="workspace-modal-row">
            <label>
              Repository
              <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
                {props.repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {launchMode !== "pm" && props.namespaces?.length ? (
          <label>
            Namespace
            <select value={namespaceId} onChange={(event) => setNamespaceId(event.target.value)}>
              <option value="">Uncategorized</option>
              {props.namespaces.map((namespace) => (
                <option key={namespace.id} value={namespace.id}>
                  {namespace.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <details className="workspace-modal-advanced">
          <summary>Optional: link, name, branch</summary>
          <label>
            Link Jira / GitHub PR / Slack URL
            <input
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder="ABC-123, https://…/browse/ABC-123, github.com/x/y/pull/42, or slack.com/…"
            />
            {linkBadge ? <span className="workspace-modal-badge">{linkBadge}</span> : null}
          </label>
          <div className="workspace-modal-row">
            <label>
              Workspace name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`Defaults to ${namePreview}`}
              />
            </label>
            {launchMode === "pm" ? null : (
              <label>
                Branch
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder={`Defaults to ${branchPreview}`}
                />
              </label>
            )}
          </div>
        </details>
        {launchMode === "freestyle" && !launchableRuntimes.length ? (
          <div className="empty compact">
            No healthy agents configured. The workspace will be created without launching one.
          </div>
        ) : null}
      </div>
      <div className="modal-footer">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            create.isPending || (launchMode !== "pm" && !repoId) || (launchMode === "prototype" && !prototypeTemplate)
          }
          onClick={() => {
            create.mutate();
            props.onClose();
          }}
        >
          {create.isPending
            ? "Creating…"
            : launchMode === "pm"
              ? "Create & launch PM"
              : launchMode === "prototype"
                ? "Create & launch Prototype"
                : runtimeId
                  ? "Create & launch agent"
                  : "Create workspace"}
        </Button>
      </div>
    </Modal>
  );
}

async function launchAgentWhenWorkspaceReady(workspaceId: string, runtimeId: string, prompt: string) {
  for (let attempt = 0; attempt < WORKSPACE_READY_MAX_ATTEMPTS; attempt += 1) {
    const state = await api<{ workspaces: Array<Pick<Workspace, "id" | "lifecycle">> }>("/api/workspaces");
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (workspace?.lifecycle === "ready") {
      const sessionPayload: Record<string, unknown> = { workspaceId, runtimeId };
      if (prompt) sessionPayload.prompt = prompt;
      await api("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify(sessionPayload),
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
      return;
    }
    if (workspace?.lifecycle === "failed") throw new Error("workspace_setup_failed");
    await new Promise((resolve) => window.setTimeout(resolve, WORKSPACE_READY_POLL_MS));
  }
  throw new Error("workspace_setup_timeout");
}

async function launchRoleWhenWorkspaceReady(workspaceId: string, template: RoleTemplate, prompt: string) {
  for (let attempt = 0; attempt < WORKSPACE_READY_MAX_ATTEMPTS; attempt += 1) {
    const state = await api<{ workspaces: Array<Pick<Workspace, "id" | "lifecycle">> }>("/api/workspaces");
    const workspace = state.workspaces.find((entry) => entry.id === workspaceId);
    if (workspace?.lifecycle === "ready") {
      await api("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({
          workspaceId,
          runtimeId: template.launchSettings.runtimeId,
          displayName: template.displayName,
          prompt: [template.systemPrompt, prompt || null].filter(Boolean).join("\n\n"),
          role: template.role,
          managed: true,
          launchSettings: template.launchSettings,
        }),
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
      return;
    }
    if (workspace?.lifecycle === "failed") throw new Error("workspace_setup_failed");
    await new Promise((resolve) => window.setTimeout(resolve, WORKSPACE_READY_POLL_MS));
  }
  throw new Error("workspace_setup_timeout");
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <dialog open className="modal-frame" aria-label={props.title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <Search size={14} aria-hidden />
          <h2>{props.title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="modal-body">{props.children}</div>
      </dialog>
    </div>
  );
}
