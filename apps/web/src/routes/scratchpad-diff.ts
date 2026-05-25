export type DiffLine = { kind: "context" | "add" | "remove"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowI = lcs[i] ?? [];
    const rowNext = lcs[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j -= 1) {
      rowI[j] = a[i] === b[j] ? (rowNext[j + 1] ?? 0) + 1 : Math.max(rowNext[j] ?? 0, rowI[j + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    const rowI = lcs[i] ?? [];
    const rowNext = lcs[i + 1] ?? [];
    if (ai === bj) {
      out.push({ kind: "context", text: ai });
      i += 1;
      j += 1;
    } else if ((rowNext[j] ?? 0) >= (rowI[j + 1] ?? 0)) {
      out.push({ kind: "remove", text: ai });
      i += 1;
    } else {
      out.push({ kind: "add", text: bj });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ kind: "remove", text: a[i] ?? "" });
    i += 1;
  }
  while (j < m) {
    out.push({ kind: "add", text: b[j] ?? "" });
    j += 1;
  }
  return out;
}
