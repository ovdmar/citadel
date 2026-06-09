// @vitest-environment happy-dom

import type { AgentSession, TerminalSession } from "@citadel/contracts";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StageTabActionMenu } from "./stage-tab-menu.js";

const roots: Root[] = [];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("StageTabActionMenu", () => {
  it("opens tab actions and dispatches reload view, reload session, and close tab", () => {
    const onReloadTerminal = vi.fn();
    const onReloadAgentSession = vi.fn();
    const onStopSession = vi.fn();
    const container = renderMenu({
      session: agentSessionFixture(),
      canReloadAgentSession: true,
      onReloadTerminal,
      onReloadAgentSession,
      onStopSession,
    });

    click(button(container, "Open actions for Claude"));
    expect(container.textContent).toContain("Reload view");
    expect(container.textContent).toContain("Reload session");
    expect(container.textContent).toContain("Close tab");

    click(button(container, "Reload view"));
    expect(onReloadTerminal).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("Reload session");

    click(button(container, "Open actions for Claude"));
    click(button(container, "Reload session"));
    expect(onReloadAgentSession).toHaveBeenCalledTimes(1);

    click(button(container, "Open actions for Claude"));
    click(button(container, "Close tab"));
    expect(onStopSession).toHaveBeenCalledTimes(1);
  });

  it("hides reload session for terminal tabs and disables it for non-resumable agent tabs", () => {
    const terminalContainer = renderMenu({ session: terminalSessionFixture(), canReloadAgentSession: false });
    click(button(terminalContainer, "Open actions for Shell"));
    expect(terminalContainer.textContent).toContain("Reload view");
    expect(terminalContainer.textContent).not.toContain("Reload session");

    const agentContainer = renderMenu({
      session: agentSessionFixture({ runtimeSessionId: null }),
      canReloadAgentSession: false,
    });
    click(button(agentContainer, "Open actions for Claude"));
    const reloadSession = button(agentContainer, "Reload session") as HTMLButtonElement;
    expect(reloadSession.disabled).toBe(true);
  });

  it("tracks expanded state and closes on toggle, escape, outside click, resize, and scroll", () => {
    const container = renderMenu();
    const trigger = button(container, "Open actions for Claude");

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    click(trigger);
    keydown("Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    click(trigger);
    mousedown(document.body);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    click(trigger);
    viewportEvent("resize");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    click(trigger);
    viewportEvent("scroll");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not invoke reload session while a reload is already pending", () => {
    const onReloadAgentSession = vi.fn();
    const container = renderMenu({
      reloadingAgentSession: true,
      onReloadAgentSession,
    });

    click(button(container, "Open actions for Claude"));
    const reloadSession = button(container, "Reload session") as HTMLButtonElement;
    expect(reloadSession.disabled).toBe(true);
    click(reloadSession);
    expect(onReloadAgentSession).not.toHaveBeenCalled();
  });
});

function renderMenu(
  overrides: Partial<{
    session: AgentSession | TerminalSession;
    canReloadAgentSession: boolean;
    reloadingAgentSession: boolean;
    onReloadTerminal: () => void;
    onReloadAgentSession: () => void;
    onStopSession: () => void;
  }> = {},
): HTMLElement {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  flushSync(() => {
    root.render(
      createElement(StageTabActionMenu, {
        session: overrides.session ?? agentSessionFixture(),
        label: overrides.session?.displayName ?? "Claude",
        canReloadAgentSession: overrides.canReloadAgentSession ?? true,
        reloadingAgentSession: overrides.reloadingAgentSession ?? false,
        onReloadTerminal: overrides.onReloadTerminal ?? vi.fn(),
        onReloadAgentSession: overrides.onReloadAgentSession ?? vi.fn(),
        onStopSession: overrides.onStopSession ?? vi.fn(),
      }),
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

function mousedown(element: Element) {
  flushSync(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  });
}

function keydown(key: string) {
  flushSync(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function viewportEvent(type: string) {
  flushSync(() => {
    window.dispatchEvent(new Event(type));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

function agentSessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  const ts = "2026-06-06T00:00:00.000Z";
  return {
    id: "sess_agent",
    kind: "agent",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_ws_1_agent",
    tmuxSessionId: "tmux_1",
    tmuxSocketName: "citadel-ws-ws_1",
    runtimeSessionId: "550e8400-e29b-41d4-a716-446655440000",
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function terminalSessionFixture(overrides: Partial<TerminalSession> = {}): TerminalSession {
  const ts = "2026-06-06T00:00:00.000Z";
  return {
    id: "sess_terminal",
    kind: "terminal",
    workspaceId: "ws_1",
    runtimeId: null,
    displayName: "Shell",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_ws_1_shell",
    tmuxSessionId: "tmux_2",
    tmuxSocketName: "citadel-ws-ws_1",
    runtimeSessionId: null,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}
