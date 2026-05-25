type DiffLine = { kind: "context" | "add" | "remove"; text: string };

export type SideRow =
  | { kind: "context"; oldNo: number; newNo: number; text: string }
  | { kind: "add"; newNo: number; text: string }
  | { kind: "remove"; oldNo: number; text: string }
  | { kind: "skip"; hiddenCount: number };

export type SideBySideResult =
  | { kind: "diff"; rows: SideRow[] }
  | { kind: "too_large"; oldLines: number; newLines: number; limit: number };

// LCS allocates O(n*m) cells. SCRATCHPAD_MAX_BYTES is 1_000_000 (~12.5k lines
// at typical density); a full max-vs-max compare would allocate ~156M cells
// (~600 MB-1.2 GB heap) and crash the tab. Cap defensively and let the UI
// render a "diff too large" notice that still exposes restore.
export const MAX_DIFF_LINES = 2000;

export function sideBySideDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
  maxLines = MAX_DIFF_LINES,
): SideBySideResult {
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  if (oldLines > maxLines || newLines > maxLines) {
    return { kind: "too_large", oldLines, newLines, limit: maxLines };
  }
  return { kind: "diff", rows: buildRows(oldText, newText, contextLines) };
}

function countLines(text: string): number {
  if (text.length === 0) return 1;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines += 1;
  return lines;
}

function buildRows(oldText: string, newText: string, contextLines: number): SideRow[] {
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

function lineDiff(oldText: string, newText: string): DiffLine[] {
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
