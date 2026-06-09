// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "./card.js";
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

describe("Card", () => {
  it('renders children inside a div with data-component="card"', () => {
    const { container } = mount(<Card>hello</Card>);
    const card = container.querySelector('[data-component="card"]');
    expect(card).not.toBeNull();
    expect(card?.tagName).toBe("DIV");
    expect(card?.textContent).toBe("hello");
  });

  it("merges custom className with the base classes", () => {
    const { container } = mount(<Card className="extra">x</Card>);
    const card = container.querySelector('[data-component="card"]');
    expect(card?.className).toMatch(/extra/);
  });

  it("forwards arbitrary HTML attributes", () => {
    const { container } = mount(
      <Card data-testid="my-card" aria-label="workspace summary">
        x
      </Card>,
    );
    const card = container.querySelector('[data-component="card"]');
    expect(card?.getAttribute("data-testid")).toBe("my-card");
    expect(card?.getAttribute("aria-label")).toBe("workspace summary");
  });
});
