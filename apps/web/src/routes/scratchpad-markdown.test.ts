// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderBlockMarkdown } from "./scratchpad-markdown.js";

describe("renderBlockMarkdown", () => {
  it("renders headings, lists, bold/italic, inline + fenced code", () => {
    const md = [
      "# Heading",
      "",
      "- one",
      "- two",
      "",
      "**bold** and *italic*",
      "",
      "`inline` then",
      "```",
      "fenced code",
      "```",
    ].join("\n");
    const html = renderBlockMarkdown(md);
    expect(html).toMatch(/<h1[^>]*>Heading<\/h1>/);
    expect(html).toMatch(/<ul>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ul>/);
    expect(html).toMatch(/<strong>bold<\/strong>/);
    expect(html).toMatch(/<em>italic<\/em>/);
    expect(html).toMatch(/<code>inline<\/code>/);
    expect(html).toMatch(/<pre><code[^>]*>fenced code\n<\/code><\/pre>/);
  });

  it("strips <script> tags and inline event handlers", () => {
    const html = renderBlockMarkdown("<script>alert(1)</script>\n\nplain text");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/alert\(1\)/);
    const html2 = renderBlockMarkdown(`<a href="https://example.test" onerror="x()" onclick="y()">link</a>`);
    expect(html2).not.toMatch(/onerror/i);
    expect(html2).not.toMatch(/onclick/i);
    expect(html2).toMatch(/<a[^>]*href="https:\/\/example\.test"[^>]*>link<\/a>/);
  });

  it("strips <img> tags entirely (v1 FORBID_TAGS policy)", () => {
    const html1 = renderBlockMarkdown("![alt](https://example.test/x.png)");
    expect(html1).not.toMatch(/<img/i);
    const html2 = renderBlockMarkdown(`<img src="http://attacker.example/probe">`);
    expect(html2).not.toMatch(/<img/i);
    expect(html2).not.toMatch(/attacker\.example/);
  });

  it("renders markdown links as anchors with safe rel + target attributes", () => {
    const html = renderBlockMarkdown("[Click](https://example.test/path)");
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.test\/path"/);
    expect(html).toMatch(/<a[^>]*rel="noopener noreferrer"/);
    // afterSanitizeAttributes hook also sets target so block links open in a new tab.
    expect(html).toMatch(/<a[^>]*target="_blank"/);
  });

  it("strips javascript: URLs in both markdown and raw HTML links", () => {
    // Markdown link with javascript: scheme — DOMPurify removes the href entirely.
    const html1 = renderBlockMarkdown("[click](javascript:alert(1))");
    expect(html1).not.toMatch(/href="javascript:/i);
    expect(html1).not.toMatch(/alert\(1\)/);
    // Raw HTML link with javascript: scheme — same.
    const html2 = renderBlockMarkdown(`<a href="javascript:alert(1)">go</a>`);
    expect(html2).not.toMatch(/href="javascript:/i);
    expect(html2).not.toMatch(/alert\(1\)/);
  });

  it("returns empty string for empty input", () => {
    expect(renderBlockMarkdown("")).toBe("");
    expect(renderBlockMarkdown("   ")).toBe("");
  });
});
