// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Panel, PanelBody, PanelFooter, PanelHeader, PanelTitle } from "./panel.js";
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

describe("Panel", () => {
  it("renders Panel + PanelHeader + PanelBody + PanelFooter composition", () => {
    const { container } = mount(
      <Panel>
        <PanelHeader>
          <PanelTitle>Status</PanelTitle>
        </PanelHeader>
        <PanelBody>body content</PanelBody>
        <PanelFooter>footer</PanelFooter>
      </Panel>,
    );
    expect(container.querySelector('[data-component="panel"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="panel-header"]')?.tagName).toBe("HEADER");
    expect(container.querySelector('[data-slot="panel-body"]')?.textContent).toBe("body content");
    expect(container.querySelector('[data-slot="panel-footer"]')?.textContent).toBe("footer");
  });

  it("PanelTitle renders with uppercase-style classes (small caps label)", () => {
    const { container } = mount(<PanelTitle>Section</PanelTitle>);
    const title = container.querySelector('[data-slot="panel-title"]');
    expect(title?.className).toMatch(/uppercase/);
  });
});
