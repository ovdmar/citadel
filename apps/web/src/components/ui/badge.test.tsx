// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Badge } from "./badge.js";
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

describe("Badge", () => {
  it("renders a <span> by default", () => {
    const { container } = mount(<Badge>Idle</Badge>);
    const badge = container.querySelector("span");
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("Idle");
  });

  it("applies the neutral variant by default", () => {
    const { container } = mount(<Badge>Default</Badge>);
    const badge = container.querySelector("span");
    expect(badge?.getAttribute("data-variant")).toBe("neutral");
  });

  it("applies a known variant via data-variant for stable test targeting", () => {
    for (const variant of ["neutral", "ready", "blocked", "info", "warn", "merged", "neutral-strong"] as const) {
      const { container, unmount } = render(<Badge variant={variant}>{variant}</Badge>);
      const badge = container.querySelector("span");
      expect(badge?.getAttribute("data-variant")).toBe(variant);
      unmount();
    }
  });

  it("renders a leading dot when dot is true", () => {
    const { container } = mount(
      <Badge variant="ready" dot>
        Live
      </Badge>,
    );
    expect(container.querySelector('[data-slot="badge-dot"]')).not.toBeNull();
  });

  it("does not render a dot when dot is omitted", () => {
    const { container } = mount(<Badge variant="ready">Live</Badge>);
    expect(container.querySelector('[data-slot="badge-dot"]')).toBeNull();
  });

  it("merges the className prop", () => {
    const { container } = mount(
      <Badge className="my-extra" variant="info">
        Extra
      </Badge>,
    );
    const badge = container.querySelector("span");
    expect(badge?.className).toMatch(/my-extra/);
  });
});
