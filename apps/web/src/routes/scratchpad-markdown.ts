import DOMPurify from "dompurify";
import { marked } from "marked";

// Configure DOMPurify once per module load. Adds rel="noopener noreferrer" to every
// <a> with a target/href, and strips <img> entirely. Block content can originate
// from MCP agents whose output we treat as untrusted, so the image stance is
// "drop, don't load" for v1.
let configured = false;
function configure() {
  if (configured) return;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("rel", "noopener noreferrer");
      node.setAttribute("target", "_blank");
    }
  });
  // Escape inline raw-HTML so bare `<word>` in user text renders as literal
  // text instead of being tokenized as an unknown HTML tag and then stripped
  // by DOMPurify — that round trip previously deleted `<user_id>`-style tokens
  // from blocks even though the stored markdown was intact. Autolinks
  // (`<https://…>`, `<foo@bar>`) are tokenized as `link` not `html`, so they
  // continue to render. Block-level html (`<script>…</script>` etc.) passes
  // through to DOMPurify for sanitization, so XSS hardening is unchanged.
  marked.use({
    renderer: {
      html({ text, block }) {
        return block ? text : escapeHtml(text);
      },
    },
  });
  configured = true;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderBlockMarkdown(text: string): string {
  if (!text || text.trim().length === 0) return "";
  configure();
  const html = marked.parse(text, { breaks: true, async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img"],
  });
}
