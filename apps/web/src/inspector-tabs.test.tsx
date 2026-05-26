// @vitest-environment happy-dom
//
// Pins the contracts that inspector-deploy.css and inspector-meta.css
// depend on after the Tabs primitive migration:
//   - `.inspector-tabs` element carries `data-active="<tab>"` at the LIST
//     wrapper level (not the trigger). Load-bearing for the indicator
//     animation styled at inspector-deploy.css:94.
//   - The active trigger gets `data-state="active"` from Radix.
//   - The Diff trigger renders a `.inspector-tab-count` only when the
//     file count is positive.

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "./components/ui/test-utils.js";
import { InspectorTabs } from "./inspector-tabs.js";

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

describe("InspectorTabs (Tabs primitive migration)", () => {
  it("renders data-active on the .inspector-tabs wrapper so CSS selectors match", () => {
    const { container } = mount(
      <InspectorTabs tab="stats" onTabChange={() => {}} fileCount={0} onCollapse={() => {}} />,
    );
    const list = container.querySelector(".inspector-tabs");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("data-active")).toBe("stats");
    expect(list?.getAttribute("role")).toBe("tablist");
  });

  it("marks the active trigger with data-state=active and the others inactive", () => {
    const { container } = mount(
      <InspectorTabs tab="diff" onTabChange={() => {}} fileCount={0} onCollapse={() => {}} />,
    );
    const triggers = Array.from(container.querySelectorAll('[role="tab"]'));
    const stats = triggers.find((t) => t.textContent?.includes("Stats"));
    const diff = triggers.find((t) => t.textContent?.includes("Diff"));
    expect(stats?.getAttribute("data-state")).toBe("inactive");
    expect(diff?.getAttribute("data-state")).toBe("active");
  });

  it("renders the file-count badge only when fileCount > 0", () => {
    const { container, rerender } = mount(
      <InspectorTabs tab="diff" onTabChange={() => {}} fileCount={3} onCollapse={() => {}} />,
    );
    expect(container.querySelector(".inspector-tab-count")?.textContent).toBe("3");
    rerender(<InspectorTabs tab="diff" onTabChange={() => {}} fileCount={0} onCollapse={() => {}} />);
    expect(container.querySelector(".inspector-tab-count")).toBeNull();
  });

  it("calls onCollapse when the collapse button is clicked", () => {
    const onCollapse = vi.fn();
    const { container } = mount(
      <InspectorTabs tab="stats" onTabChange={() => {}} fileCount={null} onCollapse={onCollapse} />,
    );
    const collapse = container.querySelector(".inspector-tabs-collapse") as HTMLButtonElement | null;
    collapse?.click();
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
