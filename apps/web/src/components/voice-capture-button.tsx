import { Mic, MicOff } from "lucide-react";
import type { CSSProperties } from "react";
import { useSpeechRecognition } from "../lib/use-speech-recognition.js";

export type VoiceCaptureButtonProps = {
  onTranscript: (text: string) => void;
  onError?: (message: string) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
};

// Renders a mic toggle that dictates into the host composer via the Web Speech
// API. When the API is unavailable (older Safari, locked-down browsers) the
// component returns null so the host UI gracefully degrades — no broken icon,
// no permission prompt, no console noise.
export function VoiceCaptureButton(props: VoiceCaptureButtonProps) {
  const { onTranscript, onError, className, style, label = "Voice capture" } = props;
  const speech = useSpeechRecognition({ onTranscript });

  if (!speech.supported) return null;
  if (speech.error) onError?.(speech.error);

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
