// @vitest-environment happy-dom

import type { TerminalSession, WorkspaceSession } from "@citadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomBar, formatBytes, formatClock, formatPercent } from "./cockpit-bottom-bar.js";

vi.mock("./api.js", () => ({
  api: vi.fn(async () => ({ systemHealth: null })),
}));

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.unmount();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("footer health formatting", () => {
  it("formats unavailable percentages as n/a", () => {
    expect(formatPercent(null)).toBe("n/a");
  });

  it("rounds percentages for compact footer display", () => {
    expect(formatPercent(72.6)).toBe("73%");
  });

  it("formats bytes with compact binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 ** 3)).toBe("12 GB");
  });

  it("formats the footer clock without seconds", () => {
    expect(formatClock(new Date("2026-06-05T09:07:30Z"))).toMatch(/^09:07$/);
  });
});

describe("footer right side", () => {
  it("renders only the clock even when a live session has a watch label", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T09:07:30Z"));
    const active = session({ tmuxSessionName: "citadel_ws_mq0rwq26_0azakwt0_vxda7uee" });

    renderBottomBar({ activeSession: active, sessions: [active] });

    const right = document.querySelector(".cit-bb-right");
    expect(right?.textContent).toBe("09:07");
    expect(right?.querySelector(".cit-bb-watch")).toBeNull();
  });
});

function renderBottomBar(props: { activeSession: WorkspaceSession | null; sessions: WorkspaceSession[] }) {
  const rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(BottomBar, { activeSession: props.activeSession, sessions: props.sessions }),
      ),
    );
  });
}

function session(overrides: Partial<TerminalSession> = {}): WorkspaceSession {
  const base: TerminalSession = {
    id: "sess_1",
    workspaceId: "ws_1",
    displayName: "Terminal",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: null,
    tmuxSessionId: null,
    ptySessionId: null,
    kind: "terminal",
    runtimeId: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}
