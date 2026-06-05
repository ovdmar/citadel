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

  end() {
    this.onend?.({});
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
    const win = makeWindow({ secure: true, ctor: null, webkitCtor: FakeSpeechRecognition });
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

  it("starts with prefixed recognition when unprefixed recognition is absent", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({
      win: makeWindow({ ctor: null, webkitCtor: FakeSpeechRecognition }),
      onState,
    });

    expect(controller.start()).toBe(true);

    const recognition = FakeSpeechRecognition.instances[0];
    expect(recognition).toBeInstanceOf(FakeSpeechRecognition);
    expect(recognition?.lang).toBe("en-US");
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
    expect(onInterim).toHaveBeenLastCalledWith("");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS - 1);
    expect(onFinal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onFinal).toHaveBeenCalledWith("hello world");
    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalled();
  });

  it("keeps mixed final and interim results open until the interim tail finalizes", () => {
    const onInterim = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onInterim, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([
      { transcript: "hello ", isFinal: true },
      { transcript: "wor", isFinal: false },
    ]);
    expect(onInterim).toHaveBeenLastCalledWith("wor");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    expect(onFinal).not.toHaveBeenCalled();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "world", isFinal: true }]);
    expect(onInterim).toHaveBeenLastCalledWith("");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(onFinal).toHaveBeenCalledWith("hello world");
  });

  it("keeps mixed final and interim results copyable when stopped before finalization", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([
      { transcript: "hello ", isFinal: true },
      { transcript: "wor", isFinal: false },
    ]);
    controller.stop();

    expect(onFinal).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ type: "stopped", transcript: "hello wor" });
  });

  it("does not emit a no-result timeout after final auto-submit", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "done", isFinal: true }]);
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);
    vi.advanceTimersByTime(NO_RESULT_SILENCE_TIMEOUT_MS);

    expect(onFinal).toHaveBeenCalledWith("done");
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ type: "no-result-timeout" }));
  });

  it("commits a pending final transcript immediately when stopped", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "captured final", isFinal: true }]);
    controller.stop();
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(onFinal).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith("captured final");
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ type: "stopped" }));
  });

  it("commits pending final text when recognition ends before the final delay", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "race final", isFinal: true }]);
    FakeSpeechRecognition.instances[0]?.end();
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(onFinal).toHaveBeenCalledOnce();
    expect(onFinal).toHaveBeenCalledWith("race final");
    expect(FakeSpeechRecognition.instances[0]?.stop).toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ type: "stopped" }));
  });

  it("keeps interim transcript copyable when stopped before a final result", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "partial text", isFinal: false }]);
    controller.stop();

    expect(onFinal).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({ type: "stopped", transcript: "partial text" });
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
    expect(onState).toHaveBeenCalledWith({ type: "no-result-timeout", transcript: "still listening" });
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

  it("surfaces unsupported speech recognition as unavailable", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow({ ctor: null }), onState });

    expect(controller.start()).toBe(false);

    expect(onState).toHaveBeenCalledWith({ type: "unavailable", reason: "unavailable" });
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

  it("treats service-not-allowed as permission denial while preserving partial transcript", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "service partial", isFinal: false }]);
    FakeSpeechRecognition.instances[0]?.error("service-not-allowed");

    expect(onState).toHaveBeenCalledWith({
      type: "permission-denied",
      message: "service-not-allowed",
      transcript: "service partial",
    });
  });

  it("detaches disposed recognition callbacks and cancels pending commits", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();
    const staleRecognition = FakeSpeechRecognition.instances[0];
    if (!staleRecognition) throw new Error("recognition instance missing");

    staleRecognition.result([{ transcript: "stale final", isFinal: true }]);
    controller.dispose();
    staleRecognition.result([{ transcript: "late final", isFinal: true }]);
    staleRecognition.error("network");
    staleRecognition.end();
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(staleRecognition.onresult).toBeNull();
    expect(staleRecognition.onerror).toBeNull();
    expect(staleRecognition.onend).toBeNull();
    expect(onFinal).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ type: "capture-error" }));
  });

  it("keeps a pending final transcript copyable when a recognition error fires before commit", () => {
    const onState = vi.fn();
    const onFinal = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState, onFinal });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "captured text", isFinal: true }]);
    FakeSpeechRecognition.instances[0]?.error("network");
    vi.advanceTimersByTime(FINAL_AUTO_SUBMIT_DELAY_MS);

    expect(onFinal).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({
      type: "capture-error",
      message: "network",
      transcript: "captured text",
    });
  });

  it("keeps interim transcript copyable when recognition ends without final text", () => {
    const onState = vi.fn();
    const controller = new SpeechRecognitionController({ win: makeWindow(), onState });
    controller.start();

    FakeSpeechRecognition.instances[0]?.result([{ transcript: "partial thought", isFinal: false }]);
    FakeSpeechRecognition.instances[0]?.end();

    expect(onState).toHaveBeenCalledWith({ type: "stopped", transcript: "partial thought" });
  });
});

function makeWindow(
  options: {
    secure?: boolean;
    ctor?: typeof FakeSpeechRecognition | null;
    webkitCtor?: typeof FakeSpeechRecognition | null;
  } = {},
) {
  return {
    isSecureContext: options.secure ?? true,
    SpeechRecognition: options.ctor === null ? undefined : (options.ctor ?? FakeSpeechRecognition),
    webkitSpeechRecognition: options.webkitCtor === null ? undefined : options.webkitCtor,
  } as unknown as Window;
}
