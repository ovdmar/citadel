// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_AUTO_SUBMIT_DELAY_MS } from "./lib/speech-recognition-controller.js";
import { VoiceModeProvider, useVoiceMode } from "./voice-mode-provider.js";

type RecognitionHandler = ((event: unknown) => void) | null;
type TerminalHandleMock = {
  sendVoiceInput: ReturnType<typeof vi.fn>;
  canAcceptVoiceInput: ReturnType<typeof vi.fn>;
};

const terminalMocks = vi.hoisted(() => {
  const handles = new Map<string, TerminalHandleMock>();
  return {
    handles,
    focusActiveTerminal: vi.fn(),
    getDefaultVoiceTerminalSessionId: vi.fn<() => string | null>(() => null),
    getFocusedTerminalSessionId: vi.fn<(_activeElement?: Element | null) => string | null>(() => null),
    getTerminalHandle: vi.fn((sessionId: string) => handles.get(sessionId)),
  };
});

vi.mock("./terminal-pane.js", () => ({
  focusActiveTerminal: terminalMocks.focusActiveTerminal,
  getDefaultVoiceTerminalSessionId: terminalMocks.getDefaultVoiceTerminalSessionId,
  getFocusedTerminalSessionId: terminalMocks.getFocusedTerminalSessionId,
  getTerminalHandle: terminalMocks.getTerminalHandle,
}));

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
  terminalMocks.handles.clear();
  terminalMocks.focusActiveTerminal.mockClear();
  terminalMocks.getDefaultVoiceTerminalSessionId.mockReturnValue(null);
  terminalMocks.getFocusedTerminalSessionId.mockReturnValue(null);
  terminalMocks.getTerminalHandle.mockClear();
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

describe("VoiceModeProvider terminal targets", () => {
  it("uses the selected terminal session when no input target is focused", async () => {
    const sendVoiceInput = vi.fn(() => true);
    terminalMocks.handles.set("sess_selected", {
      sendVoiceInput,
      canAcceptVoiceInput: vi.fn(() => true),
    });
    terminalMocks.getDefaultVoiceTerminalSessionId.mockReturnValue("sess_selected");
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation();
      FakeSpeechRecognition.instances[0]?.final("ship it");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(terminalMocks.focusActiveTerminal).toHaveBeenCalledWith("sess_selected");
    expect(sendVoiceInput).toHaveBeenCalledWith("ship it", { submit: true });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });

  it("commits terminal dictation through the session handle with the current auto-submit value", async () => {
    const sendVoiceInput = vi.fn(() => true);
    terminalMocks.handles.set("sess_1", { sendVoiceInput, canAcceptVoiceInput: vi.fn(() => true) });
    await renderProvider();

    await flushReact(() => voiceApi?.setAutoSubmit(false));
    await flushReact(() => {
      voiceApi?.startDictation({ terminalSessionId: "sess_1" });
      FakeSpeechRecognition.instances[0]?.final("run tests");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(sendVoiceInput).toHaveBeenCalledWith("run tests", { submit: false });
  });

  it("commits terminal dictation with default auto-submit enabled", async () => {
    const sendVoiceInput = vi.fn(() => true);
    terminalMocks.handles.set("sess_1", { sendVoiceInput, canAcceptVoiceInput: vi.fn(() => true) });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ terminalSessionId: "sess_1" });
      FakeSpeechRecognition.instances[0]?.final("run tests");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(sendVoiceInput).toHaveBeenCalledWith("run tests", { submit: true });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });

  it("commits terminal dictation only to the snapshotted terminal session", async () => {
    const firstSendVoiceInput = vi.fn(() => true);
    const secondSendVoiceInput = vi.fn(() => true);
    terminalMocks.handles.set("sess_1", {
      sendVoiceInput: firstSendVoiceInput,
      canAcceptVoiceInput: vi.fn(() => true),
    });
    terminalMocks.handles.set("sess_2", {
      sendVoiceInput: secondSendVoiceInput,
      canAcceptVoiceInput: vi.fn(() => true),
    });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ terminalSessionId: "sess_2" });
      FakeSpeechRecognition.instances[0]?.final("session two");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(firstSendVoiceInput).not.toHaveBeenCalled();
    expect(secondSendVoiceInput).toHaveBeenCalledWith("session two", { submit: true });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });

  it("buffers terminal dictation when the session handle cannot write", async () => {
    const sendVoiceInput = vi.fn(() => false);
    terminalMocks.handles.set("sess_1", { sendVoiceInput, canAcceptVoiceInput: vi.fn(() => true) });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ terminalSessionId: "sess_1" });
      FakeSpeechRecognition.instances[0]?.final("lost command");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("lost command");
    expect(document.querySelector(".voice-mode-error")?.textContent).toContain("terminal is not connected");
  });

  it("buffers terminal dictation when the snapshotted terminal is hidden before final commit", async () => {
    const sendVoiceInput = vi.fn(() => true);
    terminalMocks.handles.set("sess_1", { sendVoiceInput, canAcceptVoiceInput: vi.fn(() => false) });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ terminalSessionId: "sess_1" });
      FakeSpeechRecognition.instances[0]?.final("hidden command");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(sendVoiceInput).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("No input target");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("hidden command");
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
