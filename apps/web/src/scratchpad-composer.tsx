import type { ReactNode, Ref } from "react";

type ScratchpadComposerProps = {
  value: string;
  loaded: boolean;
  error: string | null;
  inputRef: Ref<HTMLTextAreaElement>;
  onChange: (value: string) => void;
  onSubmit: (text: string) => void | Promise<void>;
  actions?: ReactNode;
};

export function ScratchpadComposer(props: ScratchpadComposerProps) {
  const submit = (text: string) => {
    if (text.trim().length === 0) return;
    void props.onSubmit(text);
  };
  return (
    <div className="scratchpad-composer">
      {props.error ? (
        <p className="scratchpad-composer-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <div className="scratchpad-composer-row">
        <textarea
          ref={props.inputRef}
          className="scratchpad-composer-input"
          aria-label="New scratchpad block"
          placeholder="Add a note. Cmd/Ctrl-Enter creates a new block."
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onInput={(event) => {
            const el = event.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              submit(event.currentTarget.value);
            }
          }}
          onBlur={(event) => submit(event.currentTarget.value)}
          disabled={!props.loaded}
          rows={2}
        />
        {props.actions}
      </div>
    </div>
  );
}
