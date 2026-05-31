import { describe, expect, it } from "vitest";
import { renderTemplate } from "./template.js";

describe("renderTemplate", () => {
  it("returns the body unchanged when no tokens are present", () => {
    expect(renderTemplate("hello world", {})).toBe("hello world");
  });

  it("substitutes a single-level key", () => {
    expect(renderTemplate("hi {{name}}", { name: "Alice" })).toBe("hi Alice");
  });

  it("substitutes nested dotted paths", () => {
    expect(renderTemplate("ws={{workspace.id}}", { workspace: { id: "ws_42" } })).toBe("ws=ws_42");
  });

  it("substitutes the same token multiple times", () => {
    expect(renderTemplate("{{x}} and {{x}}", { x: "foo" })).toBe("foo and foo");
  });

  it("leaves missing paths as the literal token (no crash)", () => {
    expect(renderTemplate("hi {{missing.path}}", { name: "Alice" })).toBe("hi {{missing.path}}");
  });

  it("stringifies non-string leaves (numbers, booleans)", () => {
    expect(renderTemplate("{{n}}", { n: 42 })).toBe("42");
    expect(renderTemplate("{{b}}", { b: true })).toBe("true");
  });

  it("supports numeric path segments for array indexing", () => {
    const payload = { links: [{ url: "https://a" }, { url: "https://b" }] };
    expect(renderTemplate("{{links.0.url}}", payload)).toBe("https://a");
    expect(renderTemplate("{{links.1.url}}", payload)).toBe("https://b");
  });

  it("does NOT traverse the prototype chain (no Object.constructor leak)", () => {
    expect(renderTemplate("{{__proto__.constructor.name}}", {})).toBe("{{__proto__.constructor.name}}");
    expect(renderTemplate("{{constructor.name}}", {})).toBe("{{constructor.name}}");
  });

  it("treats null payload as missing — every token renders literal", () => {
    expect(renderTemplate("{{anything}}", null)).toBe("{{anything}}");
  });

  it("does not recursively re-render substituted values containing {{ }}", () => {
    expect(renderTemplate("{{x}}", { x: "{{y}}" })).toBe("{{y}}");
  });

  it("leaves paths that hit an object (non-string leaf with no further traversal) as literal", () => {
    // A nested object is not a printable leaf; rendering as [object Object]
    // would be surprising. Render literal so the hook author notices.
    expect(renderTemplate("{{workspace}}", { workspace: { id: "ws_1" } })).toBe("{{workspace}}");
  });
});
