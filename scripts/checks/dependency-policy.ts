import fs from "node:fs";

const forbiddenLockfiles = ["package-lock.json", "yarn.lock"];
const presentForbidden = forbiddenLockfiles.filter((file) => fs.existsSync(file));
if (presentForbidden.length > 0) {
  console.error(`Forbidden lockfiles present: ${presentForbidden.join(", ")}`);
  process.exit(1);
}

if (!fs.existsSync("pnpm-lock.yaml")) {
  console.error("pnpm-lock.yaml is required. Run pnpm install and review the lockfile before merging.");
  process.exit(1);
}

const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8")) as { packageManager?: string };
if (!rootPackage.packageManager?.startsWith("pnpm@")) {
  console.error("packageManager must pin pnpm.");
  process.exit(1);
}
