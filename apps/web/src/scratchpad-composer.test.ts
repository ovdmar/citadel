// @vitest-environment happy-dom
import { createElement, createRef, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScratchpadComposer } from "./scratchpad-composer.js";

const roots: Root[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  vi.restoreAllMocks();
});

describe("ScratchpadComposer", () => {
  it("submits the current draft on Cmd/Ctrl+Enter", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ value: "ship it", onSubmit });

    screenComposer().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("submits non-empty drafts on blur but ignores whitespace-only drafts", async () => {
    const onSubmit = vi.fn();
    await renderComposer({ value: "new thought", onSubmit });

    screenComposer().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith("new thought");

    onSubmit.mockClear();
    await renderComposer({ value: "   ", onSubmit });
    screenComposer().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("autosizes on input without exceeding 200px", async () => {
    await renderComposer({ value: "line" });
    const input = screenComposer();
    Object.defineProperty(input, "scrollHeight", { configurable: true, value: 260 });

    input.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(input.style.height).toBe("200px");
  });

  it("forwards the textarea ref and renders error/disabled state", async () => {
    const ref = createRef<HTMLTextAreaElement>();
    await renderComposer({ value: "", error: "save_failed", loaded: false, inputRef: ref });

    expect(ref.current).toBe(screenComposer());
    expect(screenComposer().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("save_failed");
  });
});

async function renderComposer(props: Partial<ComponentProps<typeof ScratchpadComposer>> = {}): Promise<void> {
  const rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(
      createElement(ScratchpadComposer, {
        value: "",
        loaded: true,
        error: null,
        inputRef: { current: null },
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        ...props,
      }),
    );
  });
}

function screenComposer(): HTMLTextAreaElement {
  const input = document.querySelector<HTMLTextAreaElement>(".scratchpad-composer-input");
  if (!input) throw new Error("composer input missing");
  return input;
}

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
