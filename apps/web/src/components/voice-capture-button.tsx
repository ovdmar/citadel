import { Mic } from "lucide-react";
import type { VoiceTarget } from "../lib/voice-targets.js";

type VoiceCaptureButtonProps = {
  speechSupported: boolean;
  target: VoiceTarget | null;
  startDictation: (options: { target: VoiceTarget | null }) => boolean;
  disabled?: boolean;
};

export function VoiceCaptureButton(props: VoiceCaptureButtonProps) {
  if (!props.speechSupported) return null;
  return (
    <button
      type="button"
      className="voice-capture-button"
      aria-label="Start voice dictation"
      title="Start voice dictation"
      disabled={props.disabled}
      onClick={() => props.startDictation({ target: props.target })}
    >
      <Mic size={16} />
    </button>
  );
}
