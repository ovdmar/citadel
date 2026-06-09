// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Chip } from "./chip.js";
import { fireClick, render } from "./test-utils.js";

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

describe("Chip", () => {
  it("renders the label inside a Badge container", () => {
    const { container } = mount(<Chip>My label</Chip>);
    const chip = container.querySelector("[data-variant]");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("My label");
  });

  it("renders a leading icon slot when icon is provided", () => {
    const { container } = mount(<Chip icon={<span data-testid="icon">@</span>}>label</Chip>);
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it("renders an onClose button with a required aria-label and fires the handler", () => {
    const onClose = vi.fn();
    const { container } = mount(
      <Chip onClose={onClose} closeAriaLabel="Remove tag">
        label
      </Chip>,
    );
    const closeBtn = container.querySelector('[data-slot="chip-close"]') as HTMLButtonElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.getAttribute("aria-label")).toBe("Remove tag");
    fireClick(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render the close button when onClose is omitted", () => {
    const { container } = mount(<Chip>label</Chip>);
    expect(container.querySelector('[data-slot="chip-close"]')).toBeNull();
  });
});
