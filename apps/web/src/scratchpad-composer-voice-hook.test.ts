// @vitest-environment happy-dom
import { createElement, useRef } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTarget } from "./lib/voice-targets.js";
import { useScratchpadComposerVoiceTarget } from "./scratchpad-composer-voice-hook.js";

const roots: Root[] = [];

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  await flushReact(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

describe("useScratchpadComposerVoiceTarget", () => {
  it("keeps the registered composer target active across ordinary rerenders", async () => {
    const captured: { target: VoiceTarget | null } = { target: null };
    const unregister = vi.fn();
    const registerTarget = vi.fn<(_element: HTMLElement, _target: VoiceTarget) => () => void>((_element, target) => {
      captured.target = target;
      return unregister;
    });
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);

    await flushReact(() =>
      root.render(createElement(Harness, { show: true, loaded: true, open: true, registerTarget })),
    );
    const firstTarget = captured.target;
    await flushReact(() =>
      root.render(createElement(Harness, { show: true, loaded: true, open: true, registerTarget })),
    );
    const currentTarget = captured.target;
    if (!currentTarget) throw new Error("target was not registered");

    expect(registerTarget).toHaveBeenCalledOnce();
    expect(unregister).not.toHaveBeenCalled();
    expect(currentTarget).toBe(firstTarget);
    expect(currentTarget.canAcceptVoiceCommit()).toBe(true);
  });

  it("re-registers the composer target when the textarea remounts with stable dependencies", async () => {
    const unregisterFirst = vi.fn();
    const unregisterSecond = vi.fn();
    const registerTarget = vi
      .fn<(_element: HTMLElement, _target: VoiceTarget) => () => void>()
      .mockReturnValueOnce(unregisterFirst)
      .mockReturnValueOnce(unregisterSecond);
    const rootElement = document.createElement("div");
    document.body.appendChild(rootElement);
    const root = createRoot(rootElement);
    roots.push(root);

    await flushReact(() =>
      root.render(createElement(Harness, { show: true, loaded: true, open: true, registerTarget })),
    );
    const firstTextarea = screenTextarea();

    await flushReact(() =>
      root.render(createElement(Harness, { show: false, loaded: true, open: true, registerTarget })),
    );
    await flushReact(() =>
      root.render(createElement(Harness, { show: true, loaded: true, open: true, registerTarget })),
    );
    const secondTextarea = screenTextarea();

    expect(firstTextarea).not.toBe(secondTextarea);
    expect(registerTarget).toHaveBeenCalledTimes(2);
    expect(registerTarget.mock.calls[0]?.[0]).toBe(firstTextarea);
    expect(registerTarget.mock.calls[1]?.[0]).toBe(secondTextarea);
    expect(unregisterFirst).toHaveBeenCalledOnce();
    expect(unregisterSecond).not.toHaveBeenCalled();
  });
});

function Harness(props: {
  show: boolean;
  loaded: boolean;
  open: boolean;
  registerTarget: (element: HTMLElement, target: VoiceTarget) => () => void;
}) {
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const { inputRef } = useScratchpadComposerVoiceTarget({
    composerRef,
    loaded: props.loaded,
    open: props.open,
    onDraftChange: vi.fn(),
    registerTarget: props.registerTarget,
    submitDraft: vi.fn(),
  });
  return props.show ? createElement("textarea", { ref: inputRef }) : null;
}

function screenTextarea(): HTMLTextAreaElement {
  const textarea = document.querySelector("textarea");
  if (!textarea) throw new Error("textarea missing");
  return textarea;
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
