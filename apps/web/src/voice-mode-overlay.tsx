import { AlertCircle, Copy, Mic, RotateCcw, Send, SlidersHorizontal, Square, X } from "lucide-react";

export type VoiceModeOverlayStatus =
  | "idle"
  | "listening"
  | "unavailable"
  | "retry"
  | "permission-denied"
  | "error"
  | "no-target"
  | "submitted"
  | "inserted";

type VoiceModeOverlayProps = {
  active: boolean;
  status: VoiceModeOverlayStatus;
  draft: string;
  buffer: string;
  error: string | null;
  autoSubmit: boolean;
  silenceTimeoutMs: number;
  onAutoSubmitChange: (next: boolean) => void;
  onSilenceTimeoutChange: (nextMs: number) => void;
  onSendNow: () => void;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
};

export function VoiceModeOverlay(props: VoiceModeOverlayProps) {
  if (!props.active) return null;
  const canRetry = props.status === "retry" || props.status === "permission-denied" || props.status === "error";
  const canSendNow = props.status === "listening" && props.draft.length > 0;
  const transcript = props.buffer || props.draft;
  const silenceSeconds = Math.round(props.silenceTimeoutMs / 1000);
  const copy = () => {
    if (!transcript) return;
    void navigator.clipboard?.writeText(transcript).catch(() => undefined);
  };
  return (
    <output
      className={`voice-mode-overlay voice-mode-overlay--${props.status}`}
      data-voice-mode-overlay="true"
      aria-live="polite"
    >
      <div className="voice-mode-header">
        <span className="voice-mode-mark" aria-hidden="true">
          <Mic size={16} strokeWidth={2.2} />
        </span>
        <div className="voice-mode-title">
          <div className="voice-mode-status">{statusLabel(props.status)}</div>
          <div className="voice-mode-meta">{metaLabel(props.status, silenceSeconds)}</div>
        </div>
        <button
          type="button"
          className="voice-mode-icon-button"
          onClick={props.onCancel}
          aria-label="Cancel"
          title="Cancel"
        >
          <X size={16} />
        </button>
      </div>

      {transcript ? (
        <div className={props.buffer ? "voice-mode-buffer" : "voice-mode-interim"}>{transcript}</div>
      ) : (
        <div className="voice-mode-empty">Listening...</div>
      )}

      {props.error ? (
        <div className="voice-mode-error">
          <AlertCircle size={14} />
          <span>{props.error}</span>
        </div>
      ) : null}

      <div className="voice-mode-controls">
        <label className="voice-mode-toggle">
          <input
            type="checkbox"
            checked={props.autoSubmit}
            onChange={(event) => props.onAutoSubmitChange(event.currentTarget.checked)}
          />
          <span className="voice-mode-toggle-track" aria-hidden="true">
            <span className="voice-mode-toggle-thumb" />
          </span>
          <span>Auto-submit</span>
        </label>
        <label className="voice-mode-silence">
          <SlidersHorizontal size={13} aria-hidden="true" />
          <span>Silence</span>
          <input
            type="number"
            min={3}
            max={30}
            step={1}
            value={silenceSeconds}
            aria-label="Silence window"
            title="Silence window"
            onChange={(event) => props.onSilenceTimeoutChange(Number(event.currentTarget.value) * 1000)}
          />
          <span>s</span>
        </label>
      </div>

      <div className="voice-mode-actions">
        <button
          type="button"
          className="voice-mode-action voice-mode-action--primary"
          onClick={props.onSendNow}
          disabled={!canSendNow}
        >
          <Send size={13} />
          Send now
        </button>
        <button type="button" className="voice-mode-action" onClick={props.onStop}>
          <Square size={12} />
          Stop
        </button>
        <button type="button" className="voice-mode-action" onClick={props.onCancel}>
          <X size={13} />
          Cancel
        </button>
        {transcript ? (
          <button type="button" className="voice-mode-action" onClick={copy}>
            <Copy size={13} />
            Copy
          </button>
        ) : null}
        {canRetry ? (
          <button type="button" className="voice-mode-action" onClick={props.onRetry}>
            <RotateCcw size={13} />
            Retry
          </button>
        ) : null}
      </div>
    </output>
  );
}

function statusLabel(status: VoiceModeOverlayStatus): string {
  switch (status) {
    case "listening":
      return "Listening";
    case "unavailable":
      return "Voice unavailable";
    case "retry":
      return "Ready to retry";
    case "permission-denied":
      return "Microphone permission needed";
    case "error":
      return "Dictation needs attention";
    case "no-target":
      return "No input target";
    case "submitted":
      return "Submitted";
    case "inserted":
      return "Inserted";
    default:
      return "Ready";
  }
}

function metaLabel(status: VoiceModeOverlayStatus, silenceSeconds: number): string {
  switch (status) {
    case "listening":
      return `${silenceSeconds}s silence window`;
    case "submitted":
      return "Sent to target";
    case "inserted":
      return "Inserted in target";
    case "no-target":
      return "Transcript buffered";
    case "unavailable":
      return "Browser support required";
    case "retry":
      return "Retry available";
    case "permission-denied":
      return "Check microphone access";
    case "error":
      return "Review captured text";
    default:
      return "Ready";
  }
}
