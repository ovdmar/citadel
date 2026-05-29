import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseUrl = process.env.CITADEL_BASE_URL || "http://127.0.0.1:4010";
const headers = await authHeaders();

for (const path of ["/api/health", "/api/state", "/api/mcp/status"]) {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const body = await response.json();
  console.log(`${path} ok`, JSON.stringify(body).slice(0, 240));
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = process.env.CITADEL_AUTH_TOKEN ?? (await tokenFromStatus()) ?? tokenFromDefaultPath();
  return token ? { "X-Citadel-Auth-Token": token } : {};
}

async function tokenFromStatus() {
  try {
    const response = await fetch(`${baseUrl}/api/auth/status`);
    if (!response.ok) return null;
    const body = (await response.json()) as { enabled?: boolean; tokenPath?: string | null };
    if (!body.enabled) return null;
    return body.tokenPath ? readToken(body.tokenPath) : null;
  } catch {
    return null;
  }
}

function tokenFromDefaultPath() {
  const dataDir = process.env.CITADEL_DATA_DIR || path.join(os.homedir(), ".local", "share", "citadel");
  return readToken(path.join(dataDir, "auth-token"));
}

function readToken(tokenPath: string) {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}
