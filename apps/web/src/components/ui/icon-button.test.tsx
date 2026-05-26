// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "./icon-button.js";
import { render } from "./test-utils.js";

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

function mount(node: React.ReactNode) {
  const result = render(node);
  cleanup = result.unmount;
  return result;
}

describe("IconButton", () => {
  it("renders a <button> with the supplied aria-label", () => {
    const { container } = mount(
      <IconButton aria-label="Close panel">
        <span>×</span>
      </IconButton>,
    );
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.getAttribute("aria-label")).toBe("Close panel");
  });

  it("warns in dev when aria-label is empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Deliberately passing an empty aria-label to exercise the dev warning.
    const emptyLabel = "" as unknown as string;
    mount(
      <IconButton aria-label={emptyLabel}>
        <span>×</span>
      </IconButton>,
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("uses size=icon under the hood (h-9 w-9 wrapper)", () => {
    const { container } = mount(
      <IconButton aria-label="Open">
        <span>+</span>
      </IconButton>,
    );
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/w-9/);
  });
});
