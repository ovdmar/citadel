export const DEFAULT_VOICE_SILENCE_TIMEOUT_MS = 15_000;
export const MIN_VOICE_SILENCE_TIMEOUT_MS = 3_000;
export const MAX_VOICE_SILENCE_TIMEOUT_MS = 30_000;
export const FINAL_AUTO_SUBMIT_DELAY_MS = DEFAULT_VOICE_SILENCE_TIMEOUT_MS;
export const NO_RESULT_SILENCE_TIMEOUT_MS = DEFAULT_VOICE_SILENCE_TIMEOUT_MS;

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionResultEventLike = {
  resultIndex?: number;
  results: ArrayLike<{
    isFinal: boolean;
    0?: { transcript?: string };
  }>;
};

type SpeechRecognitionErrorEventLike = {
  error?: string;
  message?: string;
};

type SpeechRecognitionWindow = Pick<Window, "isSecureContext"> & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type SpeechRecognitionSupport =
  | { supported: true; Recognition: SpeechRecognitionConstructor }
  | { supported: false; reason: "insecure-context" | "unavailable" };

type SpeechRecognitionControllerState =
  | { type: "idle" }
  | { type: "listening" }
  | { type: "unavailable"; reason: "insecure-context" | "unavailable" }
  | { type: "start-retry-required"; message: string }
  | { type: "permission-denied"; message: string; transcript?: string }
  | { type: "capture-error"; message: string; transcript?: string }
  | { type: "no-result-timeout"; transcript?: string }
  | { type: "stopped"; transcript?: string };

type TranscriptControllerState = Extract<
  SpeechRecognitionControllerState,
  { type: "permission-denied" | "capture-error" | "no-result-timeout" | "stopped" }
>;

type SpeechRecognitionControllerOptions = {
  win?: Window;
  silenceTimeoutMs?: number;
  onState?: (state: SpeechRecognitionControllerState) => void;
  onInterim?: (text: string) => void;
  onDraft?: (text: string) => void;
  onFinal?: (text: string) => void | Promise<void>;
};

export function normalizeVoiceSilenceTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VOICE_SILENCE_TIMEOUT_MS;
  const rounded = Math.round(value);
  return Math.min(MAX_VOICE_SILENCE_TIMEOUT_MS, Math.max(MIN_VOICE_SILENCE_TIMEOUT_MS, rounded));
}

export function detectSpeechRecognitionSupport(win: Window = window): SpeechRecognitionSupport {
  const candidate = win as SpeechRecognitionWindow;
  if (!candidate.isSecureContext) return { supported: false, reason: "insecure-context" };
  const Recognition = candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
  if (!Recognition) return { supported: false, reason: "unavailable" };
  return { supported: true, Recognition };
}

export class SpeechRecognitionController {
  private recognition: SpeechRecognitionLike | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTranscript = "";
  private interimTranscript = "";
  private generation = 0;
  private readonly win: Window;
  private silenceTimeoutMs: number;

  constructor(private readonly options: SpeechRecognitionControllerOptions = {}) {
    this.win = options.win ?? window;
    this.silenceTimeoutMs = normalizeVoiceSilenceTimeoutMs(
      options.silenceTimeoutMs ?? DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
    );
  }

  setSilenceTimeoutMs(value: number): void {
    this.silenceTimeoutMs = normalizeVoiceSilenceTimeoutMs(value);
    if (this.finalTimer !== null) {
      this.armFinalTimer();
    } else if (this.silenceTimer !== null) {
      this.armSilenceTimer();
    }
  }

