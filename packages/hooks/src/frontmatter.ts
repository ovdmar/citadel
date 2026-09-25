// Minimal line-oriented frontmatter parser for `.agent` hook files.
//
// We deliberately do NOT pull in a YAML library: the supported surface is a
// flat `key: value` map at the top of the file, and a 30-line parser closes
// the lockfile-sensitivity gate that a real YAML dep would open. The frontmatter
// is also user-authored and lives in the repo — any parser bug would surface
// as a clear "malformed frontmatter line" diagnostic, not silent misbehavior.

export type Frontmatter = {
  meta: Record<string, string>;
  body: string;
  error?: string;
};

// Keys are camelCase identifiers (matches the zod schema: runtime, model,
// displayName). The value half (`.+`) is greedy by design — colons inside
// values (`displayName: Hootsuite: notify`) parse correctly because the regex
// matches the longest possible value after the first `: `.
const LINE_RE = /^([a-zA-Z][a-zA-Z0-9_-]*): (.+)$/;

export function parseFrontmatter(content: string): Frontmatter {
  // Must begin with `---\n` to be a frontmatter block. Anything else is body.
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { meta: {}, body: content };
  }
  const openLen = content.startsWith("---\r\n") ? 5 : 4;
  const rest = content.slice(openLen);
  // Closing fence: a line containing only ---. We accept LF or CRLF endings.
  const closeMatch = /(^|\n)---(\r?\n|$)/.exec(rest);
  if (!closeMatch || closeMatch.index === undefined) {
    return { meta: {}, body: content };
  }
  const headEnd = closeMatch.index + (closeMatch[1] === "\n" ? 1 : 0);
  const head = rest.slice(0, headEnd);
  const bodyStart = closeMatch.index + closeMatch[0].length;
  const body = rest.slice(bodyStart);

  const meta: Record<string, string> = {};
  if (head.length > 0) {
    const lines = head.split("\n");
    // Drop a trailing empty element produced by a final \n.
    if (lines[lines.length - 1] === "") lines.pop();
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const match = LINE_RE.exec(line);
      if (!match || match[1] === undefined || match[2] === undefined) {
        return { meta: {}, body, error: `malformed frontmatter line: ${line}` };
      }
      meta[match[1]] = match[2];
    }
  }
  return { meta, body };
}
