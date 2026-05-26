// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "./test-utils.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip.js";

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

describe("Tooltip", () => {
  it("renders the trigger and keeps the tooltip content hidden initially", () => {
    const { container } = mount(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Helpful</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(container.textContent).toContain("Hover me");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("supports defaultOpen so it renders the tooltip body with role=tooltip", () => {
    mount(
      <TooltipProvider delayDuration={0}>
        <Tooltip defaultOpen>
          <TooltipTrigger>x</TooltipTrigger>
          <TooltipContent>Body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip).not.toBeNull();
    expect(tip?.textContent).toContain("Body");
  });
});
