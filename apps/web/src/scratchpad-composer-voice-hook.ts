import { type RefObject, useEffect, useMemo } from "react";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { createScratchpadComposerVoiceTarget } from "./scratchpad-composer-voice-target.js";

type ScratchpadComposerVoiceHookOptions = {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  loaded: boolean;
  open: boolean;
  onDraftChange: (draft: string) => void;
  registerTarget: (element: HTMLElement, target: VoiceTarget) => () => void;
  submitDraft: (draft: string) => void | Promise<void>;
};

export function useScratchpadComposerVoiceTarget(options: ScratchpadComposerVoiceHookOptions): VoiceTarget {
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

  useEffect(() => {
    const element = options.composerRef.current;
    if (!element) return;
    return options.registerTarget(element, target);
  }, [options.composerRef, options.registerTarget, target]);

  return target;
}
