// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_AUTO_SUBMIT_DELAY_MS } from "./lib/speech-recognition-controller.js";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { VoiceModeProvider, useVoiceMode } from "./voice-mode-provider.js";

type RecognitionHandler = ((event: unknown) => void) | null;

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: RecognitionHandler = null;
  onerror: RecognitionHandler = null;
  onend: (() => void) | null = null;
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
}

const roots: Root[] = [];
let voiceApi: ReturnType<typeof useVoiceMode> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  installLocalStorageMock();
  FakeSpeechRecognition.instances = [];
  vi.useFakeTimers();
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window, "SpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
  Object.defineProperty(window, "webkitSpeechRecognition", {
    configurable: true,
    value: FakeSpeechRecognition,
  });
});

afterEach(async () => {
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  voiceApi = null;
});

describe("VoiceModeProvider", () => {
  it("defaults auto-submit on and persists preference", async () => {
    await renderProvider();

    expect(voiceApi?.autoSubmit).toBe(true);
    await flushReact(() => voiceApi?.setAutoSubmit(false));

    expect(window.localStorage.getItem("citadel.voice.autoSubmit")).toBe("0");
  });

  it("commits final transcript into an explicit target with auto-submit enabled", async () => {
    const commit = vi.fn(() => ({ status: "submitted" as const, text: "hello" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    voiceApi?.startDictation({ target });
    FakeSpeechRecognition.instances[0]?.final("hello");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledWith("hello", { autoSubmit: true });
  });

  it("uses the current auto-submit toggle when the final commit delay fires", async () => {
    const commit = vi.fn(() => ({ status: "inserted-not-submitted" as const, text: "hello" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    voiceApi?.startDictation({ target });
    FakeSpeechRecognition.instances[0]?.final("hello");
    await flushReact(() => voiceApi?.setAutoSubmit(false));
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledWith("hello", { autoSubmit: false });
  });

  it("starts from the global shortcut and inserts into the focused text input", async () => {
    await renderProvider();
    const input = document.createElement("input");
    input.value = "before after";
    document.body.appendChild(input);
    input.setSelectionRange(7, 12);
    input.focus();

    await flushReact(() => dispatchVoiceShortcut());
    FakeSpeechRecognition.instances[0]?.final("now");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(input.value).toBe("before now");
    expect(input.selectionStart).toBe(10);
  });

  it("keeps the snapshotted shortcut target when start needs a click retry", async () => {
    class ThrowOnceRecognition extends FakeSpeechRecognition {
      static starts = 0;
      override start = vi.fn(() => {
        ThrowOnceRecognition.starts += 1;
        if (ThrowOnceRecognition.starts === 1) throw new DOMException("activation rejected", "NotAllowedError");
      });
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: ThrowOnceRecognition,
    });
    await renderProvider();
    const first = document.createElement("input");
    const second = document.createElement("input");
    document.body.append(first, second);
    first.focus();

    await flushReact(() => dispatchVoiceShortcut());
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("retry");

    second.focus();
    await flushReact(() => retryButton().click());
    FakeSpeechRecognition.instances[1]?.final("dictated");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(first.value).toBe("dictated");
    expect(second.value).toBe("");
  });

  it("keeps final transcript copyable when no target is focused", async () => {
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation();
      FakeSpeechRecognition.instances[0]?.final("loose idea");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("loose idea");
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

function dispatchVoiceShortcut() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", metaKey: true, shiftKey: true, bubbles: true }));
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
