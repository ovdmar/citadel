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
  configured = true;
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
