// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireClick, render } from "./test-utils.js";
import { Toaster, getToastQueueLength, resetToastQueue, toast } from "./toast.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
});

beforeEach(() => {
  resetToastQueue();
});

function mount(node: React.ReactNode) {
  const result = render(node);
  cleanup = result.unmount;
  return result;
}

describe("Toast", () => {
  it("renders enqueued toasts inside <Toaster />", () => {
    mount(<Toaster />);
    flushSync(() => {
      toast({ title: "Saved", description: "Your changes are live." });
    });
    const region = document.querySelector('[data-component="toaster"]');
    expect(region?.textContent).toContain("Saved");
    expect(region?.textContent).toContain("Your changes are live.");
  });

  it("auto-dismisses after the configured duration", () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mount(<Toaster />);
    flushSync(() => {
      toast({ title: "Will go away" });
    });
    expect(getToastQueueLength()).toBe(1);
    flushSync(() => {
      vi.advanceTimersByTime(5_001);
    });
    expect(getToastQueueLength()).toBe(0);
  });

  it("renders danger variant with role=alert and non-critical variants with explicit role=status", () => {
    mount(<Toaster />);
    flushSync(() => {
      toast({ title: "Boom", variant: "danger" });
    });
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Boom");
    flushSync(() => {
      toast({ title: "Polite", variant: "success" });
    });
    // Find the status node (must be explicit, not implicit on <output>) so
    // assistive tech that doesn't translate <output> → status still
    // announces the toast.
    const statusNodes = Array.from(document.querySelectorAll('[role="status"]'));
    expect(statusNodes.some((n) => n.textContent?.includes("Polite"))).toBe(true);
  });

  it("dismisses via the close button", () => {
    mount(<Toaster />);
    flushSync(() => {
      toast({ title: "Bye" });
    });
    expect(getToastQueueLength()).toBe(1);
    const close = document.querySelector('[data-slot="toast-close"]');
    fireClick(close);
    expect(getToastQueueLength()).toBe(0);
  });

  it("caps the queue at the configured maximum", () => {
    mount(<Toaster maxQueue={3} />);
    flushSync(() => {
      for (let i = 0; i < 5; i++) toast({ title: `t${i}` });
    });
    expect(getToastQueueLength()).toBe(3);
  });
});