  start(): boolean {
    this.clearTimers();
    this.detachRecognition();
    this.finalTranscript = "";
    this.interimTranscript = "";
    this.generation += 1;
    const generation = this.generation;
    const support = detectSpeechRecognitionSupport(this.win);
    if (!support.supported) {
      this.options.onState?.({
        type: "unavailable",
        reason: support.reason,
      });
      return false;
    }
    const recognition = new support.Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      if (this.isCurrentRecognition(recognition, generation)) this.handleResult(event);
    };
    recognition.onerror = (event) => {
      if (this.isCurrentRecognition(recognition, generation)) this.handleError(event);
    };
    recognition.onend = () => {
      if (!this.isCurrentRecognition(recognition, generation)) return;
      this.clearSilenceTimer();
      if (this.finalTimer !== null) return;
      const transcript = this.consumePartialTranscript();
      this.releaseRecognition();
      this.options.onState?.(withTranscript({ type: "stopped" }, transcript));
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "start_failed";
      this.options.onState?.({ type: "start-retry-required", message });
      clearRecognitionHandlers(recognition);
      this.recognition = null;
      return false;
    }
    this.options.onState?.({ type: "listening" });
    this.armSilenceTimer();
    return true;
  }

  commitCurrent(): boolean {
    const transcript = this.consumePartialTranscript();
    this.clearTimers();
    this.stopRecognition();
    if (!transcript) {
      this.options.onState?.({ type: "stopped" });
      return false;
    }
    void this.options.onFinal?.(transcript);
    return true;
  }

  stop(options: { commitFinal?: boolean } = { commitFinal: true }): void {
    const finalTranscript = this.finalTranscript;
    if (finalTranscript && !this.interimTranscript && options.commitFinal !== false) {
      this.finalTranscript = "";
      this.clearInterimTranscript();
      this.clearTimers();
      this.stopRecognition();
      this.options.onFinal?.(finalTranscript);
      return;
    }
    const transcript = this.consumePartialTranscript();
    this.clearTimers();
    this.stopRecognition();
    this.options.onState?.(withTranscript({ type: "stopped" }, transcript));
  }

  abort(): void {
    this.clearTimers();
    const recognition = this.releaseRecognition();
    recognition?.abort();
  }

  dispose(): void {
    this.abort();
  }

  private handleResult(event: SpeechRecognitionResultEventLike): void {
    this.armSilenceTimer();
    let interim = "";
    let final = "";
    const start = event.resultIndex ?? 0;
    for (let index = start; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (!result) continue;
      const transcript = result[0]?.transcript ?? "";
      if (!transcript) continue;
      if (result.isFinal) {
        final += transcript;
      } else {
        interim += transcript;
      }
    }
    if (interim) {
      this.clearFinalTimer();
      this.interimTranscript = interim;
      this.options.onInterim?.(interim);
    }
    if (final) {
      this.finalTranscript += final;
      this.clearFinalTimer();
    }
    if (!interim && !final) return;
    if (final && !interim) {
      this.clearInterimTranscript();
      this.clearSilenceTimer();
      this.armFinalTimer();
    }
    this.emitDraft();
  }

  private handleError(event: SpeechRecognitionErrorEventLike): void {
    this.clearTimers();
    const message = event.error || event.message || "capture_error";
    const transcript = this.consumePartialTranscript();
    this.releaseRecognition();
    if (message === "not-allowed" || message === "service-not-allowed") {
      this.options.onState?.(withTranscript({ type: "permission-denied", message }, transcript));
    } else {
      this.options.onState?.(withTranscript({ type: "capture-error", message }, transcript));
    }
  }

  private armSilenceTimer(): void {
    this.clearSilenceTimer();
    this.silenceTimer = setTimeout(() => {
      this.options.onState?.(withTranscript({ type: "no-result-timeout" }, this.consumePartialTranscript()));
      this.clearTimers();
      this.stopRecognition();
    }, this.silenceTimeoutMs);
  }

  private armFinalTimer(): void {
    this.clearFinalTimer();
    this.finalTimer = setTimeout(() => {
      const text = this.finalTranscript;
      this.finalTimer = null;
      this.finalTranscript = "";
      this.clearInterimTranscript();
      this.clearSilenceTimer();
      this.emitDraft();
      if (text) this.options.onFinal?.(text);
      this.stopRecognition();
    }, this.silenceTimeoutMs);
  }

  private consumePartialTranscript(): string | undefined {
    const transcript = `${this.finalTranscript}${this.interimTranscript}`;
    this.finalTranscript = "";
    this.clearInterimTranscript();
    this.emitDraft();
    return transcript.length > 0 ? transcript : undefined;
  }

  private clearInterimTranscript(): void {
    if (!this.interimTranscript) return;
    this.interimTranscript = "";
    this.options.onInterim?.("");
  }

  private clearTimers(): void {
    this.clearFinalTimer();
    this.clearSilenceTimer();
  }

  private clearFinalTimer(): void {
    if (this.finalTimer !== null) {
      clearTimeout(this.finalTimer);
      this.finalTimer = null;
    }
  }

  private clearSilenceTimer(): void {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private isCurrentRecognition(recognition: SpeechRecognitionLike, generation: number): boolean {
    return this.recognition === recognition && this.generation === generation;
  }

  private releaseRecognition(): SpeechRecognitionLike | null {
    const recognition = this.recognition;
    if (!recognition) return null;
    clearRecognitionHandlers(recognition);
    this.recognition = null;
    this.generation += 1;
    return recognition;
  }

  private stopRecognition(): void {
    const recognition = this.releaseRecognition();
    recognition?.stop();
  }

  private detachRecognition(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    clearRecognitionHandlers(recognition);
    this.recognition = null;
  }

  private emitDraft(): void {
    this.options.onDraft?.(`${this.finalTranscript}${this.interimTranscript}`);
  }
}

function withTranscript(state: TranscriptControllerState, transcript: string | undefined): TranscriptControllerState {
  return transcript ? { ...state, transcript } : state;
}

function clearRecognitionHandlers(recognition: SpeechRecognitionLike): void {
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
}
