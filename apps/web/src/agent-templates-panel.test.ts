import { describe, expect, it } from "vitest";
import panelSource from "./agent-templates-panel.tsx?raw";

describe("AgentTemplatesPanel source contract", () => {
  it("uses predefined template endpoints without custom CRUD affordances", () => {
    expect(panelSource).toContain("/api/agent-templates");
    expect(panelSource).toContain("Save role");
    expect(panelSource).toContain("Reset action");
    expect(panelSource).not.toContain("New custom");
    expect(panelSource).not.toContain("Delete action");
  });
});
