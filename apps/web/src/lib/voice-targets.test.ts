// @vitest-environment happy-dom
import { type ChangeEvent, createElement, useState } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTargetRegistry, createGenericEditableVoiceTarget } from "./voice-targets.js";

const roots: Root[] = [];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("generic editable voice targets", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    flushSync(() => {
      for (const root of roots.splice(0)) root.unmount();
    });
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

  it("replaces selected text without losing React-controlled input state on rerender", async () => {
    let latestState = "";
    function ControlledInput() {
      const [value, setValue] = useState("before after");
      latestState = value;
      return createElement("input", {
        value,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.currentTarget.value),
      });
    }
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);
    await flushReact(() => root.render(createElement(ControlledInput)));
    const input = document.querySelector("input");
    if (!(input instanceof HTMLInputElement)) throw new Error("input missing");
    input.setSelectionRange(7, 12);

    const target = createGenericEditableVoiceTarget(input);
    await flushReact(() => target?.insertText("now"));
    await flushReact(() => root.render(createElement(ControlledInput)));

    expect(input.value).toBe("before now");
    expect(input.selectionStart).toBe(10);
    expect(latestState).toBe("before now");
  });

  it.each(["text", "search", "email", "tel", "url"])("accepts %s input controls", (type) => {
    const input = document.createElement("input");
    input.type = type;
    input.value = "before";
    document.body.appendChild(input);

    const target = createGenericEditableVoiceTarget(input);
    target?.insertText(" after");

    expect(input.value).toBe("before after");
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
    const password = document.createElement("input");
    password.type = "password";
    const wrapper = document.createElement("div");
    wrapper.hidden = true;
    const hiddenText = document.createElement("input");
    wrapper.appendChild(hiddenText);
    document.body.append(checkbox, number, password, wrapper);

    expect(createGenericEditableVoiceTarget(checkbox)).toBeNull();
    expect(createGenericEditableVoiceTarget(number)).toBeNull();
    expect(createGenericEditableVoiceTarget(password)).toBeNull();
    expect(createGenericEditableVoiceTarget(hiddenText)).toBeNull();
  });

  it("rejects controls inside display-none ancestors", () => {
    const wrapper = document.createElement("div");
    wrapper.style.display = "none";
    const input = document.createElement("input");
    wrapper.appendChild(input);
    document.body.appendChild(wrapper);

    expect(createGenericEditableVoiceTarget(input)).toBeNull();
  });

  it("reports generic targets as insertion-only even when auto-submit is enabled", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    const target = createGenericEditableVoiceTarget(input);
    if (!target?.commit) throw new Error("expected generic target with commit");
    const result = target.commit("hello", { autoSubmit: true });

    expect(result).toEqual({ status: "inserted-not-submitted", text: "hello" });
  });

  it("does not submit a wrapping form when auto-submit is enabled", () => {
    const form = document.createElement("form");
    const input = document.createElement("input");
    const requestSubmit = vi.fn();
    const submit = vi.fn();
    const submitEvent = vi.fn((event: SubmitEvent) => event.preventDefault());
    Object.defineProperty(form, "requestSubmit", { configurable: true, value: requestSubmit });
    Object.defineProperty(form, "submit", { configurable: true, value: submit });
    form.addEventListener("submit", submitEvent);
    form.appendChild(input);
    document.body.appendChild(form);

    const target = createGenericEditableVoiceTarget(input);
    if (!target?.commit) throw new Error("expected generic target with commit");
    const result = target.commit("hello", { autoSubmit: true });

    expect(result).toEqual({ status: "inserted-not-submitted", text: "hello" });
    expect(input.value).toBe("hello");
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(submitEvent).not.toHaveBeenCalled();
  });
});

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

const flushReact = async (callback: () => void | Promise<void>) => {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
};

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

    const resolved = registry.resolve(input);
    resolved?.insertText("hello");

    expect(resolved?.kind).toBe("registered");
    expect(registered.insertText).toHaveBeenCalledWith("hello");
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

  it("invalidates already resolved registered targets when they unregister", () => {
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const registry = new VoiceTargetRegistry();
    const registered = {
      kind: "registered" as const,
      insertText: vi.fn(),
      canAcceptVoiceCommit: () => true,
    };
    const unregister = registry.register(input, registered);
    const resolved = registry.resolve(input);

    expect(resolved?.canAcceptVoiceCommit()).toBe(true);
    unregister();

    expect(resolved?.canAcceptVoiceCommit()).toBe(false);
  });
});
