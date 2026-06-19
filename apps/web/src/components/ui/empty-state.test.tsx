// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "./empty-state.js";
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

describe("EmptyState", () => {
  it("renders heading + description + optional icon + CTA", () => {
    const onClick = vi.fn();
    const { container } = mount(
      <EmptyState
        icon={<span data-testid="icon">i</span>}
        heading="No workspaces"
        description="Create a workspace to get started."
        action={{ label: "Add workspace", onClick }}
      />,
    );
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull();
    expect(container.textContent).toContain("No workspaces");
    expect(container.textContent).toContain("Create a workspace to get started.");
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Add workspace");
    fireClick(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders without a CTA when action is omitted", () => {
    const { container } = mount(<EmptyState heading="Empty" />);
    expect(container.querySelector("button")).toBeNull();
  });

  it('exposes data-component="empty-state" for scoped styling', () => {
    const { container } = mount(<EmptyState heading="x" />);
    expect(container.querySelector('[data-component="empty-state"]')).not.toBeNull();
  });
});
