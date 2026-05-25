// Pure (non-React) wrapper around the Web Speech API. Owns the silence
// timer and the supported/listening state machine so the React hook in
// use-speech-recognition.ts stays a thin adapter and the logic is
// unit-testable without RTL.

// 10s — long enough to cover thinking pauses during multi-sentence dictation;
// short enough that the mic doesn't run forever if the user walks away.
export const SILENCE_TIMEOUT_MS = 10_000;

// We only depend on the SpeechRecognition constructor's *shape* — the runtime
// objects are browser-provided. Typed loosely on purpose to avoid pulling in
// `lib.dom`'s experimental SpeechRecognition typings that drift across TS
// versions.
type RecognitionEventResultItem = { transcript: string };
type RecognitionEventResult = ArrayLike<RecognitionEventResultItem> & { isFinal: boolean };
type RecognitionEvent = { results: ArrayLike<RecognitionEventResult> };
type ErrorEvent = { error: string };

type RecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

export type SpeechRecognitionCtor = new () => RecognitionInstance;

export type SpeechRecognitionController = {
  start(): void;
  stop(): void;
  dispose(): void;
};

export type SpeechRecognitionControllerInput = {
  Ctor: SpeechRecognitionCtor | undefined;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
  onStateChange?: (listening: boolean) => void;
  silenceTimeoutMs?: number;
};

export function isSpeechRecognitionSupported(): boolean {
  return resolveCtor() !== undefined;
}

export function resolveCtor(): SpeechRecognitionCtor | undefined {
  const g = globalThis as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

export function createSpeechRecognitionController(input: SpeechRecognitionControllerInput): SpeechRecognitionController {
  const { Ctor, onTranscript, onError, onStateChange } = input;
  const silenceMs = input.silenceTimeoutMs ?? SILENCE_TIMEOUT_MS;
  let active: RecognitionInstance | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function armSilenceTimer() {
    clearSilenceTimer();
    silenceTimer = setTimeout(() => {
      active?.stop();
    }, silenceMs);
  }

  function stopAndReport() {
    clearSilenceTimer();
    active = null;
    onStateChange?.(false);
  }

  return {
    start() {
      if (disposed || active || !Ctor) return;
      const recognition = new Ctor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event: RecognitionEvent) => {
        armSilenceTimer();
        const last = event.results[event.results.length - 1];
        if (!last || !last.isFinal) return;
        const piece = last[0]?.transcript ?? "";
        if (piece) onTranscript?.(piece.trim());
      };
      recognition.onerror = (event: ErrorEvent) => {
        onError?.(event.error);
        stopAndReport();
      };
      recognition.onend = () => {
        stopAndReport();
      };
      try {
        recognition.start();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError?.(message);
        return;
      }
      active = recognition;
      armSilenceTimer();
      onStateChange?.(true);
    },
    stop() {
      active?.stop();
    },
    dispose() {
      disposed = true;
      clearSilenceTimer();
      if (active) {
        try {
          active.abort();
        } catch {
          // ignore
        }
        active = null;
      }
    },
  };
}
