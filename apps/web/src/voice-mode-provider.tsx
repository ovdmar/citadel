import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
  SpeechRecognitionController,
  detectSpeechRecognitionSupport,
  normalizeVoiceSilenceTimeoutMs,
} from "./lib/speech-recognition-controller.js";
import {
  type VoiceCommitResult,
  type VoiceCommitResultLike,
  type VoiceTarget,
  VoiceTargetRegistry,
} from "./lib/voice-targets.js";
import { matchShortcut } from "./shortcuts.js";
import { getFocusedTerminalSessionId, getTerminalHandle } from "./terminal-pane.js";
import { VoiceModeOverlay, type VoiceModeOverlayStatus } from "./voice-mode-overlay.js";

const AUTO_SUBMIT_KEY = "citadel.voice.autoSubmit";
const SILENCE_TIMEOUT_KEY = "citadel.voice.silenceTimeoutMs";

type StartDictationOptions = {
  target?: VoiceTarget | null;
  terminalSessionId?: string;
};

type StopDictationOptions = {
  commitFinal?: boolean;
};

export type VoiceModeContextValue = {
  autoSubmit: boolean;
  silenceTimeoutMs: number;
  speechSupported: boolean;
  registerTarget: (element: HTMLElement, target: VoiceTarget) => () => void;
  startDictation: (options?: StartDictationOptions) => boolean;
  stopDictation: (options?: StopDictationOptions) => void;
  setAutoSubmit: (next: boolean) => void;
  setSilenceTimeoutMs: (nextMs: number) => void;
};

const VoiceModeContext = createContext<VoiceModeContextValue | null>(null);

