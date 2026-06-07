// @vitest-environment happy-dom

import type { SystemHealthSnapshot, TerminalSession, WorkspaceSession } from "@citadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import { BottomBar, formatBytes, formatClock, formatPercent } from "./cockpit-bottom-bar.js";

vi.mock("./api.js", () => ({
  api: vi.fn(async () => ({ systemHealth: null })),
}));

const roots: Root[] = [];
const apiMock = vi.mocked(api);

beforeEach(() => {
  apiMock.mockReset();
  const defaultApi: typeof api = async () => ({ systemHealth: null }) as never;
  apiMock.mockImplementation(defaultApi);
});

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

describe("footer resource breakdowns", () => {
  it("opens an immediate loading modal and fetches top offenders for the hovered resource", async () => {
    let resolveBreakdown!: (value: {
      breakdown: {
        resource: "cpu";
        checkedAt: string;
        status: "available";
        reason: null;
        offenders: Array<{
          id: string;
          label: string;
          detail: string;
          pid: number;
          value: number;
          unit: "percent";
        }>;
      };
    }) => void;
    const breakdown = new Promise<{
      breakdown: {
        resource: "cpu";
        checkedAt: string;
        status: "available";
        reason: null;
        offenders: Array<{
          id: string;
          label: string;
          detail: string;
          pid: number;
          value: number;
          unit: "percent";
        }>;
      };
    }>((resolve) => {
      resolveBreakdown = resolve;
    });
    const mockApi: typeof api = async (path) => {
      if (path === "/api/system-health") return { systemHealth: healthSnapshot } as never;
      if (path === "/api/system-health/resources/cpu/offenders") return breakdown as never;
      throw new Error(`unexpected path ${path}`);
    };
    apiMock.mockImplementation(mockApi);

    renderBottomBar({ activeSession: null, sessions: [] });
    const cpu = document.querySelector('[data-resource-type="cpu"]');
    if (!cpu) throw new Error("CPU metric missing");

    await flushReact(() => {
      cpu.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    await waitFor(
      () => document.querySelector(".cit-resource-modal")?.textContent?.includes("Loading breakdown...") === true,
    );
    expect(apiMock.mock.calls.some(([path]) => path === "/api/system-health/resources/cpu/offenders")).toBe(true);

    resolveBreakdown({
      breakdown: {
        resource: "cpu",
        checkedAt: "2026-06-05T12:00:00.000Z",
        status: "available",
        reason: null,
        offenders: [
          {
            id: "pid:123",
            label: "node",
            detail: "node /tmp/citadel/dist/main.js",
            pid: 123,
            value: 48.4,
            unit: "percent",
          },
        ],
      },
    });

    await waitFor(() => document.querySelector(".cit-resource-modal")?.textContent?.includes("node") === true);
    expect(document.querySelector(".cit-resource-modal")?.textContent).toContain("48%");
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

async function flushReact(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
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

const healthSnapshot: SystemHealthSnapshot = {
  tone: "healthy",
  reason: null,
  checkedAt: "2026-06-05T12:00:00.000Z",
  machine: {
    cpu: { percentUsed: 42, loadAverage1m: 1.2, cores: 8 },
    memory: { totalBytes: 100, usedBytes: 45, freeBytes: 55, percentUsed: 45 },
    disk: {
      path: "/tmp/citadel",
      device: "sda1",
      totalBytes: 100,
      usedBytes: 40,
      freeBytes: 60,
      percentUsed: 40,
      ioUtilizationPercent: 2,
      error: null,
    },
  },
  process: { pid: 123, rssBytes: 32, heapUsedBytes: 16, heapTotalBytes: 24, percentOfMachineMemory: 1 },
};
