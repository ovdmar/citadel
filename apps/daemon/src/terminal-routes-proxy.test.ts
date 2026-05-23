import http from "node:http";
import { gzipSync } from "node:zlib";
import httpProxyImport from "http-proxy";
import { afterEach, describe, expect, it } from "vitest";
import { injectKeyShim, shouldInjectShim } from "./terminal-key-shim.js";

// Integration test for the response-rewriting branch of registerTerminalRoutes.
// We don't spin up the full daemon (it pulls in the sqlite store, ttyd manager,
// etc.); we recreate the same proxy.on("proxyRes", ...) wiring against a stub
// upstream so we can exercise the HTML injection / passthrough / compressed-
// response / non-200 paths end-to-end.

type HttpProxyModule = typeof httpProxyImport;
const httpProxy = (httpProxyImport as unknown as { default?: HttpProxyModule }).default ?? httpProxyImport;

type StubResponse = {
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
};

async function withRig(stub: StubResponse, fn: (url: string) => Promise<void>) {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(stub.status, stub.headers);
    res.end(stub.body);
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddr = upstream.address();
  if (!upstreamAddr || typeof upstreamAddr === "string") throw new Error("upstream listen failed");

  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true, selfHandleResponse: true });
  proxy.on("proxyRes", (proxyRes, _req, target) => {
    const httpRes = target as http.ServerResponse;
    httpRes.statusCode = proxyRes.statusCode ?? 200;
    const injectable = shouldInjectShim(proxyRes.headers, proxyRes.statusCode ?? 0);

    if (!injectable) {
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        httpRes.setHeader(name, value as string | string[]);
      }
      proxyRes.pipe(httpRes);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const original = Buffer.concat(chunks).toString("utf8");
      const modified = injectKeyShim(original);
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") continue;
        httpRes.setHeader(name, value as string | string[]);
      }
      const buffer = Buffer.from(modified, "utf8");
      httpRes.setHeader("content-length", String(buffer.length));
      httpRes.end(buffer);
    });
  });

  const front = http.createServer((req, res) => {
    proxy.web(req, res, { target: `http://127.0.0.1:${upstreamAddr.port}` });
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const frontAddr = front.address();
  if (!frontAddr || typeof frontAddr === "string") throw new Error("front listen failed");

  try {
    await fn(`http://127.0.0.1:${frontAddr.port}`);
  } finally {
    proxy.close();
    await new Promise<void>((resolve) => front.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

async function fetchProxied(url: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      })
      .on("error", reject);
  });
}

const trackers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of trackers.splice(0)) await cleanup();
});

describe("terminal-routes HTML rewrite integration", () => {
  it("injects the shim into a 200 text/html response", async () => {
    await withRig(
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: '<!doctype html><html><head><title>ttyd</title></head><body><script src="main.js"></script></body></html>',
      },
      async (url) => {
        const response = await fetchProxied(url);
        expect(response.status).toBe(200);
        const text = response.body.toString("utf8");
        expect(text).toContain("__citadelTerminalShim");
        const shimIdx = text.indexOf("__citadelTerminalShim");
        const bundleIdx = text.indexOf('src="main.js"');
        expect(shimIdx).toBeLessThan(bundleIdx);
        // content-length is recomputed for the rewritten body.
        expect(Number(response.headers["content-length"])).toBe(response.body.length);
      },
    );
  });

  it("passes JS bundle responses through untouched", async () => {
    const original = 'console.log("ttyd bundle");\n'.repeat(200);
    await withRig(
      {
        status: 200,
        headers: { "content-type": "application/javascript" },
        body: original,
      },
      async (url) => {
        const response = await fetchProxied(url);
        expect(response.status).toBe(200);
        expect(response.body.toString("utf8")).toBe(original);
        expect(response.body.toString("utf8")).not.toContain("__citadelTerminalShim");
      },
    );
  });

  it("does not corrupt a gzipped HTML response — passes through and preserves content-encoding", async () => {
    const html = "<!doctype html><html><head></head><body>hi</body></html>";
    const gzipped = gzipSync(Buffer.from(html, "utf8"));
    await withRig(
      {
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
        body: gzipped,
      },
      async (url) => {
        const response = await fetchProxied(url);
        expect(response.status).toBe(200);
        // Content-encoding survives so the browser will decode correctly.
        expect(response.headers["content-encoding"]).toBe("gzip");
        // Body bytes are unchanged (still gzipped).
        expect(Buffer.compare(response.body, gzipped)).toBe(0);
      },
    );
  });

  it("does not inject into non-200 HTML responses", async () => {
    await withRig(
      {
        status: 500,
        headers: { "content-type": "text/html" },
        body: "<html><body>server error</body></html>",
      },
      async (url) => {
        const response = await fetchProxied(url);
        expect(response.status).toBe(500);
        expect(response.body.toString("utf8")).not.toContain("__citadelTerminalShim");
      },
    );
  });
});
