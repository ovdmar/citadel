// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Select } from "./select.js";
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

describe("Select", () => {
  it("renders a native <select> with the provided options", () => {
    const { container } = mount(
      <Select defaultValue="b">
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    const select = container.querySelector("select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.value).toBe("b");
    expect(select?.options.length).toBe(2);
  });

  it("respects the disabled prop", () => {
    const { container } = mount(
      <Select disabled>
        <option value="x">x</option>
      </Select>,
    );
    expect(container.querySelector("select")?.hasAttribute("disabled")).toBe(true);
  });

  it("renders the focus-visible ring class", () => {
    const { container } = mount(
      <Select>
        <option value="x">x</option>
      </Select>,
    );
    expect(container.querySelector("select")?.className).toMatch(/focus-visible:ring-2/);
  });
});
