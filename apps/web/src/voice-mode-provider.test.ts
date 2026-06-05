// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_AUTO_SUBMIT_DELAY_MS, NO_RESULT_SILENCE_TIMEOUT_MS } from "./lib/speech-recognition-controller.js";
import type { VoiceTarget } from "./lib/voice-targets.js";
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
    getFocusedTerminalSessionId: vi.fn<(_activeElement?: Element | null) => string | null>(() => null),
    getTerminalHandle: vi.fn((sessionId: string) => handles.get(sessionId)),
  };
});

vi.mock("./terminal-pane.js", () => ({
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

  interim(text: string) {
    this.onresult?.({
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: text } }],
    });
  }

  error(error: string) {
    this.onerror?.({ error });
  }

  end() {
    this.onend?.();
  }
}

const roots: Root[] = [];
let voiceApi: ReturnType<typeof useVoiceMode> | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  installLocalStorageMock();
  FakeSpeechRecognition.instances = [];
  terminalMocks.handles.clear();
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

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
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

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    FakeSpeechRecognition.instances[0]?.final("hello");
    await flushReact(() => voiceApi?.setAutoSubmit(false));
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledWith("hello", { autoSubmit: false });
  });

  it("uses the overlay auto-submit checkbox for commit options and local persistence", async () => {
    const commit = vi.fn(() => ({ status: "inserted-not-submitted" as const, text: "hello" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    const checkbox = autoSubmitCheckbox();
    expect(checkbox.checked).toBe(true);
    await flushReact(() => checkbox.click());
    FakeSpeechRecognition.instances[0]?.final("hello");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(window.localStorage.getItem("citadel.voice.autoSubmit")).toBe("0");
    expect(commit).toHaveBeenCalledWith("hello", { autoSubmit: false });
  });

  it("cancels pending final text without committing it", async () => {
    const commit = vi.fn(() => ({ status: "submitted" as const, text: "cancelled" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    FakeSpeechRecognition.instances[0]?.final("cancelled");
    await flushReact(() => cancelButton().click());
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-mode-overlay")).toBeNull();
  });

  it("loads persisted auto-submit preference on startup", async () => {
    window.localStorage.setItem("citadel.voice.autoSubmit", "0");
    const commit = vi.fn(() => ({ status: "inserted-not-submitted" as const, text: "hello" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    expect(voiceApi?.autoSubmit).toBe(false);
    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    expect(autoSubmitCheckbox().checked).toBe(false);
    FakeSpeechRecognition.instances[0]?.final("hello");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledWith("hello", { autoSubmit: false });
  });

  it("starts from the global shortcut and keeps the accepted target snapshot", async () => {
    await renderProvider();
    const input = document.createElement("input");
    const second = document.createElement("input");
    input.value = "before after";
    document.body.append(input, second);
    input.setSelectionRange(7, 12);
    input.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(input);
    });
    second.focus();
    FakeSpeechRecognition.instances[0]?.final("now");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(input.value).toBe("before now");
    expect(input.selectionStart).toBe(10);
    expect(second.value).toBe("");
  });

  it("prevents default and stops propagation for non-terminal voice shortcuts", async () => {
    await renderProvider();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const downstream = vi.fn();
    document.addEventListener("keydown", downstream);

    let event: KeyboardEvent | undefined;
    await flushReact(() => {
      event = dispatchVoiceShortcut(input);
    });
    document.removeEventListener("keydown", downstream);
    if (!event) throw new Error("voice shortcut event was not dispatched");

    expect(event.defaultPrevented).toBe(true);
    expect(downstream).not.toHaveBeenCalled();
    expect(FakeSpeechRecognition.instances).toHaveLength(1);
  });

  it("renders the overlay as a live region without stealing focus from the snapshotted input", async () => {
    await renderProvider();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(input);
    });

    const overlay = document.querySelector(".voice-mode-overlay");
    expect(overlay).toBeInstanceOf(HTMLOutputElement);
    expect(overlay?.getAttribute("aria-live")).toBe("polite");
    expect(document.activeElement).toBe(input);
    expect(autoSubmitCheckbox()).toBeInstanceOf(HTMLInputElement);
    expect(stopButton()).toBeInstanceOf(HTMLButtonElement);
    expect(cancelButton()).toBeInstanceOf(HTMLButtonElement);
  });

  it("lets terminal-focused voice shortcuts flow through the terminal shortcut bridge", async () => {
    terminalMocks.getFocusedTerminalSessionId.mockReturnValue("sess_1");
    await renderProvider();

    const event = new KeyboardEvent("keydown", {
      key: "d",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
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

    await flushReact(() => {
      dispatchVoiceShortcut(first);
    });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Ready to retry");

    second.focus();
    await flushReact(() => retryButton().click());
    FakeSpeechRecognition.instances[1]?.final("dictated");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(first.value).toBe("dictated");
    expect(second.value).toBe("");
  });

  it("keeps final transcript copyable when no target is focused", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation();
      FakeSpeechRecognition.instances[0]?.final("loose idea");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("No input target");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("loose idea");
    expect(document.querySelector(".voice-mode-error")?.textContent).toContain("No focused input is available");
    expect(document.querySelector(".voice-mode-status")?.textContent).not.toBe("Submitted");
    expect(copyButton()).toBeInstanceOf(HTMLButtonElement);
    await flushReact(() => copyButton().click());
    expect(writeText).toHaveBeenCalledWith("loose idea");
    expect(document.querySelector(".voice-mode-overlay")).not.toBeNull();
    await flushReact(() => cancelButton().click());
    expect(document.querySelector(".voice-mode-overlay")).toBeNull();
  });

  it("buffers in-flight dictation when a registered target unregisters before final commit", async () => {
    await renderProvider();
    const element = document.createElement("textarea");
    document.body.appendChild(element);
    const commit = vi.fn(() => ({ status: "submitted" as const, text: "should not commit" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    const unregister = voiceApi?.registerTarget(element, target);
    element.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(element);
    });
    unregister?.();
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.final("orphaned transcript");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("No input target");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("orphaned transcript");
  });

  it("buffers in-flight dictation when a snapshotted generic input disappears before final commit", async () => {
    await renderProvider();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(input);
    });
    input.remove();
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.final("orphaned transcript");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(input.value).toBe("");
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("No input target");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("orphaned transcript");
  });

  it.each([
    [
      "disabled",
      (input: HTMLInputElement) => {
        input.disabled = true;
      },
    ],
    [
      "read-only",
      (input: HTMLInputElement) => {
        input.readOnly = true;
      },
    ],
    [
      "hidden",
      (input: HTMLInputElement) => {
        input.hidden = true;
      },
    ],
  ])("buffers in-flight dictation when a snapshotted generic input becomes %s", async (_label, invalidate) => {
    await renderProvider();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    await flushReact(() => {
      dispatchVoiceShortcut(input);
    });
    invalidate(input);
    await flushReact(() => {
      FakeSpeechRecognition.instances[0]?.final("orphaned transcript");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });

    expect(input.value).toBe("");
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("No input target");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("orphaned transcript");
  });

  it("commits pending final text when Stop is clicked during the final delay", async () => {
    const commit = vi.fn(() => ({ status: "submitted" as const, text: "stop final" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    FakeSpeechRecognition.instances[0]?.final("stop final");
    await flushReact(() => stopButton().click());
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledWith("stop final", { autoSubmit: true });
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Submitted");
  });

  it("keeps interim text copyable when Stop is clicked before a final result", async () => {
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget() });
    });
    FakeSpeechRecognition.instances[0]?.interim("interim only");
    await flushReact(() => stopButton().click());

    expect(document.querySelector(".voice-mode-overlay")).not.toBeNull();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("interim only");
  });

  it("keeps interim text copyable and clears timers when route cleanup stops dictation", async () => {
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget() });
    });
    FakeSpeechRecognition.instances[0]?.interim("route partial");
    await flushReact(() => voiceApi?.stopDictation({ commitFinal: false }));
    vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS);

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("route partial");
    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("buffers pending final text and clears timers when route cleanup stops dictation", async () => {
    const commit = vi.fn(() => ({ status: "submitted" as const, text: "route final" }));
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      commit,
      canAcceptVoiceCommit: () => true,
    };
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
    });
    FakeSpeechRecognition.instances[0]?.final("route final");
    await flushReact(() => voiceApi?.stopDictation({ commitFinal: false }));
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(commit).not.toHaveBeenCalled();
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("route final");
    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalledOnce();
  });

  it("copies buffered transcript text to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation();
      FakeSpeechRecognition.instances[0]?.final("loose idea");
      vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    });
    await flushReact(() => copyButton().click());

    expect(writeText).toHaveBeenCalledWith("loose idea");
  });

  it("keeps pending final transcript copyable and retryable after permission errors", async () => {
    const target = registeredTarget();
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
      FakeSpeechRecognition.instances[0]?.final("permission partial");
      FakeSpeechRecognition.instances[0]?.error("not-allowed");
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Microphone permission needed");
    expect(document.querySelector(".voice-mode-error")?.textContent).toContain("Microphone permission was denied");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("permission partial");
    expect(retryButton()).toBeInstanceOf(HTMLButtonElement);
  });

  it("surfaces unavailable speech recognition as a non-retryable overlay state", async () => {
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget() });
    });

    expect(voiceApi?.speechSupported).toBe(false);
    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Voice unavailable");
    expect(document.querySelector(".voice-mode-error")?.textContent).toContain("not available");
    expect([...document.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(false);
  });

  it("keeps interim transcript copyable after capture errors", async () => {
    const target = registeredTarget();
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target });
      FakeSpeechRecognition.instances[0]?.interim("interim partial");
      FakeSpeechRecognition.instances[0]?.error("network");
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-error")?.textContent).toBe("network");
    expect(document.querySelector(".voice-mode-buffer")?.textContent).toContain("interim partial");
  });

  it("surfaces no-result timeout through the provider overlay", async () => {
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget() });
      vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS);
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-error")?.textContent).toBe("No speech was detected.");
  });

  it("does not leave the overlay listening when recognition ends without text", async () => {
    await renderProvider();

    await flushReact(() => {
      voiceApi?.startDictation({ target: registeredTarget() });
      FakeSpeechRecognition.instances[0]?.end();
    });

    expect(document.querySelector(".voice-mode-status")?.textContent).toBe("Dictation needs attention");
    expect(document.querySelector(".voice-mode-error")?.textContent).toBe("No speech was detected.");
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

function copyButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Copy");
  if (!(button instanceof HTMLButtonElement)) throw new Error("copy button missing");
  return button;
}

function cancelButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Cancel");
  if (!(button instanceof HTMLButtonElement)) throw new Error("cancel button missing");
  return button;
}

function stopButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Stop");
  if (!(button instanceof HTMLButtonElement)) throw new Error("stop button missing");
  return button;
}

function autoSubmitCheckbox(): HTMLInputElement {
  const checkbox = document.querySelector('.voice-mode-toggle input[type="checkbox"]');
  if (!(checkbox instanceof HTMLInputElement)) throw new Error("auto-submit checkbox missing");
  return checkbox;
}

function registeredTarget(): VoiceTarget {
  return {
    kind: "registered",
    insertText: vi.fn(),
    commit: vi.fn((text: string) => ({ status: "submitted" as const, text })),
    canAcceptVoiceCommit: () => true,
  };
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
