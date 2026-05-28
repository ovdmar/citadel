import fs from "node:fs";
import path from "node:path";
import { SqliteStore } from "@citadel/db";

const checkout = process.cwd();
const dataDir = process.env.CITADEL_DATA_DIR ?? path.join(checkout, ".citadel", "data");
const seedSqlPath = path.join(checkout, "seeds", "seed.sql");
const scratchpadSeedPath = path.join(checkout, "seeds", "scratchpad.md");
const dbPath = path.join(dataDir, "citadel.sqlite");

fs.mkdirSync(dataDir, { recursive: true });

const store = new SqliteStore(dbPath);
store.migrate();

const sentinelWorkspaceId = "33333333-3333-4333-8333-333333333333";
const existing = store.query<{ c: number }>(`SELECT COUNT(*) AS c FROM workspaces WHERE id = '${sentinelWorkspaceId}'`);
const alreadySeeded = (existing[0]?.c ?? 0) > 0;

if (alreadySeeded) {
  console.log("✓ Seed rows already present, skipping SQL");
} else {
  const sql = fs.readFileSync(seedSqlPath, "utf-8").replaceAll("@CHECKOUT@", checkout);
  store.exec(sql);
  console.log(`✓ Seed SQL applied to ${dbPath}`);
}

store.close();

const scratchpadDest = path.join(dataDir, "scratchpad.md");
if (!fs.existsSync(scratchpadDest)) {
  fs.copyFileSync(scratchpadSeedPath, scratchpadDest);
  console.log(`✓ Scratchpad seeded at ${scratchpadDest}`);
}
