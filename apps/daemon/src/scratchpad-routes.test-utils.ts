// Shared HTTP-test fixtures for scratchpad route tests. Lives in a non-`.test.ts`
// file so vitest doesn't try to execute it directly. Two test files consume it
// (the original routes tests + the block-route tests) so each stays under the
// 800-LOC source-file cap.
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { expect } from "vitest";

type SseEvent = { type: string; payload: { updatedAt?: string } };

export type ScratchpadTestFixture = ReturnType<typeof buildFixture>;

function buildFixture(dir: string) {
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store };
}

export function createScratchpadFixture(dirs: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scratchpad-routes-"));
  dirs.push(dir);
  return buildFixture(dir);
}

export function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

export function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}

export async function openSseListener(baseUrl: string, eventName: string) {
  const response = await fetch(`${baseUrl}/events`, { headers: { Accept: "text/event-stream" } });
  if (!response.ok || !response.body) throw new Error("sse_open_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let closed = false;
  let pendingType: string | null = null;
  const consume = async () => {
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newlineIdx = buffer.indexOf("\n");
        if (newlineIdx < 0) break;
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.startsWith("event: ")) pendingType = line.slice("event: ".length);
        else if (line.startsWith("data: ") && pendingType === eventName) {
          try {
            const parsed = JSON.parse(line.slice("data: ".length)) as SseEvent;
            events.push({ type: pendingType, payload: parsed.payload ?? {} });
          } catch {
            /* ignore malformed */
          }
        }
        if (line === "") pendingType = null;
      }
    }
  };
  consume().catch(() => {
    /* stream closed */
  });
  return {
    async waitFor(count: number, timeoutMs: number) {
      const start = Date.now();
      while (events.length < count) {
        if (Date.now() - start > timeoutMs) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return events.slice();
    },
    close() {
      closed = true;
      reader.cancel().catch(() => {
        /* already closed */
      });
    },
  };
}

export function openHistorySseListener(baseUrl: string) {
  return openSseListener(baseUrl, "scratchpad.history.updated");
}
