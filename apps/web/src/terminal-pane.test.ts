// @vitest-environment happy-dom

import type { AgentSession } from "@citadel/contracts";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane, isTtydHttpErrorPageVisible, isTtydReconnectPromptVisible } from "./terminal-pane.js";
import { type ResolvedTheme, applyThemePreference } from "./use-resolved-theme.js";

const apiMocks = vi.hoisted(() => {
  class ApiError extends Error {
    detail?: string;
  }
  return { ApiError, api: vi.fn() };
});

vi.mock("./api.js", () => apiMocks);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  installLocalStorageMock();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  apiMocks.api.mockReset();
  apiMocks.api.mockImplementation(async (path: string) => {
    const url = new URL(path, "http://citadel.test");
    const theme = (url.searchParams.get("theme") ?? "dark") as ResolvedTheme;
    return {
      terminal: {
        key: "sess_1",
        url: "about:blank",
        basePath: "/terminals/sess_1",
        port: 11000,
        tmuxSession: "citadel_sess_1",
        worktreePath: null,
        startedAt: "2026-05-28T00:00:00.000Z",
        theme,
      },
    };
  });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

function iframeWithBody(html: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("iframe contentDocument unavailable");
  doc.body.innerHTML = html;
  return iframe;
}

describe("isTtydReconnectPromptVisible", () => {
  it("detects ttyd's persistent reconnect overlay", () => {
    const iframe = iframeWithBody('<div class="xterm"><div>Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("detects reconnect button overlays from ttyd variants", () => {
    const iframe = iframeWithBody('<main><button type="button">Reconnect</button></main>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("ignores normal terminal output mentioning reconnect", () => {
    const iframe = iframeWithBody(
      '<div class="xterm"><div class="xterm-screen"><span>run reconnect-database when ready</span></div></div>',
    );

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });

  it("ignores hidden reconnect overlays", () => {
    const iframe = iframeWithBody('<div class="xterm"><div style="display: none">Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });
});

describe("isTtydHttpErrorPageVisible", () => {
  it("detects terminal proxy 404 pages", () => {
    expect(isTtydHttpErrorPageVisible(iframeWithBody("terminal_not_found"))).toBe(true);
    expect(isTtydHttpErrorPageVisible(iframeWithBody("404 page not found"))).toBe(true);
  });

  it("ignores normal xterm terminal content", () => {
    const iframe = iframeWithBody('<div class="xterm"><div class="xterm-screen">404 from curl</div></div>');

    expect(isTtydHttpErrorPageVisible(iframe)).toBe(false);
  });
});

describe("TerminalPane theme handling", () => {
  it("does not respawn an already-open ttyd frame when the resolved theme changes", async () => {
    applyThemePreference("dark");
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);

    await act(async () => {
      root.render(createElement(TerminalPane, { session: sessionFixture() }));
      await settle();
    });

    expect(apiMocks.api).toHaveBeenCalledTimes(1);
    expect(searchParam(apiCallPath(0), "theme")).toBe("dark");
    expect(searchParam(apiCallPath(0), "force")).toBeNull();

    await act(async () => {
      applyThemePreference("light");
      await settle();
    });

    expect(apiMocks.api).toHaveBeenCalledTimes(1);
  });
});

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

function searchParam(path: unknown, param: string) {
  return new URL(String(path), "http://citadel.test").searchParams.get(param);
}

function apiCallPath(index: number) {
  const call = apiMocks.api.mock.calls[index];
  if (!call) throw new Error(`missing api call ${index}`);
  return call[0];
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

function sessionFixture(): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "shell",
    displayName: "Terminal",
    status: "idle",
    transport: "connected",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T00:00:00.000Z",
    updatedAt: "2026-05-28T00:00:00.000Z",
  };
}
