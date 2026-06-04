// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FINAL_AUTO_SUBMIT_DELAY_MS,
  NO_RESULT_SILENCE_TIMEOUT_MS,
  SpeechRecognitionController,
  detectSpeechRecognitionSupport,
} from "./speech-recognition-controller.js";

type RecognitionHandler = ((event: unknown) => void) | null;

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: RecognitionHandler = null;
  onerror: RecognitionHandler = null;
  onend: RecognitionHandler = null;
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  result(items: Array<{ transcript: string; isFinal: boolean }>) {
    this.onresult?.({
      resultIndex: 0,
      results: items.map((item) => ({
        isFinal: item.isFinal,
        0: { transcript: item.transcript },
      })),
    });
  }

  error(error: string) {
    this.onerror?.({ error });
  }
}

describe("detectSpeechRecognitionSupport", () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances = [];
    vi.useFakeTimers();
  });

  it("requires a secure context", () => {
    const win = makeWindow({ secure: false, ctor: FakeSpeechRecognition });
    expect(detectSpeechRecognitionSupport(win)).toEqual({ supported: false, reason: "insecure-context" });
  });

  it("detects prefixed webkitSpeechRecognition", () => {
    const win = makeWindow({ secure: true, webkitCtor: FakeSpeechRecognition });
    expect(detectSpeechRecognitionSupport(win).supported).toBe(true);
  });
});

describe("SpeechRecognitionController", () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances = [];
    vi.useFakeTimers();
  });

  it("configures en-US recognition and starts listening", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });

    expect(controller.start()).toBe(true);

    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition?.lang).toBe("en-US");
    expect(recognition?.interimResults).toBe(true);
    expect(recognition?.continuous).toBe(false);
    expect(recognition?.start).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ type: "listening" });
  });

  it("emits interim text without committing it, then commits final after the delay", () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onInterim, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "hello wor", isFinal: false }]);
    expect(onInterim).toHaveBeenCalledWith("hello wor");
    expect(onFinal).not.toHaveBeenCalled();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "hello world", isFinal: true }]);
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFinal).toHaveBeenCalledWith("hello world");
    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalled();
  });

  it("hard-stops after 10s without recognition results", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });
    controller.start();

    vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS);

    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ type: "no-result-timeout" });
  });

  it("restarts the silence timer after each recognition result", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });
    controller.start();

    vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS - 1);
    FakeSpeechRecognition.instances[0]?.result([{ transcript: "still listening", isFinal: false }]);
    vi.advanceTimersByTime(1);

    expect(onState).not.toHaveBeenCalledWith({ type: "no-result-timeout" });
    expect(FakeSpeechRecognition.instances[0]?.stop).not.toHaveBeenCalled();

    vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS);

    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ type: "no-result-timeout" });
  });

  it("surfaces start failures as retry-required while preserving the target outside the controller", () => {
    const onState = vi.fn();
    class ThrowingRecognition extends FakeSpeechRecognition {
      override start = vi.fn(() => {
        throw new DOMException("activation rejected", "NotAllowedError");
      });
    }
    const controller = new SpeechRecognitionController({ win: makeWindow({ ctor: ThrowingRecognition }), onState });

    expect(controller.start()).toBe(false);
    expect(onState).toHaveBeenCalledWith({ type: "start-retry-required", message: "activation rejected" });
  });

  it("distinguishes permission errors from capture errors", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });
    controller.start();

    FakeSpeechRecognition.instances[0]?.error("not-allowed");
    expect(onState).toHaveBeenCalledWith({ type: "permission-denied", message: "not-allowed" });

    controller.start();
    FakeSpeechRecognition.instances[1]?.error("network");
    expect(onState).toHaveBeenCalledWith({ type: "capture-error", message: "network" });
  });
});

function makeWindow(
  options: { secure?: boolean; ctor?: typeof FakeSpeechRecognition; webkitCtor?: typeof FakeSpeechRecognition } = {},
) {
  return {
    isSecureContext: options.secure ?? true,
    SpeechRecognition: options.ctor ?? FakeSpeechRecognition,
    webkitSpeechRecognition: options.webkitCtor,
  } as unknown as Window;
}
