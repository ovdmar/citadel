import { type VoiceTarget, createGenericEditableVoiceTarget, isElementVoiceVisible } from "./lib/voice-targets.js";

type ScratchpadComposerVoiceTargetOptions = {
  getElement: () => HTMLTextAreaElement | null;
  isLoaded: () => boolean;
  isVisible?: () => boolean;
  onDraftChange: (draft: string) => void;
  submitDraft: (draft: string) => void | Promise<void>;
};

export function createScratchpadComposerVoiceTarget(options: ScratchpadComposerVoiceTargetOptions): VoiceTarget {
  return {
    kind: "registered",
    canAcceptVoiceCommit: () => canAcceptComposerCommit(options),
    insertText: (text) => {
      insertIntoComposer(options, text);
    },
    getDraft: () => options.getElement()?.value ?? "",
    commit: (text, commitOptions) => {
      const draft = insertIntoComposer(options, text);
      if (draft === null) {
        return {
          status: "buffered",
          text,
          reason: "The scratchpad composer is not available. Copy the dictated text.",
        };
      }
      if (commitOptions.autoSubmit && draft.trim().length > 0) {
        void options.submitDraft(draft);
        return { status: "submitted", text: draft };
      }
      return { status: "inserted-not-submitted", text: draft };
    },
  };
}

function canAcceptComposerCommit(options: ScratchpadComposerVoiceTargetOptions): boolean {
  const element = options.getElement();
  return Boolean(
    element?.isConnected &&
      options.isLoaded() &&
      options.isVisible?.() !== false &&
      !element.disabled &&
      !element.readOnly &&
      isElementVoiceVisible(element),
  );
}

function insertIntoComposer(options: ScratchpadComposerVoiceTargetOptions, text: string): string | null {
  const element = options.getElement();
  if (!element || !canAcceptComposerCommit(options)) return null;
  const target = createGenericEditableVoiceTarget(element);
  if (!target) return null;
  target.insertText(text);
  const draft = element.value;
  options.onDraftChange(draft);
  return draft;
}
