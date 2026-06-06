// @vitest-environment happy-dom

import type {
  AgentRuntime,
  AgentSession,
  RoleTemplate,
  TerminalProfile,
  TerminalSession,
  Workspace,
} from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "./api.js";

vi.mock("./terminal-pane.js", async () => {
  const react = await import("react");
  return {
    TerminalPane: (props: { session: { id: string }; active: boolean }) =>
      react.createElement("div", { "data-active": props.active, "data-session-id": props.session.id }),
    getTerminalHandle: vi.fn(() => null),
  };
});

import { buildStageLaunchEntryGroups, freestyleStageActions, structuredStageActions } from "./stage-launch-actions.js";
import {
  Stage,
  applyPendingReloadSessions,
  retainRecentTerminalIds,
  stableVisitedSessions,
  stableWorkspaceSessionIdsKey,
  stageTabIdentity,
} from "./stage.js";

const roots: Root[] = [];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  installLocalStorageMock();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(jsonResponse({ roles: [] }))),
  );
});

afterEach(async () => {
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  queryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Stage terminal pane ordering", () => {
  it("keeps visited terminal panes in visit order when state polling reorders sessions", () => {
    const first = sessionFixture({ id: "sess_a", tabId: "tab_a", updatedAt: "2026-05-28T20:00:00.000Z" });
    const second = sessionFixture({ id: "sess_b", tabId: "tab_b", updatedAt: "2026-05-28T20:00:05.000Z" });
    const visited = new Set(["sess_a", "sess_b"]);

    expect(stableVisitedSessions([second, first], visited).map((session) => session.id)).toEqual(["sess_a", "sess_b"]);
    expect(stableVisitedSessions([first, second], visited).map((session) => session.id)).toEqual(["sess_a", "sess_b"]);
  });

  it("keys terminal recovery from tab order, not updated-at order", () => {
    const first = sessionFixture({ id: "sess_a", tabId: "tab_a", updatedAt: "2026-05-28T20:00:00.000Z" });
    const second = sessionFixture({ id: "sess_b", tabId: "tab_b", updatedAt: "2026-05-28T20:00:05.000Z" });

    expect(stableWorkspaceSessionIdsKey([second, first])).toBe(stableWorkspaceSessionIdsKey([first, second]));
  });

  it("uses stable tab ids for reload replacements", () => {
    const source = agentSessionFixture({ id: "sess_source", tabId: "tab_stable" });
    const replacement = agentSessionFixture({ id: "sess_reloaded", tabId: "tab_stable" });

    expect(stageTabIdentity(replacement)).toBe("tab_stable");
    expect(applyPendingReloadSessions([source], { [source.id]: { source, replacement } })).toEqual([replacement]);
  });

  it("retains only the five most recently visited terminal panes", () => {
    const visited = new Set(["sess_a", "sess_b", "sess_c", "sess_d", "sess_e", "sess_f"]);
    const live = new Set(visited);

    expect([...retainRecentTerminalIds(visited, "sess_b", live)]).toEqual([
      "sess_c",
      "sess_d",
      "sess_e",
      "sess_f",
      "sess_b",
    ]);
  });

  it("drops sessions that no longer exist before applying the LRU cap", () => {
    const visited = new Set(["sess_a", "sess_b", "sess_c", "sess_d", "sess_e", "sess_f"]);
    const live = new Set(["sess_b", "sess_d", "sess_e", "sess_f"]);

    expect([...retainRecentTerminalIds(visited, "sess_b", live)]).toEqual(["sess_d", "sess_e", "sess_f", "sess_b"]);
  });

  it("offers structured Home roles on Home and checkout roles on checkouts", () => {
    const workspace = workspaceFixture({ mode: "structured" });

    expect(
      structuredStageActions({ workspace, targetType: "workspace_home", checkoutId: null }).map((action) => [
        action.label,
        action.toolName,
      ]),
    ).toEqual([
      ["PM", "launch_pm_agent"],
      ["Architect", "launch_architect_agent"],
      ["Manager", "start_workspace_manager"],
    ]);
    expect(
      structuredStageActions({ workspace, targetType: "worktree_checkout", checkoutId: "co_1" }).map((action) => [
        action.label,
        action.arguments,
      ]),
    ).toEqual([
      ["Implementation", { checkoutId: "co_1" }],
      ["Prototype", { checkoutId: "co_1" }],
    ]);
  });

  it("keeps structured role actions out of freestyle workspaces", () => {
    expect(
      structuredStageActions({
        workspace: workspaceFixture({ mode: "freestyle" }),
        targetType: "workspace_home",
        checkoutId: null,
      }),
    ).toEqual([]);
  });

  it("offers PM and Prototype specialized actions for freestyle workspaces", () => {
    expect(
      freestyleStageActions({
        workspace: workspaceFixture({ mode: "freestyle" }),
        templates: [
          roleTemplate("pm", "PM"),
          roleTemplate("prototype", "Prototype"),
          roleTemplate("manager", "Manager"),
        ],
      }).map((action) => [action.id, action.label]),
    ).toEqual([
      ["pm", "PM"],
      ["prototype", "Prototype"],
    ]);
  });

  it("builds shared launch entries for the add menu and empty stage", () => {
    const groups = buildStageLaunchEntryGroups({
      structuredActions: structuredStageActions({
        workspace: workspaceFixture({ mode: "structured" }),
        targetType: "workspace_home",
        checkoutId: null,
      }),
      directRoleActions: [],
      terminal: terminalProfileFixture(),
      runtimes: [
        runtimeFixture({ id: "claude-code", displayName: "Claude Code", health: "healthy" }),
        runtimeFixture({
          id: "codex",
          displayName: "Codex",
          health: "unavailable",
          healthReason: "command missing",
        }),
      ],
      addDisabled: false,
      atSessionCap: false,
    });

    expect(
      groups.map((group) => [
        group.label,
        group.entries.map((entry) => [entry.type, entry.label, entry.disabled, entry.detail]),
      ]),
    ).toEqual([
      [
        "Specialized",
        [
          ["structured", "PM", false, null],
          ["structured", "Architect", false, null],
          ["structured", "Manager", false, null],
        ],
      ],
      [
        "Freestyle",
        [
          ["terminal", "Shell", false, null],
          ["runtime", "Claude Code", false, "healthy"],
          ["runtime", "Codex", true, "unavailable"],
        ],
      ],
    ]);
  });

  it("disables every launch entry when the session cap is reached", () => {
    const groups = buildStageLaunchEntryGroups({
      structuredActions: [],
      directRoleActions: [],
      terminal: terminalProfileFixture(),
      runtimes: [runtimeFixture({ health: "healthy" })],
      addDisabled: true,
      atSessionCap: true,
      sessionCap: 2,
    });

    expect(groups.flatMap((group) => group.entries).map((entry) => [entry.label, entry.disabled, entry.title])).toEqual(
      [
        ["Shell", true, "Cap reached (2). Close a session first."],
        ["Claude Code", true, "Cap reached (2). Close a session first."],
      ],
    );
  });

  it("keeps the empty launcher visible after a stale pending session grace period expires", async () => {
    vi.useFakeTimers();
    const container = await renderStage({
      activeSessionId: "stale_session",
      checkoutId: "co_empty",
      targetKey: "checkout:co_empty",
      targetLabel: "Empty checkout",
      targetType: "worktree_checkout",
    });

    expect(container.textContent).toContain("Starting session");

    await flushReact(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(container.textContent).toContain("New session");
    expect(container.textContent).toContain("Empty checkout");
    expect(container.textContent).not.toContain("Starting session");

    await flushReact(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(container.textContent).toContain("New session");
    expect(container.textContent).not.toContain("Starting session");
  });

  it("enables reload session only for runtimes that support resume", async () => {
    const resumable = agentSessionFixture({
      id: "sess_resumable",
      runtimeId: "claude-code",
      displayName: "Claude",
    });
    const nonResumable = agentSessionFixture({
      id: "sess_plain",
      runtimeId: "plain-agent",
      displayName: "Plain",
    });

    const resumableContainer = await renderStage({
      sessions: [resumable],
      allSessions: [resumable],
      activeSessionId: "sess_resumable",
      runtimes: [runtimeFixture({ id: "claude-code", capabilities: runtimeCapabilities({ supportsResume: true }) })],
    });
    click(button(resumableContainer, "Open actions for Claude"));
    expect((button(resumableContainer, "Reload session") as HTMLButtonElement).disabled).toBe(false);

    const nonResumableContainer = await renderStage({
      sessions: [nonResumable],
      allSessions: [nonResumable],
      activeSessionId: "sess_plain",
      runtimes: [runtimeFixture({ id: "plain-agent", capabilities: runtimeCapabilities({ supportsResume: false }) })],
    });
    click(button(nonResumableContainer, "Open actions for Plain"));
    expect((button(nonResumableContainer, "Reload session") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a reloading tab visible while state polling observes the source row closed", async () => {
    const source = agentSessionFixture({
      id: "sess_source",
      tabId: "tab_stable",
      displayName: "Claude",
    });
    const closedSource = agentSessionFixture({
      ...source,
      status: "stopped",
      transport: "disconnected",
      closedAt: "2026-06-06T00:01:00.000Z",
    });
    const replacement = agentSessionFixture({
      id: "sess_reloaded",
      tabId: "tab_stable",
      displayName: "Claude",
    });
    let resolveReload: ((response: Response) => void) | null = null;
    const reloadResponse = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/agent-sessions/sess_source/reload")) return reloadResponse;
      return Promise.resolve(jsonResponse({ roles: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onActiveSession = vi.fn();
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);
    const render = (sessions: AgentSession[], allSessions: AgentSession[], activeSessionId = "sess_source") => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Stage, {
            workspace: workspaceFixture({ mode: "structured" }),
            sessions,
            allSessions,
            targetKey: "home",
            targetType: "workspace_home",
            checkoutId: null,
            targetLabel: "Home",
            runtimes: [
              runtimeFixture({ id: "claude-code", capabilities: runtimeCapabilities({ supportsResume: true }) }),
            ],
            terminal: terminalProfileFixture(),
            activeSessionId,
            onActiveSession,
          }),
        ),
      );
    };

    await flushReact(() => render([source], [source]));
    click(button(rootElement, "Open actions for Claude"));
    click(button(rootElement, "Reload session"));

    await flushReact(() => render([], [closedSource]));
    expect(rootElement.textContent).toContain("Claude");
    expect(rootElement.textContent).not.toContain("New session");
    expect(rootElement.querySelector('[data-session-id="sess_source"]')).toBeTruthy();

    await flushReact(async () => {
      resolveReload?.(jsonResponse({ session: replacement, reloadedFrom: source.id }));
      await reloadResponse;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushReact(() => {});
    expect(onActiveSession).toHaveBeenCalledWith("sess_reloaded");
    expect(rootElement.textContent).toContain("Claude");
    expect(rootElement.querySelector('[data-session-id="sess_reloaded"]')).toBeTruthy();
  });
});

function sessionFixture(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "idle",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T19:00:00.000Z",
    updatedAt: "2026-05-28T19:00:00.000Z",
    ...overrides,
  };
}

function agentSessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_agent",
    workspaceId: "ws_1",
    kind: "agent",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_sess_agent",
    tmuxSessionId: "tmux_agent",
    runtimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: "2026-05-28T19:00:00.000Z",
    updatedAt: "2026-05-28T19:00:00.000Z",
    ...overrides,
  };
}

function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: null,
    name: "Workspace",
    path: "/work/ws",
    rootPath: "/work/ws",
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "architecture",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function roleTemplate(role: RoleTemplate["role"], displayName: string): RoleTemplate {
  return {
    role,
    displayName,
    systemPrompt: `${displayName} prompt`,
    launchSettings: {
      runtimeId: "codex",
      model: "gpt-5.4",
      effort: "high",
      fastMode: null,
      contextMode: null,
    },
    actions: [],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  };
}

function terminalProfileFixture(overrides: Partial<TerminalProfile> = {}): TerminalProfile {
  return {
    displayName: "Shell",
    command: "bash",
    args: ["-l"],
    ...overrides,
  };
}

function runtimeFixture(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    args: [],
    health: "healthy",
    healthReason: null,
    capabilities: runtimeCapabilities(),
    ...overrides,
  };
}

