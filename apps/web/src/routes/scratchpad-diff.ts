export type DiffLine = { kind: "context" | "add" | "remove"; text: string };

export type SideRow =
  | { kind: "context"; oldNo: number; newNo: number; text: string }
  | { kind: "add"; newNo: number; text: string }
  | { kind: "remove"; oldNo: number; text: string }
  | { kind: "skip"; hiddenCount: number };

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

export function sideBySideDiff(oldText: string, newText: string, contextLines = 3): SideRow[] {
  const lines = lineDiff(oldText, newText);
  const expanded: SideRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of lines) {
    if (line.kind === "context") {
      oldNo += 1;
      newNo += 1;
      expanded.push({ kind: "context", oldNo, newNo, text: line.text });
    } else if (line.kind === "add") {
      newNo += 1;
      expanded.push({ kind: "add", newNo, text: line.text });
    } else {
      oldNo += 1;
      expanded.push({ kind: "remove", oldNo, text: line.text });
    }
  }
  const out: SideRow[] = [];
  let i = 0;
  while (i < expanded.length) {
    const current = expanded[i];
    if (!current || current.kind !== "context") {
      if (current) out.push(current);
      i += 1;
      continue;
    }
    let j = i;
    while (j < expanded.length && expanded[j]?.kind === "context") j += 1;
    const runLen = j - i;
    const isStart = out.length === 0;
    const isEnd = j === expanded.length;
    const lead = isStart ? 0 : contextLines;
    const trail = isEnd ? 0 : contextLines;
    if (runLen <= lead + trail) {
      for (let k = i; k < j; k += 1) {
        const row = expanded[k];
        if (row) out.push(row);
      }
    } else {
      for (let k = i; k < i + lead; k += 1) {
        const row = expanded[k];
        if (row) out.push(row);
      }
      out.push({ kind: "skip", hiddenCount: runLen - lead - trail });
      for (let k = j - trail; k < j; k += 1) {
        const row = expanded[k];
        if (row) out.push(row);
      }
    }
    i = j;
  }
  return out;
}
