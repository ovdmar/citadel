// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button.js";
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

describe("Button", () => {
  it("renders a <button> with the provided children by default", () => {
    const { container } = mount(<Button>Click me</Button>);
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Click me");
  });

  it("renders the focus-visible ring class on the base layer", () => {
    const { container } = mount(<Button>Focus</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/focus-visible:ring-2/);
  });

  it('applies the destructive variant when variant="destructive"', () => {
    const { container } = mount(<Button variant="destructive">Delete</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/color-danger/);
  });

  it('applies the link variant when variant="link"', () => {
    const { container } = mount(<Button variant="link">Read more</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/underline/);
  });

  it("renders a spinner and disables the button while loading", () => {
    const { container } = mount(<Button loading>Save</Button>);
    const button = container.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.querySelector('[data-slot="spinner"]')).not.toBeNull();
    // Children remain in the DOM for layout stability.
    expect(button?.textContent).toContain("Save");
  });

  it("does not render a spinner when not loading", () => {
    const { container } = mount(<Button>Save</Button>);
    const button = container.querySelector("button");
    expect(button?.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(button?.hasAttribute("aria-busy")).toBe(false);
  });

  it("respects the explicit disabled prop independently of loading", () => {
    const { container } = mount(<Button disabled>Save</Button>);
    const button = container.querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  it('applies the sm size when size="sm"', () => {
    const { container } = mount(<Button size="sm">Small</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/min-h-7/);
  });

  it('applies the lg size when size="lg"', () => {
    const { container } = mount(<Button size="lg">Large</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/min-h-10/);
  });

  it('preserves the icon size when size="icon"', () => {
    const { container } = mount(<Button size="icon">x</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/w-9/);
  });

  it("renders the slot via asChild for polymorphic usage", () => {
    const { container } = mount(
      <Button asChild>
        <a href="https://example.com">Link</a>
      </Button>,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector("button")).toBeNull();
  });

  it("merges the className prop with the variant classes", () => {
    const { container } = mount(<Button className="my-extra">Extra</Button>);
    const button = container.querySelector("button");
    expect(button?.className).toMatch(/my-extra/);
  });
});
