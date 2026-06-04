export type VoiceModeOverlayStatus =
  | "idle"
  | "listening"
  | "retry"
  | "permission-denied"
  | "error"
  | "no-target"
  | "submitted"
  | "inserted";

type VoiceModeOverlayProps = {
  active: boolean;
  status: VoiceModeOverlayStatus;
  interim: string;
  buffer: string;
  error: string | null;
  autoSubmit: boolean;
  onAutoSubmitChange: (next: boolean) => void;
  onStop: () => void;
  onCancel: () => void;
  onRetry: () => void;
};

export function VoiceModeOverlay(props: VoiceModeOverlayProps) {
  if (!props.active) return null;
  const canRetry = props.status === "retry" || props.status === "permission-denied" || props.status === "error";
  const copy = () => {
    if (!props.buffer) return;
    void navigator.clipboard?.writeText(props.buffer).catch(() => undefined);
  };
  return (
    <output className="voice-mode-overlay" aria-live="polite">
      <div className="voice-mode-status">{statusLabel(props.status)}</div>
      {props.interim ? <div className="voice-mode-interim">{props.interim}</div> : null}
      {props.buffer ? <div className="voice-mode-buffer">{props.buffer}</div> : null}
      {props.error ? <div className="voice-mode-error">{props.error}</div> : null}
      <label className="voice-mode-toggle">
        <input
          type="checkbox"
          checked={props.autoSubmit}
          onChange={(event) => props.onAutoSubmitChange(event.currentTarget.checked)}
        />
        Auto-submit
      </label>
      <div className="voice-mode-actions">
        <button type="button" onClick={props.onStop}>
          Stop
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        {props.buffer ? (
          <button type="button" onClick={copy}>
            Copy
          </button>
        ) : null}
        {canRetry ? (
          <button type="button" onClick={props.onRetry}>
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
