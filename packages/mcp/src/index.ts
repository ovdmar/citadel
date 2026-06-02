import type {
  ActivityEvent,
  AgentRuntime,
  AgentSession,
  Namespace,
  Operation,
  ProviderHealth,
  Repo,
  ScheduledAgent,
  Workspace,
  WorkspaceManager,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { AGENTS_SYSTEM_TOOL_DEFINITIONS } from "./agents-system-tools.js";
import { listWorkspaceLinks, serializeWorkspaceResource } from "./resources.js";
import { SCRATCHPAD_TOOL_DEFINITIONS, type ScratchpadToolName } from "./scratchpad-tools.js";

export { listWorkspaceLinks, serializeWorkspaceResource } from "./resources.js";

export type AgentSessionSummary = AgentSession & {
  namespaceId: string | null;
  namespaceName: string | null;
  initialPrompt: string | null;
  messageCount: number;
};

export type McpStatusSnapshot = {
  enabled: boolean;
  resources: string[];
  tools: string[];
};

export type McpToolName =
  | "inspect_status"
  | "list_repos"
  | "list_workspaces"
  | "list_agent_sessions"
  | "list_provider_health"
  | "list_agent_runtimes"
  | "list_runtimes"
  | "list_workspace_links"
  | "get_citadel_context"
  | "list_workspace_checkouts"
  | "create_workspace_checkout"
  | "register_workspace_plan"
  | "get_workspace_plan"
  | "report_plan_deviation"
  | "start_workspace_manager"
  | "pause_workspace_manager"
  | "resume_workspace_manager"
  | "mark_checkout_ready_for_review"
  | "register_checkout_review_artifact"
  | "get_checkout_ticket"
  | "get_checkout_pr"
  | "get_checkout_gate_status"
  | "update_ticket_status"
  | "launch_pm_agent"
  | "launch_architect_agent"
  | "launch_implementation_agent"
  | "launch_prototype_agent"
  | "register_repo"
  | "create_workspace"
  | "start_agent_session"
  | "launch_agent"
  | "stop_agent_session"
  | "archive_workspace"
  | "remove_workspace"
  | "reconcile"
  | "inspect_readiness"
  | "read_agent_output"
  | "send_agent_message"
  | "list_namespaces"
  | "create_namespace"
  | "update_namespace"
  | "archive_namespace"
  | "restore_namespace"
  | "assign_workspace_to_namespace"
  | ScratchpadToolName
  | "list_deployed_apps"
  | "redeploy_app"
  | "read_agent_history"
  | "list_scheduled_agents"
  | "create_scheduled_agent"
  | "update_scheduled_agent"
  | "delete_scheduled_agent"
  | "run_scheduled_agent_now"
  | "list_scheduled_agent_runs"
  | "read_scheduled_agent_run_log";

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
};

export type McpToolContext = {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activity: ActivityEvent[];
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  scheduledAgents?: ScheduledAgent[];
  checkouts?: WorktreeCheckout[];
  workspacePlanVersions?: WorkspacePlanVersion[];
  managers?: WorkspaceManager[];
  namespaces: Namespace[];
  sessionPromptSummary?: (sessionId: string) => { initialPrompt: string | null; messageCount: number };
  // Absolute path of the daemon's notes file. Surfaced through `inspect_status`
  // so MCP-using agents can discover the scratchpad location without a separate
  // `/api/config` round-trip. Required (non-optional) — leaving it optional
  // would make the `inspect_status.scratchpad` field sometimes-present and
  // weaken the discovery guarantee for MCP clients. The daemon-side constructor
  // populates it from `effectiveNotesPath(config)` in apps/daemon/src/daemon-mcp-tool.ts.
  scratchpadPath: string;
};

const INITIAL_PROMPT_PREVIEW_CHARS = 200;

export type McpToolCall = {
  name: McpToolName;
  arguments?: Record<string, unknown>;
};

export function mcpStatus(enabled: boolean): McpStatusSnapshot {
  return {
    enabled,
    resources: [
      "citadel://repos",
      "citadel://workspaces",
      "citadel://provider-health",
      "citadel://activity",
      "citadel://namespaces",
    ],
    tools: mcpToolDefinitions().map((tool) => tool.name),
  };
}

