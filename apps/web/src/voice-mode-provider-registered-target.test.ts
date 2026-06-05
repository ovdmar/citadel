// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCaptureButton } from "./components/voice-capture-button.js";
import { FINAL_AUTO_SUBMIT_DELAY_MS } from "./lib/speech-recognition-controller.js";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { VoiceModeProvider, useVoiceMode } from "./voice-mode-provider.js";

type RecognitionHandler = ((event: unknown) => void) | null;

const terminalMocks = vi.hoisted(() => ({
  getFocusedTerminalSessionId: vi.fn<(_activeElement?: Element | null) => string | null>(() => null),
  getTerminalHandle: vi.fn((_sessionId: string) => undefined),
}));

vi.mock("./terminal-pane.js", () => ({
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

  error(error: string) {
    this.onerror?.({ error });
  }
}

const roots: Root[] = [];
let voiceApi: ReturnType<typeof useVoiceMode> | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  document.body.innerHTML = "";
  installLocalStorageMock();
  FakeSpeechRecognition.instances = [];
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

describe("VoiceModeProvider registered target fallback commits", () => {
  it("inserts and submits registered targets that do not provide a custom commit", async () => {
    const target = registeredSubmitTarget();
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.final("ship it");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(target.insertText).toHaveBeenCalledWith("ship it");
    expect(target.submit).toHaveBeenCalledOnce();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });

  it("inserts without submitting registered targets when auto-submit is off", async () => {
    const target = registeredSubmitTarget();
    await renderProvider();

    await flushReact(() => voiceApi?.setAutoSubmit(false));
    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.final("draft only");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(target.insertText).toHaveBeenCalledWith("draft only");
    expect(target.submit).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Inserted");
    expect(document.querySelector(".voice-mode-error")?.textContent).toBe("Inserted, not submitted.");
  });
});

describe("VoiceModeProvider insecure-context support", () => {
  it("hides mic controls and surfaces the secure-context error from provider start", async () => {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    await renderProvider({ renderMic: true, target: registeredSubmitTarget() });

    expect(voiceApi?.speechSupported).toBe(false);
    expect(document.querySelector(".voice-capture-button")).toBeNull();
    await flushReact(() => {
      expect(voiceApi?.startDictation({ target: registeredSubmitTarget() })).toBe(false);
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Voice unavailable");
    expect(document.querySelector(".voice-mode-error")?.textContent).toBe(
      "Voice dictation requires a secure browser context.",
    );
  });
});

describe("VoiceModeProvider retry after capture errors", () => {
  it("retries against the snapshotted shortcut target", async () => {
    await renderProvider();
    const first = document.createElement("input");
    const second = document.createElement("input");
    document.body.append(first, second);
    first.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(first);
    });
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.interim("interim partial");
      FakeSpeechRecognition.instances[0]?.error("network");
    });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");

    second.focus();
    await flushReact(() => retryButton().click());
    await flushReact(() => {
      FakeSpeechRecognition.instances[1]?.final("dictated retry");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(first.value).toBe("dictated retry");
    expect(second.value).toBe("");
  });
});

async function renderProvider(options: { renderMic?: boolean; target?: VoiceTarget } = {}) {
  const rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(createElement(VoiceModeProvider, null, createElement(Harness, options)));
  });
}

function Harness(props: { renderMic?: boolean; target?: VoiceTarget }) {
  voiceApi = useVoiceMode();
  if (!props.renderMic) return createElement("div", null, "ready");
  return createElement(VoiceCaptureButton, {
    speechSupported: voiceApi.speechSupported,
    target: props.target ?? null,
    startDictation: voiceApi.startDictation,
  });
}

function registeredSubmitTarget(): VoiceTarget {
  return {
    kind: "registered",
    insertText: vi.fn(),
    submit: vi.fn(),
    canAcceptVoiceCommit: () => true,
  };
}

function dispatchVoiceShortcut(target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "d",
    metaKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function retryButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Retry");
  if (!(button instanceof HTMLButtonElement)) throw new Error("retry button missing");
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
