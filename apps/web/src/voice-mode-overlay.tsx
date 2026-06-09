import { AlertCircle, Copy, Mic, RotateCcw, Send, Square, X } from "lucide-react";

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
  onAutoSubmitChange: (next: boolean) => void;
  onSendNow: () => void;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
};

export function VoiceModeOverlay(props: VoiceModeOverlayProps) {
  if (!props.active) return null;
  const canRetry = props.status === "retry" || props.status === "permission-denied" || props.status === "error";
  const canSendNow = props.status === "listening" && props.draft.length > 0;
  const canStop = props.status === "listening";
  const transcript = props.buffer || props.draft;
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
          <div className="voice-mode-meta">{metaLabel(props.status)}</div>
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
      </div>

      <div className="voice-mode-actions">
        {canSendNow ? (
          <button type="button" className="voice-mode-action voice-mode-action--primary" onClick={props.onSendNow}>
            <Send size={13} />
            Send now
          </button>
        ) : null}
        {canStop ? (
          <button type="button" className="voice-mode-action" onClick={props.onStop}>
            <Square size={12} />
            Stop
          </button>
        ) : null}
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

function metaLabel(status: VoiceModeOverlayStatus): string {
  switch (status) {
    case "listening":
      return "Speak naturally";
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