function runtimeCapabilities(overrides: Partial<AgentRuntime["capabilities"]> = {}): AgentRuntime["capabilities"] {
  return {
    supportsPrompt: true,
    supportsResume: true,
    supportsModelSelection: false,
    supportsTranscript: true,
    supportsStatusDetection: true,
    supportsNonInteractiveGoal: true,
    supportsShell: true,
    supportsUsage: false,
    supportsTui: true,
    ...overrides,
  };
}

async function renderStage(
  overrides: Partial<{
    workspace: Workspace;
    sessions: Array<TerminalSession | AgentSession>;
    allSessions: Array<TerminalSession | AgentSession>;
    targetKey: string;
    targetType: "workspace_home" | "worktree_checkout";
    checkoutId: string | null;
    targetLabel: string;
    runtimes: AgentRuntime[];
    terminal: TerminalProfile;
    activeSessionId: string;
    onActiveSession: (id: string) => void;
  }> = {},
): Promise<HTMLElement> {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Stage, {
          workspace: overrides.workspace ?? workspaceFixture({ mode: "structured" }),
          sessions: overrides.sessions ?? [],
          allSessions: overrides.allSessions ?? overrides.sessions ?? [],
          targetKey: overrides.targetKey ?? "home",
          targetType: overrides.targetType ?? "workspace_home",
          checkoutId: overrides.checkoutId ?? null,
          targetLabel: overrides.targetLabel ?? "Home",
          runtimes: overrides.runtimes ?? [runtimeFixture()],
          terminal: overrides.terminal ?? terminalProfileFixture(),
          activeSessionId: overrides.activeSessionId,
          onActiveSession: overrides.onActiveSession ?? vi.fn(),
        }),
      ),
    );
  });
  return rootElement;
}

function click(element: Element) {
  flushSync(() => {
    if (element instanceof HTMLElement) element.click();
    else element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

async function flushReact(callback: () => void | Promise<void>): Promise<void> {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function installLocalStorageMock() {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
