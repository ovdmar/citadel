// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Input, Textarea } from "./input.js";
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

describe("Input", () => {
  it("renders an <input> with the focus-visible ring class", () => {
    const { container } = mount(<Input placeholder="Name" />);
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.className).toMatch(/focus-visible:ring-2/);
  });

  it("applies aria-invalid styling without removing the value", () => {
    const { container } = mount(<Input defaultValue="bad" aria-invalid="true" />);
    const input = container.querySelector("input") as HTMLInputElement | null;
    expect(input?.value).toBe("bad");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(input?.className).toMatch(/aria-invalid/);
  });

  it("becomes disabled when disabled prop is set", () => {
    const { container } = mount(<Input disabled />);
    const input = container.querySelector("input");
    expect(input?.hasAttribute("disabled")).toBe(true);
  });

  it("merges the className prop", () => {
    const { container } = mount(<Input className="my-input" />);
    const input = container.querySelector("input");
    expect(input?.className).toMatch(/my-input/);
  });
});

describe("Textarea", () => {
  it("renders a <textarea> with focus-visible styling and accepts rows", () => {
    const { container } = mount(<Textarea rows={4} />);
    const ta = container.querySelector("textarea");
    expect(ta).not.toBeNull();
    expect(Number(ta?.rows)).toBe(4);
    expect(ta?.className).toMatch(/focus-visible:ring-2/);
  });

  it("respects disabled", () => {
    const { container } = mount(<Textarea disabled />);
    expect(container.querySelector("textarea")?.hasAttribute("disabled")).toBe(true);
  });
});
