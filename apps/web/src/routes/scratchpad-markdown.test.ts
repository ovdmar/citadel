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

  it("strips block <script> tags", () => {
    const html = renderBlockMarkdown("<script>alert(1)</script>\n\nplain text");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/alert\(1\)/);
  });

  // Raw inline HTML is now escaped to literal text (see angle-bracket regression
  // tests below) so there's no live `<a>` element to attach event handlers to —
  // both stricter and simpler than the old "parse then sanitize" path. Users
  // who want a link write markdown syntax `[label](url)`.
  it("escapes raw inline HTML anchors so onerror/onclick are inert text", () => {
    const html = renderBlockMarkdown(`see <a href="https://example.test" onerror="x()" onclick="y()">link</a> here`);
    // No live anchor with these attributes.
    expect(html).not.toMatch(/<a[^>]*onerror/i);
    expect(html).not.toMatch(/<a[^>]*onclick/i);
    // The raw markup is rendered as literal escaped text instead.
    expect(html).toMatch(/&lt;a/);
    expect(html).toMatch(/href=&quot;https:\/\/example\.test&quot;|href="https:\/\/example\.test"/);
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

  it("strips javascript: URLs in markdown links", () => {
    // Markdown link with javascript: scheme — DOMPurify removes the href entirely.
    const html1 = renderBlockMarkdown("[click](javascript:alert(1))");
    expect(html1).not.toMatch(/href="javascript:/i);
    expect(html1).not.toMatch(/alert\(1\)/);
  });

  it("renders raw HTML anchors with javascript: as inert escaped text", () => {
    // Raw inline HTML is escaped, so there's no live href at all (stricter
    // than the old behavior, which produced a sanitized `<a>` with no href).
    const html = renderBlockMarkdown(`<a href="javascript:alert(1)">go</a>`);
    expect(html).not.toMatch(/<a[^>]+href="javascript:/i);
    // The raw markup appears as literal text; the `javascript:` substring is
    // visible but inert (no live anchor, no JS execution).
    expect(html).toMatch(/&lt;a/);
  });

  it("returns empty string for empty input", () => {
    expect(renderBlockMarkdown("")).toBe("");
    expect(renderBlockMarkdown("   ")).toBe("");
  });

  // Regression: blocks containing bare <foo> were previously parsed by marked
  // as raw inline HTML and then stripped by DOMPurify, mutating displayed text
  // even though the stored markdown was intact. We now keep these as text.
  it("preserves bare angle-bracket sequences as text (lookup <user_id>)", () => {
    const html = renderBlockMarkdown("lookup <user_id> in users");
    // Either the literal char or the escaped entity is acceptable — both show
    // the same visible text to the user. What matters is the token isn't
    // dropped entirely.
    const hasLiteral = html.includes("<user_id>");
    const hasEscaped = html.includes("&lt;user_id&gt;");
    expect(hasLiteral || hasEscaped).toBe(true);
    // And the surrounding plain text must survive.
    expect(html).toMatch(/lookup/);
    expect(html).toMatch(/in users/);
  });

  it("preserves underscored angle-bracket tokens (<word_with_underscore>)", () => {
    const html = renderBlockMarkdown("see <thing_with_underscore> later");
    const hasLiteral = html.includes("<thing_with_underscore>");
    const hasEscaped = html.includes("&lt;thing_with_underscore&gt;");
    expect(hasLiteral || hasEscaped).toBe(true);
  });

  it("preserves multiple bare angle-bracket tokens in one block", () => {
    const html = renderBlockMarkdown("before <api> and <ui> after");
    expect(html.includes("<api>") || html.includes("&lt;api&gt;")).toBe(true);
    expect(html.includes("<ui>") || html.includes("&lt;ui&gt;")).toBe(true);
  });

  it("still renders https autolinks as anchors", () => {
    const html = renderBlockMarkdown("see <https://example.test/path>");
    // marked emits an <a> for <https://…> autolinks; this MUST keep working.
    expect(html).toMatch(/<a[^>]*href="https:\/\/example\.test\/path"/);
  });

  it("still renders email autolinks as mailto anchors", () => {
    const html = renderBlockMarkdown("contact <foo@bar.test>");
    expect(html).toMatch(/<a[^>]*href="mailto:foo@bar\.test"/);
  });

  it("preserves angle-bracket sequences inside fenced code blocks", () => {
    const md = ["```", "<user_id> in code", "```"].join("\n");
    const html = renderBlockMarkdown(md);
    // Fenced code escapes < and > to entities inside <pre><code>.
    expect(html).toMatch(/<pre><code[^>]*>[^<]*&lt;user_id&gt;/);
  });

  it("preserves angle-bracket sequences inside inline code", () => {
    const html = renderBlockMarkdown("call `<user_id>` first");
    expect(html).toMatch(/<code>&lt;user_id&gt;<\/code>/);
  });
});
