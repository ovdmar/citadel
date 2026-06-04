// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTargetRegistry, createGenericEditableVoiceTarget } from "./voice-targets.js";

describe("generic editable voice targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("inserts text into a textarea at the caret and dispatches input", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "hello world";
    textarea.setSelectionRange(6, 6);
    const inputEvents: InputEvent[] = [];
    textarea.addEventListener("input", (event) => inputEvents.push(event as InputEvent));
    document.body.appendChild(textarea);

    const target = createGenericEditableVoiceTarget(textarea);
    target?.insertText("voice ");

    expect(textarea.value).toBe("hello voice world");
    expect(textarea.selectionStart).toBe(12);
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0]?.inputType).toBe("insertText");
  });

  it("replaces selected input text and uses the native setter path for controlled inputs", () => {
    const input = document.createElement("input");
    input.value = "before after";
    input.setSelectionRange(7, 12);
    const setterCalls: string[] = [];
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    Object.defineProperty(input, "value", {
      configurable: true,
      get: () => prototypeDescriptor?.get?.call(input) ?? "",
      set: (value: string) => {
        setterCalls.push(value);
        prototypeDescriptor?.set?.call(input, value);
      },
    });
    document.body.appendChild(input);

    const target = createGenericEditableVoiceTarget(input);
    target?.insertText("now");

    expect(input.value).toBe("before now");
    expect(input.selectionStart).toBe(10);
    expect(setterCalls).toContain("before now");
  });

  it("does not create generic targets for contenteditable or disabled controls", () => {
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    const disabled = document.createElement("textarea");
    disabled.disabled = true;

    expect(createGenericEditableVoiceTarget(editable)).toBeNull();
    expect(createGenericEditableVoiceTarget(disabled)).toBeNull();
  });

  it("rejects non-text input types and hidden controls", () => {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const number = document.createElement("input");
    number.type = "number";
    const wrapper = document.createElement("div");
    wrapper.hidden = true;
    const hiddenText = document.createElement("input");
    wrapper.appendChild(hiddenText);
    document.body.append(checkbox, number, wrapper);

    expect(createGenericEditableVoiceTarget(checkbox)).toBeNull();
    expect(createGenericEditableVoiceTarget(number)).toBeNull();
    expect(createGenericEditableVoiceTarget(hiddenText)).toBeNull();
  });

  it("reports generic targets as insertion-only even when auto-submit is enabled", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    const target = createGenericEditableVoiceTarget(input);
    if (!target?.commit) throw new Error("expected generic target with commit");
    const result = target.commit("hello", { autoSubmit: true });

    expect(result).toEqual({ status: "inserted-not-submitted", text: "hello" });
  });
});

describe("VoiceTargetRegistry", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("resolves registered targets before generic editable targets", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const registry = new VoiceTargetRegistry();
    const registered = {
      kind: "registered" as const,
      insertText: vi.fn(),
      canAcceptVoiceCommit: () => true,
    };
    registry.register(input, registered);

    expect(registry.resolve(input)).toBe(registered);
  });

  it("ignores disconnected registered targets", () => {
    const input = document.createElement("textarea");
    const registry = new VoiceTargetRegistry();
    const registered = {
      kind: "registered" as const,
      insertText: vi.fn(),
      canAcceptVoiceCommit: () => true,
    };
    const unregister = registry.register(input, registered);

    expect(registry.resolve(input)).toBeNull();
    unregister();
    document.body.appendChild(input);
    expect(registry.resolve(input)?.kind).toBe("generic");
  });
});
