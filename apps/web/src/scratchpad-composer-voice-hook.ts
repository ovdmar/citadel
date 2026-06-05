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
  const unregisterRef = useRef<(() => void) | null>(null);
  const target = useMemo(
    () =>
      createScratchpadComposerVoiceTarget({
        getElement: () => options.composerRef.current,
        isLoaded: () => options.loaded,
        isVisible: () => options.open,
        onDraftChange: options.onDraftChange,
        submitDraft: options.submitDraft,
      }),
    [options.composerRef, options.loaded, options.open, options.onDraftChange, options.submitDraft],
  );

  const inputRef = useCallback<RefCallback<HTMLTextAreaElement>>(
    (element) => {
      unregisterRef.current?.();
      unregisterRef.current = null;
      options.composerRef.current = element;
      if (element) unregisterRef.current = options.registerTarget(element, target);
    },
    [options.composerRef, options.registerTarget, target],
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
