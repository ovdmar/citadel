// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { FormField } from "./form-field.js";
import { Input } from "./input.js";
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

describe("FormField", () => {
  it("associates the Label with the inner control via htmlFor + id", () => {
    const { container } = mount(
      <FormField label="Name" id="name-field">
        <Input />
      </FormField>,
    );
    const label = container.querySelector("label");
    const input = container.querySelector("input");
    expect(label?.getAttribute("for")).toBe("name-field");
    expect(input?.getAttribute("id")).toBe("name-field");
  });

  it("auto-generates an id when none is provided so the label still associates", () => {
    const { container } = mount(
      <FormField label="Email">
        <Input />
      </FormField>,
    );
    const label = container.querySelector("label");
    const input = container.querySelector("input");
    expect(label?.getAttribute("for")).toBeTruthy();
    expect(label?.getAttribute("for")).toBe(input?.getAttribute("id"));
  });

  it("renders an error slot announced via aria-describedby", () => {
    const { container } = mount(
      <FormField label="Url" id="u" error="Required">
        <Input />
      </FormField>,
    );
    const errorEl = container.querySelector('[data-slot="form-error"]');
    expect(errorEl?.textContent).toBe("Required");
    const errorId = errorEl?.getAttribute("id");
    const describedBy = container.querySelector("input")?.getAttribute("aria-describedby");
    expect(describedBy).toBe(errorId);
    expect(container.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
  });

  it("renders a HelpText slot announced via aria-describedby when no error", () => {
    const { container } = mount(
      <FormField label="Name" id="n" help="Used for greeting">
        <Input />
      </FormField>,
    );
    const helpEl = container.querySelector('[data-slot="form-help"]');
    expect(helpEl?.textContent).toBe("Used for greeting");
    const helpId = helpEl?.getAttribute("id");
    expect(container.querySelector("input")?.getAttribute("aria-describedby")).toBe(helpId);
    expect(container.querySelector("input")?.hasAttribute("aria-invalid")).toBe(false);
  });

  it("renders the required marker when required is true", () => {
    const { container } = mount(
      <FormField label="Name" id="n" required>
        <Input />
      </FormField>,
    );
    const marker = container.querySelector('[data-slot="form-required"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("*");
    expect(container.querySelector("input")?.hasAttribute("required")).toBe(true);
  });
});
