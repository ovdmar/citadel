import { type RefCallback, useCallback, useEffect, useMemo, useRef } from "react";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { createScratchpadComposerVoiceTarget } from "./scratchpad-composer-voice-target.js";

type ScratchpadComposerVoiceHookOptions = {
  composerRef: { current: HTMLTextAreaElement | null };
  loaded: boolean;
  open: boolean;
  onDraftChange: (draft: string) => void;
  registerTarget: (element: HTMLElement, target: VoiceTarget) => () => void;
  submitDraft: (draft: string) => void | Promise<void>;
};

type ScratchpadComposerVoiceRegistration = {
  target: VoiceTarget;
  inputRef: RefCallback<HTMLTextAreaElement>;
};

export function useScratchpadComposerVoiceTarget(
  options: ScratchpadComposerVoiceHookOptions,
): ScratchpadComposerVoiceRegistration {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const unregisterRef = useRef<(() => void) | null>(null);
  const target = useMemo(
    () =>
      createScratchpadComposerVoiceTarget({
        getElement: () => optionsRef.current.composerRef.current,
        isLoaded: () => optionsRef.current.loaded,
        isVisible: () => optionsRef.current.open,
        onDraftChange: (draft) => optionsRef.current.onDraftChange(draft),
        submitDraft: (draft) => optionsRef.current.submitDraft(draft),
      }),
    [],
  );

  const inputRef = useCallback<RefCallback<HTMLTextAreaElement>>(
    (element) => {
      unregisterRef.current?.();
      unregisterRef.current = null;
      optionsRef.current.composerRef.current = element;
      if (element) unregisterRef.current = optionsRef.current.registerTarget(element, target);
    },
    [target],
  );

  useEffect(
    () => () => {
      unregisterRef.current?.();
      unregisterRef.current = null;
    },
    [],
  );

  return { target, inputRef };
}
