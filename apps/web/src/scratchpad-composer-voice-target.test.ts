// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScratchpadComposerVoiceTarget } from "./scratchpad-composer-voice-target.js";

describe("createScratchpadComposerVoiceTarget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts dictated text into the composer and reports the updated draft", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "before after";
    textarea.setSelectionRange(7, 12);
    document.body.appendChild(textarea);
    const onDraftChange = vi.fn();
    const target = createScratchpadComposerVoiceTarget({
      getElement: () => textarea,
      isLoaded: () => true,
      onDraftChange,
      submitDraft: vi.fn(),
    });

    const result = target.commit?.("now", { autoSubmit: false });

    expect(result).toEqual({ status: "inserted-not-submitted", text: "before now" });
    expect(textarea.value).toBe("before now");
    expect(textarea.selectionStart).toBe(10);
    expect(onDraftChange).toHaveBeenCalledWith("before now");
  });

  it("auto-submits the whole post-insertion draft", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "existing ";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    document.body.appendChild(textarea);
    const submitDraft = vi.fn();
    const target = createScratchpadComposerVoiceTarget({
      getElement: () => textarea,
      isLoaded: () => true,
      onDraftChange: vi.fn(),
      submitDraft,
    });

    const result = target.commit?.("idea", { autoSubmit: true });

    expect(result).toEqual({ status: "submitted", text: "existing idea" });
    expect(submitDraft).toHaveBeenCalledWith("existing idea");
  });

  it("buffers text when the composer is not ready", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    const target = createScratchpadComposerVoiceTarget({
      getElement: () => textarea,
      isLoaded: () => false,
      onDraftChange: vi.fn(),
      submitDraft: vi.fn(),
    });

    expect(target.canAcceptVoiceCommit()).toBe(false);
    expect(target.commit?.("loose", { autoSubmit: true })).toEqual({
      status: "buffered",
      text: "loose",
      reason: "The scratchpad composer is not available. Copy the dictated text.",
    });
  });
});
