// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceTarget } from "../lib/voice-targets.js";
import { VoiceCaptureButton } from "./voice-capture-button.js";

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

describe("VoiceCaptureButton", () => {
  it("renders nothing when speech support is unavailable", async () => {
    await renderButton({ supported: false });

    expect(document.querySelector("button")).toBeNull();
  });

  it("starts dictation with the explicit target", async () => {
    const target: VoiceTarget = {
      kind: "registered",
      insertText: vi.fn(),
      canAcceptVoiceCommit: () => true,
    };
    const startDictation = vi.fn();
    await renderButton({ supported: true, target, startDictation });

    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(startDictation).toHaveBeenCalledWith({ target });
    expect(document.querySelector("button")?.getAttribute("aria-label")).toBe("Start voice dictation");
  });
});

async function renderButton(options: {
  supported: boolean;
  target?: VoiceTarget;
  startDictation?: (options: { target: VoiceTarget | null }) => boolean;
}) {
  const rootElement = document.createElement("div");
  document.body.replaceChildren(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  await flushReact(() => {
    root.render(
      createElement(VoiceCaptureButton, {
        speechSupported: options.supported,
        target: options.target ?? null,
        startDictation: options.startDictation ?? vi.fn(),
      }),
    );
  });
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
