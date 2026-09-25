import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CitadelConfigSchema, validateTlsAssets } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function generateSelfSignedCert(input: { outDir: string; daysValid: number }): { certPath: string; keyPath: string } {
  const keyPath = path.join(input.outDir, "key.pem");
  const certPath = path.join(input.outDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(input.daysValid),
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { keyPath, certPath };
}

describe("TLS config", () => {
  it("zod schema rejects a relative certPath", () => {
    const result = CitadelConfigSchema.safeParse({
      dataDir: "/tmp/x",
      databasePath: "/tmp/x/db",
      tls: { certPath: "relative/cert.pem", keyPath: "/abs/key.pem" },
    });
    expect(result.success).toBe(false);
  });

  it("zod schema rejects a relative keyPath", () => {
    const result = CitadelConfigSchema.safeParse({
      dataDir: "/tmp/x",
      databasePath: "/tmp/x/db",
      tls: { certPath: "/abs/cert.pem", keyPath: "relative/key.pem" },
    });
    expect(result.success).toBe(false);
  });

  it("validateTlsAssets returns null when tls is unset (default config)", () => {
    expect(validateTlsAssets({ tls: undefined })).toBeNull();
  });

  it("validateTlsAssets reports missing cert file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
    dirs.push(dir);
    const result = validateTlsAssets({
      tls: { certPath: path.join(dir, "nope.pem"), keyPath: path.join(dir, "nope-key.pem") },
    });
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.reason).toMatch(/cert not found/);
  });

  it("validateTlsAssets reports an empty (0-byte) cert file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
    dirs.push(dir);
    const certPath = path.join(dir, "cert.pem");
    const keyPath = path.join(dir, "key.pem");
    fs.writeFileSync(certPath, "");
    fs.writeFileSync(keyPath, "key-contents\n");
    const result = validateTlsAssets({ tls: { certPath, keyPath } });
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.reason).toMatch(/empty/i);
  });

  it("validateTlsAssets accepts a valid, non-expired self-signed cert pair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
    dirs.push(dir);
    const { certPath, keyPath } = generateSelfSignedCert({ outDir: dir, daysValid: 30 });
    const result = validateTlsAssets({ tls: { certPath, keyPath } });
    expect(result?.ok).toBe(true);
  });

  it("validateTlsAssets reports an unparseable cert", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
    dirs.push(dir);
    const certPath = path.join(dir, "garbage-cert.pem");
    const keyPath = path.join(dir, "garbage-key.pem");
    fs.writeFileSync(certPath, "this is not a PEM file");
    fs.writeFileSync(keyPath, "this is not a key");
    const result = validateTlsAssets({ tls: { certPath, keyPath } });
    expect(result?.ok).toBe(false);
  });

  it("default fixture asserts tls === undefined on a fresh-config parse (regression guard)", () => {
    const parsed = CitadelConfigSchema.parse({ dataDir: "/tmp/x", databasePath: "/tmp/x/db" });
    expect(parsed.tls).toBeUndefined();
  });
});
