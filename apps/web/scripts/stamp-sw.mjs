// Stamp the built service-worker.js with a unique-per-build VERSION so each
// `make deploy` actually triggers the browser to install the new SW and
// drop its cached app shell. Without this the SW body is byte-identical
// across deploys and browsers never re-install.
//
// Run as a postbuild step from apps/web/package.json:
//   "build": "vite build && node scripts/stamp-sw.mjs"
//
// The stamp combines the git short SHA (when available) with the build
// timestamp so we still have a unique value in non-git environments.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.resolve(here, "..", "dist", "service-worker.js");

let sha = "no-git";
try {
  sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
} catch {
  // Outside a git checkout (CI snapshot, packaged tarball, etc.).
}
const stamp = `${sha}-${Date.now()}`;

const PLACEHOLDER = "__CITADEL_BUILD_ID__";
const original = readFileSync(swPath, "utf8");
if (!original.includes(PLACEHOLDER)) {
  console.warn(`[stamp-sw] ${PLACEHOLDER} not found in ${swPath} — leaving SW untouched.`);
  process.exit(0);
}
const stamped = original.replaceAll(PLACEHOLDER, stamp);
writeFileSync(swPath, stamped);
console.log(`[stamp-sw] service-worker.js stamped with VERSION="${stamp}"`);
