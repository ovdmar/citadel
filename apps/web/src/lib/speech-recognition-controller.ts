export const FINAL_AUTO_SUBMIT_DELAY_MS = 900;
export const NO_RESULT_SILENCE_TIMEOUT_MS = 10_000;

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

export type SpeechRecognitionSupport =
  | { supported: true; Recognition: SpeechRecognitionConstructor }
  | { supported: false; reason: "insecure-context" | "unavailable" };

export type SpeechRecognitionControllerState =
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

export type SpeechRecognitionControllerOptions = {
  win?: Window;
  onState?: (state: SpeechRecognitionControllerState) => void;
  onInterim?: (text: string) => void;
  onFinal?: (text: string) => void;
};

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

  constructor(private readonly options: SpeechRecognitionControllerOptions = {}) {
    this.win = options.win ?? window;
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
    recognition.continuous = false;
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

  stop(): void {
    this.clearTimers();
    const recognition = this.releaseRecognition();
    recognition?.stop();
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
      this.interimTranscript = interim;
      this.options.onInterim?.(interim);
    }
    if (!final) return;
    this.finalTranscript += final;
    this.clearInterimTranscript();
    this.clearFinalTimer();
    this.finalTimer = setTimeout(() => {
      const text = this.finalTranscript;
      this.finalTranscript = "";
      this.clearInterimTranscript();
      if (text) this.options.onFinal?.(text);
      this.stop();
    }, FINAL_AUTO_SUBMIT_DELAY_MS);
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
      this.stop();
    }, NO_RESULT_SILENCE_TIMEOUT_MS);
  }

  private consumePartialTranscript(): string | undefined {
    const transcript = `${this.finalTranscript}${this.interimTranscript}`;
    this.finalTranscript = "";
    this.clearInterimTranscript();
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

  private detachRecognition(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    clearRecognitionHandlers(recognition);
    this.recognition = null;
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
