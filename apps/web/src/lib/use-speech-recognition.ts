import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type SpeechRecognitionController,
  createSpeechRecognitionController,
  isSpeechRecognitionSupported,
  resolveCtor,
} from "./speech-recognition-controller.js";

export type UseSpeechRecognitionInput = {
  onTranscript: (text: string) => void;
};

export type UseSpeechRecognition = {
  supported: boolean;
  listening: boolean;
  error: string | null;
  start: () => void;
  stop: () => void;
};

// Thin React adapter around createSpeechRecognitionController. All non-trivial
// logic lives in the controller so it can be unit-tested without RTL.
export function useSpeechRecognition(input: UseSpeechRecognitionInput): UseSpeechRecognition {
  const { onTranscript } = input;
  const supported = useMemo(() => isSpeechRecognitionSupported(), []);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<SpeechRecognitionController | null>(null);
  const onTranscriptRef = useRef(onTranscript);

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    if (!supported) return;
    const controller = createSpeechRecognitionController({
      Ctor: resolveCtor(),
      onTranscript: (text) => onTranscriptRef.current(text),
      onError: (message) => setError(message),
      onStateChange: setListening,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [supported]);

  const start = useCallback(() => {
    setError(null);
    controllerRef.current?.start();
  }, []);
  const stop = useCallback(() => controllerRef.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
