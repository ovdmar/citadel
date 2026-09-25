// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE_SILENCE_TIMEOUT_MS, FINAL_AUTO_SUBMIT_DELAY_MS } from "./lib/speech-recognition-controller.js";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { VoiceModeProvider, useVoiceMode } from "./voice-mode-provider.js";

type RecognitionHandler = ((event: unknown) => void) | null;

const terminalMocks = vi.hoisted(() => ({
  focusActiveTerminal: vi.fn(),
  getDefaultVoiceTerminalSessionId: vi.fn<() => string | null>(() => null),
  getFocusedTerminalSessionId: vi.fn<(_activeElement?: Element | null) => string | null>(() => null),
  getTerminalHandle: vi.fn((_sessionId: string) => undefined),
}));

vi.mock("./terminal-pane.js", () => ({
  focusActiveTerminal: terminalMocks.focusActiveTerminal,
  getDefaultVoiceTerminalSessionId: terminalMocks.getDefaultVoiceTerminalSessionId,
  getFocusedTerminalSessionId: terminalMocks.getFocusedTerminalSessionId,
  getTerminalHandle: terminalMocks.getTerminalHandle,
}));

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  onresult: RecognitionHandler = null;
  onerror: RecognitionHandler = null;
  onend: (() => void) | null = null;
  lang = "";
  interimResults = false;
  continuous = false;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  final(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: text } }],
    });
  }

  interim(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: text } }],
    });
  }
}

const roots: Root[] = [];
let voiceApi: ReturnType<typeof useVoiceMode> | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.innerHTML = "";
  installLocalStorageMock();
  FakeSpeechRecognition.instances = [];
  terminalMocks.focusActiveTerminal.mockClear();
  terminalMocks.getDefaultVoiceTerminalSessionId.mockReturnValue(null);
  terminalMocks.getFocusedTerminalSessionId.mockReturnValue(null);
  terminalMocks.getTerminalHandle.mockClear();
  vi.useFakeTimers();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
  Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
});

afterEach(async () => {
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  voiceApi = null;
});

describe("VoiceModeProvider silence setting and manual send", () => {
  it("defaults the silence window to 15 seconds and persists changes", async () => {
    await renderProvider();

    expect(voiceApi?.silenceTimeoutMs).toBe(DEFAULT_VOICE_SILENCE_TIMEOUT_MS);
    await flushReact(() => voiceApi?.setSilenceTimeoutMs(20_000));

    expect(voiceApi?.silenceTimeoutMs).toBe(20_000);
    expect(window.localStorage.getItem("citadel.voice.silenceTimeoutMs")).toBe("20000");
  });

  it("uses the persisted silence window for final auto-submit", async () => {
    window.localStorage.setItem("citadel.voice.silenceTimeoutMs", "20000");
    const commit = vi.fn((text: string) => ({ status: "submitted" as const, text }));
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget(commit) });
      FakeSpeechRecognition.instances[0]?.final("wait for it");
    });
    vi.advanceTimersByTime(19_999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(commit).toHaveBeenCalledWith("wait for it", { autoSubmit: true });
  });

  it("sends the current interim draft immediately from the overlay", async () => {
    const commit = vi.fn((text: string) => ({ status: "submitted" as const, text }));
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget(commit) });
      FakeSpeechRecognition.instances[0]?.interim("partial thought");
    });
    expect(document.querySelector(".voice-mode-interim")?.textContent).toContain("partial thought");
    await flushReact(() => sendNowButton().click());
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("partial thought", { autoSubmit: true });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });
});

async function renderProvider() {
  const rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(createElement(VoiceModeProvider, null, createElement(Harness)));
  });
}

function Harness() {
  voiceApi = useVoiceMode();
  return createElement("div", null, "ready");
}

function registeredTarget(commit: NonNullable<VoiceTarget["commit"]>): VoiceTarget {
  return {
    kind: "registered",
    insertText: vi.fn(),
    commit,
    canAcceptVoiceCommit: () => true,
  };
}

function sendNowButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Send now");
  if (!(button instanceof HTMLButtonElement)) throw new Error("send button missing");
  return button;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

const flushReact = async (callback: () => void | Promise<void>) => {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
};

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
