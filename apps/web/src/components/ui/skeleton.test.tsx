// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton.js";
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

describe("Skeleton", () => {
  it("renders as <output> (implicit role=status) with aria-busy=true", () => {
    const { container } = mount(<Skeleton />);
    const node = container.querySelector('[data-component="skeleton"]');
    expect(node).not.toBeNull();
    // <output> carries an implicit role of "status" — we don't need to set
    // role explicitly. Verify the semantic element and the busy attribute.
    expect(node?.tagName).toBe("OUTPUT");
    expect(node?.getAttribute("aria-busy")).toBe("true");
  });

  it("applies width and height props as inline styles", () => {
    const { container } = mount(<Skeleton width={120} height={16} />);
    const node = container.querySelector('[data-component="skeleton"]') as HTMLElement | null;
    expect(node?.style.width).toBe("120px");
    expect(node?.style.height).toBe("16px");
  });

  it("supports string width/height for non-pixel units", () => {
    const { container } = mount(<Skeleton width="100%" height="2rem" />);
    const node = container.querySelector('[data-component="skeleton"]') as HTMLElement | null;
    expect(node?.style.width).toBe("100%");
    expect(node?.style.height).toBe("2rem");
  });

  it("merges className", () => {
    const { container } = mount(<Skeleton className="my-skeleton" />);
    const node = container.querySelector('[data-component="skeleton"]');
    expect(node?.className).toMatch(/my-skeleton/);
  });

  it("renders a screen-reader label when label is provided", () => {
    const { container } = mount(<Skeleton label="Loading PR data" />);
    expect(container.textContent).toContain("Loading PR data");
    const node = container.querySelector('[data-component="skeleton"]');
    expect(node?.getAttribute("aria-label")).toBe("Loading PR data");
  });
});
