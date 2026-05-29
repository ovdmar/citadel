import fs from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("daemon auth", () => {
  it("protects daemon API, MCP, SSE, and terminal HTTP surfaces until login", async () => {
    const fixture = createFixture(dirs);
    const { server } = createDaemonApp({ ...fixture, auth: { enabled: true, token: "local-secret" } });
    const baseUrl = await listen(server);
    try {
      await expectStatus(baseUrl, "/api/state", 401);
      await expectStatus(baseUrl, "/api/mcp/status", 401);
      await expectStatus(baseUrl, "/events", 401);
      await expectStatus(baseUrl, "/terminals/missing/", 401);

      const publicStatus = await fetch(`${baseUrl}/api/auth/status`);
      expect(publicStatus.status).toBe(200);
      await expect(publicStatus.json()).resolves.toMatchObject({
        enabled: true,
        authenticated: false,
      });

      const rejected = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "wrong" }),
      });
      expect(rejected.status).toBe(401);

      const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "local-secret" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie");
      expect(cookie).toContain("citadel_session=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).not.toContain("local-secret");

      const state = await fetch(`${baseUrl}/api/state`, { headers: { Cookie: cookie ?? "" } });
      expect(state.status).toBe(200);

      const status = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie ?? "" } });
      await expect(status.json()).resolves.toMatchObject({
        enabled: true,
        authenticated: true,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("accepts bearer and explicit token headers without putting the raw token in the cookie", async () => {
    const fixture = createFixture(dirs);
    const { server } = createDaemonApp({ ...fixture, auth: { enabled: true, token: "automation-secret" } });
    const baseUrl = await listen(server);
    try {
      expect(
        (await fetch(`${baseUrl}/api/state`, { headers: { Authorization: "Bearer automation-secret" } })).status,
      ).toBe(200);
      expect(
        (await fetch(`${baseUrl}/api/state`, { headers: { "X-Citadel-Auth-Token": "automation-secret" } })).status,
      ).toBe(200);
      expect(
        (await fetch(`${baseUrl}/api/state`, { headers: { Cookie: "citadel_session=automation-secret" } })).status,
      ).toBe(401);
    } finally {
      await closeServer(server);
    }
  });

  it("generates a reusable 0600 data-dir token when no explicit token is supplied", async () => {
    const fixture = createFixture(dirs);
    const first = createDaemonApp({ ...fixture, auth: { enabled: true } });
    const firstUrl = await listen(first.server);
    try {
      const tokenPath = `${fixture.config.dataDir}/auth-token`;
      const token = fs.readFileSync(tokenPath, "utf8").trim();
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
      expect((await fetch(`${firstUrl}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
        200,
      );
    } finally {
      await closeServer(first.server);
    }

    const tokenPath = `${fixture.config.dataDir}/auth-token`;
    const tokenBefore = fs.readFileSync(tokenPath, "utf8");
    const second = createDaemonApp({ ...fixture, auth: { enabled: true } });
    await listen(second.server);
    try {
      expect(fs.readFileSync(tokenPath, "utf8")).toBe(tokenBefore);
    } finally {
      await closeServer(second.server);
    }
  });

  it("rejects unauthenticated terminal websocket upgrades before route-specific resolution", async () => {
    const fixture = createFixture(dirs);
    const { server } = createDaemonApp({ ...fixture, auth: { enabled: true, token: "upgrade-secret" } });
    const baseUrl = await listen(server);
    try {
      await expect(rawUpgradeStatus(baseUrl, "/terminals/missing/ws")).resolves.toBe(401);
      await expect(rawUpgradeStatus(baseUrl, "/terminal/missing")).resolves.toBe(401);
    } finally {
      await closeServer(server);
    }
  });
});

async function expectStatus(baseUrl: string, path: string, status: number) {
  const response = await fetch(`${baseUrl}${path}`);
  expect(response.status, path).toBe(status);
  if (status === 401) await expect(response.json()).resolves.toMatchObject({ error: "auth_required" });
}

function rawUpgradeStatus(baseUrl: string, pathname: string) {
  const url = new URL(baseUrl);
  const port = Number(url.port);
  return new Promise<number>((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port }, () => {
      socket.write(
        [
          `GET ${pathname} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n"),
      );
    });
    let data = "";
    socket.setTimeout(1000);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(data);
      if (statusMatch) {
        socket.destroy();
        resolve(Number(statusMatch[1]));
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`Timed out waiting for upgrade response: ${data}`));
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const statusMatch = /^HTTP\/1\.1\s+(\d+)/.exec(data);
      if (statusMatch) resolve(Number(statusMatch[1]));
    });
  });
}
