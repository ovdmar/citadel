import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const maxLines = 800;
const violations = walk(root)
  .map((file) => ({ file, lines: fs.readFileSync(file, "utf8").split("\n").length }))
  .filter((entry) => entry.lines > maxLines);

if (violations.length > 0) {
  console.error(violations.map((entry) => `${path.relative(root, entry.file)} has ${entry.lines} lines`).join("\n"));
  process.exit(1);
}

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (["node_modules", ".git", "dist", "coverage", "test-results", "playwright-report"].includes(entry.name))
      return [];
    if (entry.isDirectory()) return walk(absolute);
    if (!/\.(ts|tsx|js|jsx|css|md)$/.test(entry.name)) return [];
    return [absolute];
  });
}
