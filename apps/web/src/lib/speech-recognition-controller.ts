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
  private readonly win: Window;

  constructor(private readonly options: SpeechRecognitionControllerOptions = {}) {
    this.win = options.win ?? window;
  }

  start(): boolean {
    this.clearTimers();
    this.finalTranscript = "";
    this.interimTranscript = "";
    const support = detectSpeechRecognitionSupport(this.win);
    if (!support.supported) {
      this.options.onState?.({
        type: "capture-error",
        message: support.reason,
      });
      return false;
    }
    const recognition = new support.Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => this.handleResult(event);
    recognition.onerror = (event) => this.handleError(event);
    recognition.onend = () => {
      this.clearSilenceTimer();
      if (this.finalTimer !== null) return;
      this.options.onState?.(withTranscript({ type: "stopped" }, this.consumePartialTranscript()));
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : "start_failed";
      this.options.onState?.({ type: "start-retry-required", message });
      this.recognition = null;
      return false;
    }
    this.options.onState?.({ type: "listening" });
    this.armSilenceTimer();
    return true;
  }

  stop(): void {
    this.clearTimers();
    this.recognition?.stop();
  }

  abort(): void {
    this.clearTimers();
    this.recognition?.abort();
  }

  dispose(): void {
    this.abort();
    this.recognition = null;
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
    this.interimTranscript = "";
    this.clearFinalTimer();
    this.finalTimer = setTimeout(() => {
      const text = this.finalTranscript;
      this.finalTranscript = "";
      this.interimTranscript = "";
      if (text) this.options.onFinal?.(text);
      this.stop();
    }, FINAL_AUTO_SUBMIT_DELAY_MS);
  }

  private handleError(event: SpeechRecognitionErrorEventLike): void {
    this.clearTimers();
    const message = event.error || event.message || "capture_error";
    const transcript = this.consumePartialTranscript();
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
      this.recognition?.stop();
    }, NO_RESULT_SILENCE_TIMEOUT_MS);
  }

  private consumePartialTranscript(): string | undefined {
    const transcript = `${this.finalTranscript}${this.interimTranscript}`;
    this.finalTranscript = "";
    this.interimTranscript = "";
    return transcript.length > 0 ? transcript : undefined;
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
}

function withTranscript(state: TranscriptControllerState, transcript: string | undefined): TranscriptControllerState {
  return transcript ? { ...state, transcript } : state;
}
