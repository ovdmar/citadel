import { Mic, MicOff } from "lucide-react";
import { type CSSProperties, useEffect, useImperativeHandle } from "react";
import type { Ref } from "react";
import { useSpeechRecognition } from "../lib/use-speech-recognition.js";

export type VoiceCaptureButtonHandle = {
  // Imperative stop — parents call this when the host textarea loses focus so
  // recognition matches the spec's "blurring stops it" clause.
  stop: () => void;
};

export type VoiceCaptureButtonProps = {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
  controlRef?: Ref<VoiceCaptureButtonHandle>;
};

// Renders a mic toggle that dictates into the host composer via the Web Speech
// API. When the API is unavailable (older Safari, locked-down browsers) the
// component returns null so the host UI gracefully degrades — no broken icon,
// no permission prompt, no console noise.
export function VoiceCaptureButton(props: VoiceCaptureButtonProps) {
  const { onTranscript, onError, className, style, label = "Voice capture", controlRef } = props;
  const speech = useSpeechRecognition({ onTranscript });

  // Errors are surfaced via an effect (not render) so an `onError` that updates
  // parent state never triggers a render loop.
  // biome-ignore lint/correctness/useExhaustiveDependencies: onError is allowed to be unstable; we intentionally key on the error string only.
  useEffect(() => {
    if (speech.error && onError) onError(speech.error);
  }, [speech.error]);

  useImperativeHandle(controlRef, () => ({ stop: () => speech.stop() }), [speech.stop]);

  if (!speech.supported) return null;

  const ariaLabel = speech.listening ? `${label}: stop listening` : `${label}: start listening`;
  return (
    <button
      type="button"
      className={`scratchpad-mic ${speech.listening ? "is-listening" : ""} ${className ?? ""}`.trim()}
      style={style}
      aria-label={ariaLabel}
      aria-pressed={speech.listening}
      title={ariaLabel}
      onClick={() => (speech.listening ? speech.stop() : speech.start())}
    >
      {speech.listening ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />}
    </button>
  );
}
