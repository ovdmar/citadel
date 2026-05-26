// Lightweight render helper for primitive tests. Built on React's own
// `act` + `createRoot` so the design system test suite stays
// dependency-free (no @testing-library/react). Each helper is small
// enough to read in a single screen.

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";

// React 18+ requires consumers to opt-in to act() outside production. Vitest
// + happy-dom doesn't set this for us, so set it once at module load.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderResult {
  container: HTMLDivElement;
  root: Root;
  unmount(): void;
  rerender(node: React.ReactNode): void;
}

export function render(node: React.ReactNode): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    root,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
    rerender(next) {
      act(() => root.render(next));
    },
  };
}

export function fireClick(el: Element | null | undefined): void {
  if (!el) throw new Error("fireClick: element is null");
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

export function pressKey(el: Element | null | undefined, key: string): void {
  if (!el) throw new Error("pressKey: element is null");
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}
