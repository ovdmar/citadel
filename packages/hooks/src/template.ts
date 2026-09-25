// Minimal Mustache-like template renderer for `.agent` hook bodies.
//
// Substitutes `{{a.b.c}}` against a JSON payload. Walks dotted paths using
// `Object.hasOwn` per hop — no prototype-chain traversal. Numeric segments
// index into arrays. Non-printable leaves (objects, arrays, null, undefined)
// render as the literal token, so hook authors notice typos instead of
// shipping `[object Object]` into a prompt.

const TOKEN_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

export function renderTemplate(body: string, payload: unknown): string {
  return body.replace(TOKEN_RE, (literal, path: string) => {
    const value = resolvePath(payload, path.split("."));
    if (value === undefined) return literal;
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    // Objects, arrays, null, functions — not a printable leaf.
    return literal;
  });
}

function resolvePath(root: unknown, segments: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of segments) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    // Object.hasOwn covers both arrays (numeric segments work because
    // `Object.hasOwn(arr, "0")` returns true for index 0) and plain objects,
    // and excludes prototype keys like `__proto__` / `constructor`.
    if (!Object.hasOwn(cursor as object, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}