export function mcpToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "inspect_status",
      description:
        "Summarize Citadel local state and provider health. Includes `scratchpad.path` — the absolute filesystem path of the daemon's notes file — so agents can discover where notes live without a separate `/api/config` call.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_repos",
      description: "List registered repositories.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_workspaces",
      description:
        "List workspaces, optionally filtered by repoId or namespaceId. Each entry includes namespaceId and namespaceName when assigned.",
      inputSchema: {
        type: "object",
        properties: { repoId: { type: "string" }, namespaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_agent_sessions",
      description:
        "List agent sessions with status, runtime, namespace info (derived from the workspace), and tmux session metadata. Each entry includes a truncated initialPrompt and a messageCount so callers can see what the agent was asked to do and how much follow-up steering it has received. Use read_agent_history for the full text. Optionally filter by workspaceId or namespaceId.",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" }, namespaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "read_agent_output",
      description:
        "Read the latest terminal output (transcript) of a specific agent session. Bounded by lines and maxChars to avoid unbounded scrollback. Returns plain text captured from the backing tmux pane.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          lines: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
          maxChars: { type: "integer", minimum: 256, maximum: 200000, default: 16000 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "read_agent_history",
      description:
        "Read the ordered list of user-authored prompts sent to an agent session: the initial prompt that started it plus every follow-up sent via send_agent_message. For Claude Code sessions, the .jsonl transcript is parsed on demand and merged in so messages typed directly in the terminal are included. Limit and maxChars cap the returned slice; older messages are dropped first.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
          maxChars: { type: "integer", minimum: 256, maximum: 1000000, default: 64000 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "send_agent_message",
      description:
        "Send a follow-up message/prompt to an existing agent session. Targets the session id and submits the text into the backing tmux pane (paste + Enter), so it works for Claude Code and other interactive runtimes. Returns an error if the session has no terminal or is not accepting input.",
      inputSchema: {
        type: "object",
        required: ["sessionId", "message"],
        properties: {
          sessionId: { type: "string" },
          message: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_provider_health",
      description: "List normalized provider health snapshots.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_agent_runtimes",
      description: "List configured agent runtimes and their health.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_workspace_links",
      description: "List hook-provided workspace links and actions, optionally filtered by workspaceId.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" } }, additionalProperties: false },
      destructive: false,
    },
    ...AGENTS_SYSTEM_TOOL_DEFINITIONS,
    {
      name: "register_repo",
      description:
        "Register an existing local git repository with Citadel so it appears in list_repos and can host workspaces. Provide the absolute rootPath of a directory containing a .git folder. Optionally override the display name and worktreeParent (defaults to Citadel's dataDir/worktrees/<repo>). Also creates the non-removable root workspace pointing at the repo working copy. Returns { repo }.",
      inputSchema: {
        type: "object",
        required: ["rootPath"],
        properties: {
          rootPath: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          worktreeParent: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "create_workspace",
      description:
        "Create a workspace through the daemon operation service. Pass namespaceId to drop the new workspace into an existing namespace (used by orchestrator agents that spawn N sub-agents under one epic).",
      inputSchema: {
        type: "object",
        required: ["repoId", "name"],
        properties: {
          repoId: { type: "string" },
          name: { type: "string" },
          source: { type: "string" },
          issueKey: { type: "string" },
          issueTitle: { type: "string" },
          prUrl: { type: "string" },
          namespaceId: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "start_agent_session",
      description:
        "Start a configured agent runtime in a workspace through the daemon operation service. If namespaceId is provided, the workspace is reassigned to that namespace as a side effect (assignment-on-launch).",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "runtimeId"],
        properties: {
          workspaceId: { type: "string" },
          runtimeId: { type: "string" },
          displayName: { type: "string" },
          prompt: { type: "string" },
          namespaceId: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_namespaces",
      description:
        "List namespaces (organizational groupings for workspaces, typically one per Jira epic / topic spanning multiple repos). Pass includeArchived=true to include archived namespaces.",
      inputSchema: {
        type: "object",
        properties: { includeArchived: { type: "boolean" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "create_namespace",
      description:
        "Create a namespace so a main agent can group the sub-workspaces it spawns. Returns the namespace id to pass to create_workspace/start_agent_session.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "assign_workspace_to_namespace",
      description:
        "Move an existing workspace into a namespace (or pass namespaceId=null to unassign). Both arguments are required: pass namespaceId=null explicitly to detach. Use after the fact when a workspace should join a topic that did not exist when it was created.",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "namespaceId"],
        properties: {
          workspaceId: { type: "string" },
          namespaceId: { type: ["string", "null"] },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "update_namespace",
      description:
        "Rename a namespace and/or change its color. At least one of name/color must be provided. Active namespaces only — to edit an archived one, restore it first.",
      inputSchema: {
        type: "object",
        required: ["namespaceId"],
        properties: {
          namespaceId: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 80 },
          color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "archive_namespace",
      description:
        "Soft-archive a namespace. Workspaces stay assigned but the namespace is hidden from the default list_namespaces view. Pass includeArchived=true to list_namespaces to see archived entries. Reversible with restore_namespace.",
      inputSchema: {
        type: "object",
        required: ["namespaceId"],
        properties: { namespaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "restore_namespace",
      description: "Unarchive a previously archived namespace. The name UNIQUE constraint reactivates the row.",
      inputSchema: {
        type: "object",
        required: ["namespaceId"],
        properties: { namespaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "launch_agent",
      description:
        "High-level one-shot: create a fresh scratch workspace in a repo and immediately start an agent session in it with the given prompt. Returns { workspaceId, sessionId, branchName, workspacePath, operationId }. Use this instead of chaining create_workspace + start_agent_session when an orchestrator just wants 'run this prompt in repo X'. Pass exactly one of repoId or repoName; runtimeId defaults to claude-code. If namespaceId is provided, the new workspace is assigned to that namespace at creation (so it groups with sibling sub-agents under one topic).",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          repoId: { type: "string", description: "Internal repo id (provide this OR repoName)." },
          repoName: { type: "string", description: "Configured repo display name (provide this OR repoId)." },
          prompt: { type: "string", minLength: 1 },
          runtimeId: { type: "string", default: "claude-code" },
          displayName: { type: "string", maxLength: 80 },
          workspaceName: { type: "string", maxLength: 80 },
          namespaceId: { type: "string", maxLength: 80 },
          branchName: { type: "string", maxLength: 120 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "archive_workspace",
      description: "Archive workspace metadata without deleting the worktree.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "stop_agent_session",
      description: "Stop a running agent session via the operation service.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: { sessionId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "remove_workspace",
      description:
        "Remove a workspace through the operation service. Set archiveOnly to keep the worktree, force to override dirty/teardown protection.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          archiveOnly: { type: "boolean" },
          force: { type: "boolean" },
        },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "reconcile",
      description: "Reconcile local state with reality: cleanup orphan sessions, ghost repos, and missing worktrees.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: true,
    },
    ...SCRATCHPAD_TOOL_DEFINITIONS,
    {
      name: "list_deployed_apps",
      description:
        "List the deployed apps for a workspace by invoking its deploy hook (`<hook> list`) and probing each app's URL for reachability. Resolves the hook in this order: `<workspacePath>/.citadel/hooks/deploy` (if executable) > the repo's deployHookCommand. Returns { workspaceId, resolution: { source, filePath?, command? }, apps: [{ name, url, status: 'deployed'|'stopped'|'unknown', lastChecked }], error?, checkedAt }. `source` is 'none' when no deploy hook is configured.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "redeploy_app",
      description:
        "Invoke the workspace's deploy hook with `redeploy [name]`. Omitting `name` redeploys all apps. The hook runs with cwd = workspace path and env CITADEL_WORKSPACE_ID/CITADEL_WORKSPACE_PATH/CITADEL_WORKSPACE_BRANCH/CITADEL_REPO_ID set. Returns { operationId, status, exitStatus } — stream the operation log via /api/operations/:id for live output.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          name: {
            type: "string",
            maxLength: 80,
            description: "App name from list_deployed_apps. Omit to redeploy all.",
          },
        },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "list_scheduled_agents",
      description:
        "List all configured scheduled agents. Each entry includes cron, repo, runtime, workspace strategy, enabled flag, and the last run status/timestamp.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "create_scheduled_agent",
      description:
        "Create a scheduled agent. scheduleType='recurring' (default) requires a 5-field cron expression. scheduleType='once' requires runAt (ISO 8601 with offset, e.g. 2026-05-23T09:00:00Z); one-shots auto-disable after firing. workspaceStrategy='new' creates a fresh workspace per run (workspaceName is a prefix; timestamp appended). workspaceStrategy='existing' reuses the workspace with the exact name. runMode='workspace' (default) keeps the current workspace-per-run behavior; runMode='background' runs the runtime in backgroundCwd (or repo.rootPath) without creating a workspace — intended for non-TUI scripts. overlapPolicy='skip' (default) drops fires that overlap an in-flight run; overlapPolicy='queue' enqueues up to 10 then drops with 'queue_full'. Returns { scheduledAgent }.",
      inputSchema: {
        type: "object",
        required: ["name", "repoId", "runtimeId", "workspaceStrategy", "workspaceName"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          description: { type: "string", maxLength: 280 },
          scheduleType: { type: "string", enum: ["recurring", "once"], default: "recurring" },
          cron: { type: "string", minLength: 1, maxLength: 120, description: "Five-field cron (recurring only)." },
          runAt: { type: "string", format: "date-time", description: "ISO 8601 timestamp (one-shot only)." },
          repoId: { type: "string" },
          runtimeId: { type: "string" },
          prompt: { type: "string", maxLength: 8000 },
          workspaceStrategy: { type: "string", enum: ["new", "existing"] },
          workspaceName: { type: "string", minLength: 1, maxLength: 80 },
          baseBranch: { type: "string", minLength: 1, maxLength: 120 },
          runMode: { type: "string", enum: ["workspace", "background"], default: "workspace" },
          backgroundCwd: {
            type: "string",
            minLength: 1,
            maxLength: 4000,
            description: "Absolute directory for runMode='background'. Defaults to the repo's rootPath at run time.",
          },
          overlapPolicy: { type: "string", enum: ["skip", "queue"], default: "skip" },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "update_scheduled_agent",
      description:
        "Patch fields of an existing scheduled agent. All non-id fields are optional; only those provided are changed. To convert a recurring agent into a one-shot, set scheduleType='once' and runAt; the previous cron is cleared. Switching runMode does NOT delete previously-created workspaces. Returns { scheduledAgent } or { error: 'scheduled_agent_not_found' }.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string", minLength: 1, maxLength: 80 },
          description: { type: "string", maxLength: 280 },
          scheduleType: { type: "string", enum: ["recurring", "once"] },
          cron: { type: "string", minLength: 1, maxLength: 120 },
          runAt: { type: "string", format: "date-time" },
          repoId: { type: "string" },
          runtimeId: { type: "string" },
          prompt: { type: "string", maxLength: 8000 },
          workspaceStrategy: { type: "string", enum: ["new", "existing"] },
          workspaceName: { type: "string", minLength: 1, maxLength: 80 },
          baseBranch: { type: "string", minLength: 1, maxLength: 120 },
          runMode: { type: "string", enum: ["workspace", "background"] },
          backgroundCwd: { type: "string", minLength: 1, maxLength: 4000 },
          overlapPolicy: { type: "string", enum: ["skip", "queue"] },
          enabled: { type: "boolean" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "delete_scheduled_agent",
      description:
        "Delete a scheduled agent. Cascades: kills any background tmux panes, deletes per-run log files on disk, removes scheduled_agent_runs + background_sessions rows, then deletes the agent. Returns { removed: true } or { error: 'scheduled_agent_not_found' } or { error: 'in_flight_run' } when a run is currently executing — wait for the run to finish or for the reconciler to terminate the orphan, then retry.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "run_scheduled_agent_now",
      description:
        "Trigger a single run of a scheduled agent immediately, regardless of cron. Behavior under overlap depends on the agent's overlapPolicy: with 'skip' returns { error: 'run_already_in_progress' } when in-flight; with 'queue' returns { queued: true, runId, queuePosition } (or { error: 'queue_full', limit: 10 } when the queue is full). When no run is in flight, returns { status, runId, message, workspaceId, sessionId, backgroundSessionId, scheduledAgent }.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_scheduled_agent_runs",
      description:
        "Return the run history for a scheduled agent, most recent first by enqueued_at. Each row includes status (queued|running|succeeded|failed), enqueuedAt, startedAt (null for queued), endedAt, message, the workspaceId/sessionId/backgroundSessionId of the spawn (when applicable), and logFilePath (populated for runs that produced a log). Pagination via limit (default 50, max 500) and offset.",
      inputSchema: {
        type: "object",
        required: ["scheduledAgentId"],
        properties: {
          scheduledAgentId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "read_scheduled_agent_run_log",
      description:
        "Read a byte slice of a scheduled-agent run's log file. Returns { content, bytesRead, nextOffset, truncated }. `content` is the UTF-8 decode of [offset, offset+maxBytes) bytes; `bytesRead` is the byte count consumed (NOT content.length — use it to compute nextOffset). Slice boundaries may split a UTF-8 codepoint or ANSI escape; re-fetching from offset=0 is always correct. 404-class errors come back as { error: 'run_not_found' | 'log_not_available' | 'log_file_missing' }.",
      inputSchema: {
        type: "object",
        required: ["runId"],
        properties: {
          runId: { type: "string" },
          offset: { type: "integer", minimum: 0, default: 0 },
          maxBytes: { type: "integer", minimum: 256, maximum: 200_000, default: 16_000 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "inspect_readiness",
      description: "Return the readiness state and next-action hint for a workspace.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
  ];
}

export function callMcpTool(call: McpToolCall, context: McpToolContext) {
  switch (call.name) {
    case "inspect_status":
      return {
        repos: context.repos.length,
        workspaces: context.workspaces.length,
        sessions: context.sessions.length,
        namespaces: context.namespaces.length,
        operations: context.operations.slice(0, 10),
        providerHealth: context.providerHealth,
        checkouts: context.checkouts?.length ?? 0,
        scratchpad: { path: context.scratchpadPath },
      };
    case "list_repos":
      return { repos: context.repos };
    case "list_workspaces": {
      const filtered = filterByRepo(context.workspaces, call.arguments?.repoId);
      const byNamespace = filterByNamespaceId(filtered, call.arguments?.namespaceId);
      return { workspaces: byNamespace.map((workspace) => annotateWorkspace(workspace, context.namespaces)) };
    }
    case "list_agent_sessions": {
      const filtered = filterByWorkspace(context.sessions, call.arguments?.workspaceId);
      const enriched = filtered.map((session) => annotateSession(session, context.workspaces, context.namespaces));
      const byNamespace =
        typeof call.arguments?.namespaceId === "string"
          ? enriched.filter((session) => session.namespaceId === call.arguments?.namespaceId)
          : enriched;
      const summarize = context.sessionPromptSummary;
      const sessions: AgentSessionSummary[] = byNamespace.map((session) => {
        const summary = summarize?.(session.id) ?? { initialPrompt: null, messageCount: 0 };
        return {
          ...session,
          initialPrompt: truncatePrompt(summary.initialPrompt),
          messageCount: summary.messageCount,
        };
      });
      return { sessions };
    }
    case "list_provider_health":
      return { providerHealth: context.providerHealth };
    case "list_scheduled_agents":
      return { scheduledAgents: context.scheduledAgents ?? [] };
    case "list_agent_runtimes":
    case "list_runtimes":
      return { runtimes: context.runtimes };
    case "list_workspace_links":
      return listWorkspaceLinks(context.activity, call.arguments?.workspaceId);
    case "list_workspace_checkouts": {
      if (!context.checkouts) return { error: "context_tool_requires_daemon" };
      const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
      return { checkouts: context.checkouts.filter((checkout) => checkout.workspaceId === workspaceId) };
    }
    case "get_workspace_plan": {
      if (!context.workspacePlanVersions) return { error: "context_tool_requires_daemon" };
      const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
      const planVersions = context.workspacePlanVersions.filter((plan) => plan.workspaceId === workspaceId);
      return {
        workspaceId,
        activePlan: planVersions.find((plan) => plan.active) ?? null,
        planVersions,
      };
    }
    case "get_checkout_ticket":
    case "get_checkout_pr":
    case "get_checkout_gate_status":
      return { error: "context_tool_requires_daemon" };
    case "list_namespaces": {
      // includeArchived from the daemon path is honored there; here we only
      // see the active snapshot the daemon serialized into context.namespaces.
      // When called against the snapshot, archived entries are simply absent.
      const includeArchived = call.arguments?.includeArchived === true;
      if (includeArchived) return { namespaces: context.namespaces, includeArchived: true };
      return { namespaces: context.namespaces.filter((entry) => !entry.archivedAt) };
    }
    case "inspect_readiness": {
      const workspaceId = typeof call.arguments?.workspaceId === "string" ? (call.arguments.workspaceId as string) : "";
      const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) return { error: "workspace_not_found", workspaceId };
      return {
        workspaceId,
        lifecycle: workspace.lifecycle,
        namespaceId: workspace.namespaceId ?? null,
        sessions: context.sessions
          .filter((session) => session.workspaceId === workspaceId)
          .map((session) => ({ id: session.id, status: session.status, runtimeId: session.runtimeId })),
        operations: context.operations.filter((operation) => operation.workspaceId === workspaceId).slice(0, 5),
      };
    }
    case "register_repo":
    case "create_workspace":
    case "create_workspace_checkout":
    case "register_workspace_plan":
    case "report_plan_deviation":
    case "start_workspace_manager":
    case "pause_workspace_manager":
    case "resume_workspace_manager":
    case "mark_checkout_ready_for_review":
    case "register_checkout_review_artifact":
    case "update_ticket_status":
    case "launch_pm_agent":
    case "launch_architect_agent":
    case "launch_implementation_agent":
    case "launch_prototype_agent":
    case "start_agent_session":
    case "launch_agent":
    case "stop_agent_session":
    case "archive_workspace":
    case "remove_workspace":
    case "reconcile":
    case "create_namespace":
    case "update_namespace":
    case "archive_namespace":
    case "restore_namespace":
    case "assign_workspace_to_namespace":
    case "write_scratchpad":
    case "append_scratchpad":
    case "list_deployed_apps":
    case "redeploy_app":
    case "create_scheduled_agent":
    case "update_scheduled_agent":
    case "delete_scheduled_agent":
    case "run_scheduled_agent_now":
      return { error: "mutating_tool_requires_daemon" };
    case "list_scheduled_agent_runs":
    case "read_scheduled_agent_run_log":
      return { error: "scheduled_agent_run_tool_requires_daemon" };
    case "get_citadel_context":
      return { error: "context_tool_requires_daemon" };
    case "read_agent_output":
    case "send_agent_message":
    case "read_agent_history":
      // These read or write the live tmux pane backing an agent session, so
      // they cannot run from the in-memory snapshot — only the daemon owns the
      // tmux/terminal manager. Return a stable sentinel so MCP transports can
      // route these to the daemon path explicitly.
      return { error: "session_tool_requires_daemon" };
    case "read_scratchpad":
    case "list_blocks":
    case "add_block":
    case "update_block":
    case "delete_block":
    case "fuzzy_search_scratchpad":
    case "refine_scratchpad":
      // The scratchpad lives on disk under the daemon's data dir; the snapshot
      // path has no fs access, so route through the daemon explicitly.
      return { error: "scratchpad_tool_requires_daemon" };
    default:
      return assertNever(call.name);
  }
}

function annotateWorkspace(workspace: Workspace, namespaces: Namespace[]) {
  const namespace = workspace.namespaceId ? namespaces.find((entry) => entry.id === workspace.namespaceId) : null;
  return { ...workspace, namespaceName: namespace?.name ?? null };
}

function annotateSession(session: AgentSession, workspaces: Workspace[], namespaces: Namespace[]) {
  const workspace = workspaces.find((entry) => entry.id === session.workspaceId) ?? null;
  const namespaceId = workspace?.namespaceId ?? null;
  const namespace = namespaceId ? namespaces.find((entry) => entry.id === namespaceId) : null;
  return { ...session, namespaceId, namespaceName: namespace?.name ?? null };
}

function filterByNamespaceId(workspaces: Workspace[], namespaceId: unknown) {
  if (typeof namespaceId !== "string") return workspaces;
  return workspaces.filter((workspace) => workspace.namespaceId === namespaceId);
}

function truncatePrompt(text: string | null) {
  if (!text) return null;
  if (text.length <= INITIAL_PROMPT_PREVIEW_CHARS) return text;
  return `${text.slice(0, INITIAL_PROMPT_PREVIEW_CHARS)}…`;
}

function filterByRepo(workspaces: Workspace[], repoId: unknown) {
  return typeof repoId === "string" ? workspaces.filter((workspace) => workspace.repoId === repoId) : workspaces;
}

function filterByWorkspace(sessions: AgentSession[], workspaceId: unknown) {
  return typeof workspaceId === "string" ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions;
}

function assertNever(value: never): never {
  throw new Error(`Unknown MCP tool: ${String(value)}`);
}
