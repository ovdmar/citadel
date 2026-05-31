import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./frontmatter.js";

describe("parseFrontmatter", () => {
  it("returns empty meta and full body when there is no frontmatter", () => {
    expect(parseFrontmatter("just a prompt\n")).toEqual({ meta: {}, body: "just a prompt\n" });
  });

  it("returns empty meta and empty body for an empty file", () => {
    expect(parseFrontmatter("")).toEqual({ meta: {}, body: "" });
  });

  it("handles a frontmatter block with zero keys (--- followed immediately by ---)", () => {
    const result = parseFrontmatter("---\n---\nbody\n");
    expect(result).toEqual({ meta: {}, body: "body\n" });
  });

  it("parses single key:value lines", () => {
    const result = parseFrontmatter("---\nruntime: claude-code\nmodel: opus\n---\nbody text\n");
    expect(result.meta).toEqual({ runtime: "claude-code", model: "opus" });
    expect(result.body).toBe("body text\n");
  });

  it("preserves colons in values (split on FIRST colon-space only)", () => {
    const result = parseFrontmatter("---\ndisplayName: Hootsuite: notify\n---\nbody\n");
    expect(result.meta.displayName).toBe("Hootsuite: notify");
  });

  it("strips trailing CR (defensive: file came from a CRLF copy-paste)", () => {
    const result = parseFrontmatter("---\r\nruntime: claude-code\r\n---\r\nbody\r\n");
    expect(result.meta).toEqual({ runtime: "claude-code" });
  });

  it("returns error on malformed line (no partial meta)", () => {
    const result = parseFrontmatter("---\nruntime: claude-code\nno colon here\n---\nbody\n");
    expect(result.error).toMatch(/malformed frontmatter line/);
    expect(result.meta).toEqual({});
  });

  it("treats whole file as body if the opening --- isn't on the first line", () => {
    const result = parseFrontmatter("\n---\nfoo: bar\n---\nbody\n");
    expect(result).toEqual({ meta: {}, body: "\n---\nfoo: bar\n---\nbody\n" });
  });

  it("treats whole file as body if there is no closing fence", () => {
    const result = parseFrontmatter("---\nruntime: claude-code\nbut no closing fence");
    expect(result).toEqual({ meta: {}, body: "---\nruntime: claude-code\nbut no closing fence" });
  });

  it("preserves trailing whitespace in values verbatim (no trimming)", () => {
    const result = parseFrontmatter("---\nmodel: opus   \n---\nbody\n");
    expect(result.meta.model).toBe("opus   ");
  });
});