export function VoiceModeProvider(props: { children: ReactNode }) {
  const registryRef = useRef(new VoiceTargetRegistry());
  const controllerRef = useRef<SpeechRecognitionController | null>(null);
  const targetRef = useRef<VoiceTarget | null>(null);
  const lastStartRef = useRef<StartDictationOptions | undefined>(undefined);
  const activeRunRef = useRef(0);
  const mountedRef = useRef(true);
  const [autoSubmit, setAutoSubmitState] = useState(readAutoSubmit);
  const autoSubmitRef = useRef(autoSubmit);
  const [silenceTimeoutMs, setSilenceTimeoutMsState] = useState(readSilenceTimeoutMs);
  const silenceTimeoutMsRef = useRef(silenceTimeoutMs);
  const [overlayActive, setOverlayActive] = useState(false);
  const [status, setStatusState] = useState<VoiceModeOverlayStatus>("idle");
  const statusRef = useRef<VoiceModeOverlayStatus>("idle");
  const [draft, setDraft] = useState("");
  const [buffer, setBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const speechSupported = typeof window !== "undefined" ? detectSpeechRecognitionSupport(window).supported : false;

  useEffect(() => {
    autoSubmitRef.current = autoSubmit;
  }, [autoSubmit]);

  useEffect(() => {
    silenceTimeoutMsRef.current = silenceTimeoutMs;
    controllerRef.current?.setSilenceTimeoutMs(silenceTimeoutMs);
  }, [silenceTimeoutMs]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.dispose();
    };
  }, []);

  const setStatus = useCallback((next: VoiceModeOverlayStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);

  const setAutoSubmit = useCallback((next: boolean) => {
    setAutoSubmitState(next);
    try {
      if (typeof window !== "undefined") window.localStorage?.setItem(AUTO_SUBMIT_KEY, next ? "1" : "0");
    } catch {
      /* local persistence is best-effort */
    }
  }, []);

  const setSilenceTimeoutMs = useCallback((nextMs: number) => {
    const normalized = normalizeVoiceSilenceTimeoutMs(nextMs);
    silenceTimeoutMsRef.current = normalized;
    setSilenceTimeoutMsState(normalized);
    controllerRef.current?.setSilenceTimeoutMs(normalized);
    try {
      if (typeof window !== "undefined") window.localStorage?.setItem(SILENCE_TIMEOUT_KEY, String(normalized));
    } catch {
      /* local persistence is best-effort */
    }
  }, []);

  const registerTarget = useCallback((element: HTMLElement, target: VoiceTarget) => {
    return registryRef.current.register(element, target);
  }, []);

  const applyCommitResult = useCallback(
    (runId: number, result: VoiceCommitResult) => {
      if (!mountedRef.current || runId !== activeRunRef.current) return;
      if (result.status === "buffered") {
        setBuffer(result.text);
        setStatus(result.cause === "commit-error" ? "error" : "no-target");
        setError(result.reason);
        return;
      }
      setBuffer(result.text);
      setStatus(result.status === "submitted" ? "submitted" : "inserted");
      setError(result.status === "inserted-not-submitted" ? "Inserted, not submitted." : null);
    },
    [setStatus],
  );

  const commitFinal = useCallback(
    (text: string) => {
      const runId = activeRunRef.current;
      const target = targetRef.current;
      if (!target || !target.canAcceptVoiceCommit()) {
        setBuffer(text);
        setStatus("no-target");
        setError("No focused input is available. Copy the dictated text and paste it where you need it.");
        return;
      }
      const result = commitToTargetSafely(target, text, autoSubmitRef.current);
      if (isPromiseLike(result)) {
        void result.then((resolved) => applyCommitResult(runId, resolved));
        return;
      }
      applyCommitResult(runId, result);
    },
    [applyCommitResult, setStatus],
  );

  const startDictation = useCallback(
    (options?: StartDictationOptions): boolean => {
      const resolved = resolveStartDictation(options, registryRef.current);
      activeRunRef.current += 1;
      lastStartRef.current = resolved.retryOptions;
      const target = resolved.target;
      targetRef.current = target;
      setOverlayActive(true);
      setStatus("listening");
      setDraft("");
      setBuffer("");
      setError(null);
      controllerRef.current?.dispose();
      const controller = new SpeechRecognitionController({
        silenceTimeoutMs: silenceTimeoutMsRef.current,
        onDraft: setDraft,
        onFinal: commitFinal,
        onState: (state) => {
          if (state.type === "listening") {
            setStatus("listening");
          } else if (state.type === "unavailable") {
            setStatus("unavailable");
            setError(speechUnavailableMessage(state.reason));
          } else if (state.type === "start-retry-required") {
            setStatus("retry");
            setError(state.message);
          } else if (state.type === "permission-denied") {
            keepPartialTranscript(state.transcript, setBuffer, setDraft);
            setStatus("permission-denied");
            setError("Microphone permission was denied.");
          } else if (state.type === "capture-error") {
            keepPartialTranscript(state.transcript, setBuffer, setDraft);
            setStatus("error");
            setError(state.message);
          } else if (state.type === "no-result-timeout") {
            keepPartialTranscript(state.transcript, setBuffer, setDraft);
            setStatus("error");
            setError("No speech was detected.");
          } else if (state.type === "stopped" && statusRef.current === "listening") {
            keepPartialTranscript(state.transcript, setBuffer, setDraft);
            setStatus("error");
            setError(
              state.transcript
                ? "Dictation ended before submission. Copy the dictated text."
                : "No speech was detected.",
            );
          }
        },
      });
      controllerRef.current = controller;
      return controller.start();
    },
    [commitFinal, setStatus],
  );

  const stop = useCallback((options?: StopDictationOptions) => {
    controllerRef.current?.stop({ commitFinal: options?.commitFinal ?? true });
    setDraft("");
  }, []);

  const sendNow = useCallback(() => {
    const committed = controllerRef.current?.commitCurrent() ?? false;
    if (committed) return;
    setDraft("");
    setStatus("error");
    setError("No speech was detected.");
  }, [setStatus]);

  const cancel = useCallback(() => {
    activeRunRef.current += 1;
    controllerRef.current?.abort();
    setOverlayActive(false);
    setStatus("idle");
    setDraft("");
    setBuffer("");
    setError(null);
  }, [setStatus]);

  const retry = useCallback(() => {
    startDictation(lastStartRef.current);
  }, [startDictation]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const match = matchShortcut(event);
      if (match?.id !== "voice-dictation") return;
      if (getFocusedTerminalSessionId(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      startDictation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [startDictation]);

  const value = useMemo<VoiceModeContextValue>(
    () => ({
      autoSubmit,
      silenceTimeoutMs,
      speechSupported,
      registerTarget,
      startDictation,
      stopDictation: stop,
      setAutoSubmit,
      setSilenceTimeoutMs,
    }),
    [
      autoSubmit,
      silenceTimeoutMs,
      speechSupported,
      registerTarget,
      startDictation,
      stop,
      setAutoSubmit,
      setSilenceTimeoutMs,
    ],
  );

  return (
    <VoiceModeContext.Provider value={value}>
      {props.children}
      <VoiceModeOverlay
        active={overlayActive}
        status={status}
        draft={draft}
        buffer={buffer}
        error={error}
        autoSubmit={autoSubmit}
        silenceTimeoutMs={silenceTimeoutMs}
        onAutoSubmitChange={setAutoSubmit}
        onSilenceTimeoutChange={setSilenceTimeoutMs}
        onSendNow={sendNow}
        onStop={() => stop()}
        onCancel={cancel}
        onRetry={retry}
      />
    </VoiceModeContext.Provider>
  );
}

export function useVoiceMode(): VoiceModeContextValue {
  const value = useContext(VoiceModeContext);
  if (!value) throw new Error("useVoiceMode must be used inside VoiceModeProvider");
  return value;
}

function readAutoSubmit(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage?.getItem(AUTO_SUBMIT_KEY) !== "0";
  } catch {
    return true;
  }
}

function readSilenceTimeoutMs(): number {
  if (typeof window === "undefined") return DEFAULT_VOICE_SILENCE_TIMEOUT_MS;
  try {
    const stored = window.localStorage?.getItem(SILENCE_TIMEOUT_KEY);
    return stored === null ? DEFAULT_VOICE_SILENCE_TIMEOUT_MS : normalizeVoiceSilenceTimeoutMs(Number(stored));
  } catch {
    return DEFAULT_VOICE_SILENCE_TIMEOUT_MS;
  }
}

function commitToTargetSafely(target: VoiceTarget, text: string, autoSubmit: boolean): VoiceCommitResultLike {
  try {
    const result = commitToTarget(target, text, autoSubmit);
    if (isPromiseLike(result)) return result.catch((error) => bufferedCommitError(text, error));
    return result;
  } catch (error) {
    return bufferedCommitError(text, error);
  }
}

function commitToTarget(target: VoiceTarget, text: string, autoSubmit: boolean): VoiceCommitResultLike {
  if (target.commit) return target.commit(text, { autoSubmit });
  target.insertText(text);
  if (autoSubmit && target.submit) {
    const submitResult = target.submit();
    if (isPromiseLike(submitResult)) return submitResult.then(() => ({ status: "submitted", text }));
    return { status: "submitted", text };
  }
  return { status: "inserted-not-submitted", text };
}

function bufferedCommitError(text: string, error: unknown): VoiceCommitResult {
  return {
    status: "buffered",
    text,
    cause: "commit-error",
    reason: commitErrorMessage(error),
  };
}

function commitErrorMessage(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : "Dictation could not be submitted.";
  return `${message} Copy the dictated text.`;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}

function keepPartialTranscript(
  transcript: string | undefined,
  setBuffer: (text: string) => void,
  setInterim: (text: string) => void,
): void {
  if (!transcript) return;
  setBuffer(transcript);
  setInterim("");
}

function speechUnavailableMessage(reason: "insecure-context" | "unavailable"): string {
  if (reason === "insecure-context") return "Voice dictation requires a secure browser context.";
  return "Voice dictation is not available in this browser.";
}

function resolveStartDictation(
  options: StartDictationOptions | undefined,
  registry: VoiceTargetRegistry,
): { target: VoiceTarget | null; retryOptions: StartDictationOptions } {
  if (options?.target !== undefined) {
    return { target: options.target, retryOptions: { target: options.target } };
  }
  if (options?.terminalSessionId) {
    const target = createTerminalVoiceTarget(options.terminalSessionId);
    return { target, retryOptions: { terminalSessionId: options.terminalSessionId } };
  }
  const focusedTerminalSessionId = getFocusedTerminalSessionId(document.activeElement);
  if (focusedTerminalSessionId) {
    const target = createTerminalVoiceTarget(focusedTerminalSessionId);
    return { target, retryOptions: { terminalSessionId: focusedTerminalSessionId } };
  }
  const target = registry.resolve(document.activeElement);
  return { target, retryOptions: { target } };
}

function createTerminalVoiceTarget(sessionId: string): VoiceTarget | null {
  return {
    kind: "terminal",
    insertText: (text) => {
      getTerminalHandle(sessionId)?.sendVoiceInput?.(text, { submit: false });
    },
    commit: (text, options) => {
      const ok = getTerminalHandle(sessionId)?.sendVoiceInput?.(text, { submit: options.autoSubmit }) ?? false;
      if (!ok) return { status: "buffered", text, reason: "The terminal is not connected. Copy the dictated text." };
      return { status: options.autoSubmit ? "submitted" : "inserted-not-submitted", text };
    },
    canAcceptVoiceCommit: () => getTerminalHandle(sessionId)?.canAcceptVoiceInput() ?? false,
  };
}
