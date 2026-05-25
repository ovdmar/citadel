import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SILENCE_TIMEOUT_MS,
  type SpeechRecognitionCtor,
  createSpeechRecognitionController,
  isSpeechRecognitionSupported,
} from "./speech-recognition-controller.js";

// Minimal hand-rolled stand-in for the browser's SpeechRecognition. We only
// implement the fields/methods the controller actually touches.
class MockRecognition {
  static instances: MockRecognition[] = [];
  // Set on the class to inject a synchronous throw from start(); class-level
  // (not instance-level) so a beforeEach-style mutation applies to the next
  // constructed instance.
  static startThrows: unknown = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null =
    null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;

  constructor() {
    MockRecognition.instances.push(this);
  }

  start(): void {
    this.startCalls += 1;
    if (MockRecognition.startThrows) throw MockRecognition.startThrows;
  }

  stop(): void {
    this.stopCalls += 1;
  }

  abort(): void {
    this.abortCalls += 1;
  }
}

const Ctor = MockRecognition as unknown as SpeechRecognitionCtor;

function emitResult(rec: MockRecognition, transcript: string, isFinal: boolean) {
  rec.onresult?.({
    results: [Object.assign([{ transcript }], { isFinal })],
  } as never);
}

beforeEach(() => {
  MockRecognition.instances.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Scrub the globals the support probe reads. Use `undefined` assignment
  // rather than `delete` so biome's noDelete lint stays quiet; the probe
  // uses `??` so undefined and missing are equivalent.
  (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = undefined;
  (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = undefined;
});

describe("isSpeechRecognitionSupported", () => {
  it("returns false when neither global is exposed", () => {
    expect(isSpeechRecognitionSupported()).toBe(false);
  });

  it("returns true when `webkitSpeechRecognition` is exposed (iOS Safari path)", () => {
    (globalThis as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = MockRecognition;
    expect(isSpeechRecognitionSupported()).toBe(true);
  });

  it("returns true when `SpeechRecognition` is exposed", () => {
    (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition = MockRecognition;
    expect(isSpeechRecognitionSupported()).toBe(true);
  });
});

describe("createSpeechRecognitionController", () => {
  it("start() invokes recognition.start exactly once and reports listening:true", () => {
    const onState = vi.fn();
    const controller = createSpeechRecognitionController({ Ctor, onStateChange: onState });
    controller.start();
    const [rec] = MockRecognition.instances;
    expect(rec?.startCalls).toBe(1);
    expect(onState).toHaveBeenCalledWith(true);
  });

  it("calling start() while already listening is a no-op", () => {
    const controller = createSpeechRecognitionController({ Ctor });
    controller.start();
    controller.start();
    expect(MockRecognition.instances).toHaveLength(1);
    expect(MockRecognition.instances[0]?.startCalls).toBe(1);
  });

  it("forwards a final transcript through onTranscript", () => {
    const onTranscript = vi.fn();
    const controller = createSpeechRecognitionController({ Ctor, onTranscript });
    controller.start();
    const rec = MockRecognition.instances[0];
    if (!rec) throw new Error("expected a mock recognition instance");
    emitResult(rec, "hello world", true);
    expect(onTranscript).toHaveBeenCalledWith("hello world");
  });

  it("after SILENCE_TIMEOUT_MS without results, stop() is called once", () => {
    const onState = vi.fn();
    const controller = createSpeechRecognitionController({ Ctor, onStateChange: onState });
    controller.start();
    const rec = MockRecognition.instances[0];
    if (!rec) throw new Error("expected a mock recognition instance");
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS);
    expect(rec.stopCalls).toBe(1);
  });

  it("an interim result resets the silence timer", () => {
    const controller = createSpeechRecognitionController({ Ctor });
    controller.start();
    const rec = MockRecognition.instances[0];
    if (!rec) throw new Error("expected a mock recognition instance");
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 100);
    emitResult(rec, "ongoing", false);
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS - 100);
    expect(rec.stopCalls).toBe(0);
    vi.advanceTimersByTime(200);
    expect(rec.stopCalls).toBe(1);
  });

  it("when start() throws synchronously (iOS gesture-context failure), the error is surfaced via onError and listening stays false", () => {
    const onError = vi.fn();
    const onState = vi.fn();
    MockRecognition.startThrows = new Error("InvalidStateError");
    try {
      const controller = createSpeechRecognitionController({ Ctor, onError, onStateChange: onState });
      controller.start();
      expect(onError).toHaveBeenCalledWith(expect.stringContaining("InvalidStateError"));
      expect(onState).not.toHaveBeenCalledWith(true);
    } finally {
      MockRecognition.startThrows = null;
    }
  });

  it("propagates recognition.onerror through onError and stops listening", () => {
    const onError = vi.fn();
    const onState = vi.fn();
    const controller = createSpeechRecognitionController({ Ctor, onError, onStateChange: onState });
    controller.start();
    const rec = MockRecognition.instances[0];
    if (!rec) throw new Error("expected a mock recognition instance");
    rec.onerror?.({ error: "no-speech" });
    expect(onError).toHaveBeenCalledWith("no-speech");
    expect(onState).toHaveBeenLastCalledWith(false);
  });

  it("dispose() aborts an in-flight recognition and clears the silence timer", () => {
    const controller = createSpeechRecognitionController({ Ctor });
    controller.start();
    const rec = MockRecognition.instances[0];
    if (!rec) throw new Error("expected a mock recognition instance");
    controller.dispose();
    expect(rec.abortCalls + rec.stopCalls).toBeGreaterThan(0);
    // Timer should no longer fire after dispose; advancing time must not throw or call stop again.
    const stopsBefore = rec.stopCalls;
    vi.advanceTimersByTime(SILENCE_TIMEOUT_MS * 2);
    expect(rec.stopCalls).toBe(stopsBefore);
  });

  it("returns null when the API is unsupported and start() is a no-op", () => {
    const onState = vi.fn();
    const controller = createSpeechRecognitionController({ Ctor: undefined, onStateChange: onState });
    controller.start();
    expect(MockRecognition.instances).toHaveLength(0);
    expect(onState).not.toHaveBeenCalled();
  });
});
