import fs from "node:fs";
import path from "node:path";

type Rule = {
  scope: string;
  forbidden: string[];
};

const root = process.cwd();
const rules: Rule[] = [
  {
    scope: "packages/core/src",
    forbidden: [
      "@citadel/db",
      "@citadel/providers",
      "@citadel/runtimes",
      "@citadel/hooks",
      "@citadel/terminal",
      "@citadel/mcp",
      "@citadel/config",
      "express",
      "react",
      "node:fs",
      "node:child_process",
    ],
  },
  {
    scope: "apps/web/src",
    forbidden: [
      "@citadel/db",
      "@citadel/operations",
      "@citadel/providers",
      "@citadel/runtimes",
      "@citadel/terminal",
      "node:",
    ],
  },
  {
    // @citadel/hooks owns the file-based hook discovery + frontmatter +
    // template surfaces. It must stay free of @citadel/operations because
    // operations IS the wiring layer that injects dispatchAgentHook into
    // the hooks runner — taking a direct edge would invert the dependency.
    scope: "packages/hooks/src",
    forbidden: ["@citadel/operations"],
  },
];

const violations: string[] = [];
for (const rule of rules) {
  for (const file of walk(path.join(root, rule.scope))) {
    const text = fs.readFileSync(file, "utf8");
    for (const forbidden of rule.forbidden) {
      if (text.includes(`from "${forbidden}`) || text.includes(`from '${forbidden}`)) {
        violations.push(`${path.relative(root, file)} imports forbidden dependency ${forbidden}`);
      }
    }
  }
}

const legacyWorkflowFiles = walk(root).filter((file) => {
  if (file.includes("node_modules") || file.includes(".git")) return false;
  const marker = ["open", "claw"].join("");
  return fs.readFileSync(file, "utf8").toLowerCase().includes(marker);
});
for (const file of legacyWorkflowFiles) {
  const relative = path.relative(root, file);
  if (!relative.startsWith("docs/")) violations.push(`${relative} contains legacy workflow coupling`);
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name === "coverage")
      return [];
    if (entry.isDirectory()) return walk(absolute);
    if (!/\.(ts|tsx|js|jsx|json|md)$/.test(entry.name)) return [];
    return [absolute];
  });
}
