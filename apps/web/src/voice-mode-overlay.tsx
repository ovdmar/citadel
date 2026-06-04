type VoiceModeOverlayProps = {
  active: boolean;
  status: string;
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
  const copy = () => {
    if (!props.buffer) return;
    void navigator.clipboard?.writeText(props.buffer).catch(() => undefined);
  };
  return (
    <div className="voice-mode-overlay" role="status" aria-live="polite">
      <div className="voice-mode-status">{props.status}</div>
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
        {props.status === "retry" ? (
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}
