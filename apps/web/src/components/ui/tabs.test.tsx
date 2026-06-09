// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.js";
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

describe("Tabs", () => {
  it("renders the active panel for defaultValue", () => {
    const { container } = mount(
      <Tabs defaultValue="b">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">panel a</TabsContent>
        <TabsContent value="b">panel b</TabsContent>
      </Tabs>,
    );
    expect(container.textContent).toContain("panel b");
    expect(container.textContent).not.toContain("panel a");
  });

  it("exposes data-state on triggers (active vs inactive)", () => {
    const { container } = mount(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">a</TabsContent>
        <TabsContent value="b">b</TabsContent>
      </Tabs>,
    );
    const triggers = container.querySelectorAll('[role="tab"]');
    expect(triggers[0]?.getAttribute("data-state")).toBe("active");
    expect(triggers[1]?.getAttribute("data-state")).toBe("inactive");
  });

  it("propagates data-active onto the TabsList wrapper (inspector.css contract)", () => {
    const { container } = mount(
      <Tabs defaultValue="b">
        <TabsList data-active="b">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">a</TabsContent>
        <TabsContent value="b">b</TabsContent>
      </Tabs>,
    );
    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute("data-active")).toBe("b");
  });
});
