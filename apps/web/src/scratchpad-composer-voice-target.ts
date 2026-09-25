import {
  type VoiceCommitResult,
  type VoiceTarget,
  canAcceptTextEditableVoiceCommit,
  createGenericEditableVoiceTarget,
} from "./lib/voice-targets.js";

type ScratchpadComposerVoiceTargetOptions = {
  getElement: () => HTMLTextAreaElement | null;
  isLoaded: () => boolean;
  isVisible?: () => boolean;
  onDraftChange: (draft: string) => void;
  submitDraft: (draft: string) => boolean | Promise<boolean>;
};

export function createScratchpadComposerVoiceTarget(options: ScratchpadComposerVoiceTargetOptions): VoiceTarget {
  return {
    kind: "registered",
    canAcceptVoiceCommit: () => canAcceptComposerCommit(options),
    insertText: (text) => {
      insertIntoComposer(options, text);
    },
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
        return submitComposerDraft(options, draft);
      }
      return { status: "inserted-not-submitted", text: draft };
    },
  };
}

function canAcceptComposerCommit(options: ScratchpadComposerVoiceTargetOptions): boolean {
  const element = options.getElement();
  return Boolean(
    element && options.isLoaded() && options.isVisible?.() !== false && canAcceptTextEditableVoiceCommit(element),
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

async function submitComposerDraft(
  options: ScratchpadComposerVoiceTargetOptions,
  draft: string,
): Promise<VoiceCommitResult> {
  const submitted = await options.submitDraft(draft);
  if (!submitted) {
    return {
      status: "buffered",
      text: draft,
      cause: "commit-error",
      reason: "The scratchpad block could not be created. Copy the dictated text.",
    };
  }
  return { status: "submitted", text: draft };
}
