import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("agent template routes", () => {
  it("lists, updates, and resets predefined roles and actions", async () => {
    const fixture = createFixtureBase(dirs);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const listed = await getJson<{
        roles: Array<{ role: string; updatedAt: string; actions: Array<{ id: string; updatedAt: string }> }>;
      }>(`${baseUrl}/api/agent-templates`);
      expect(listed.roles.map((role) => role.role)).toEqual([
        "pm",
        "architect",
        "implementation",
        "prototype",
        "manager",
      ]);

      const pm = listed.roles.find((role) => role.role === "pm");
      const updatedRole = await putJson<{ role: { role: string; systemPrompt: string } }>(
        `${baseUrl}/api/agent-templates/roles/pm`,
        { systemPrompt: "custom pm prompt", updatedAt: pm?.updatedAt },
      );
      expect(updatedRole.role.systemPrompt).toBe("custom pm prompt");

      const review = listed.roles
        .flatMap((role) => role.actions)
        .find((action) => action.id === "implementation.review_pr");
      const updatedAction = await putJson<{ action: { id: string; prompt: string } }>(
        `${baseUrl}/api/agent-templates/actions/implementation.review_pr`,
        { prompt: "custom review prompt", updatedAt: review?.updatedAt },
      );
      expect(updatedAction.action.prompt).toBe("custom review prompt");

      const reset = await postJson<{ role: { role: string; systemPrompt: string } }>(
        `${baseUrl}/api/agent-templates/roles/pm/reset`,
        {},
      );
      expect(reset.role.systemPrompt).not.toBe("custom pm prompt");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects raw authority tokens in role system prompts without echoing them", async () => {
    const fixture = createFixtureBase(dirs);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const listed = await getJson<{ roles: Array<{ role: string; updatedAt: string }> }>(
        `${baseUrl}/api/agent-templates`,
      );
      const pm = listed.roles.find((role) => role.role === "pm");
      const rawToken = "citadel_agent_authority_abcdefghijklmnopqrstuvwxyz0123456789";
      const response = await fetch(`${baseUrl}/api/agent-templates/roles/pm`, {
        method: "PUT",
        body: JSON.stringify({ systemPrompt: `custom ${rawToken}`, updatedAt: pm?.updatedAt }),
        headers: { "content-type": "application/json" },
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(text).not.toContain(rawToken);
      expect(JSON.parse(text)).toMatchObject({
        error: "raw_authority_token_present",
        component: "roleTemplate.systemPrompt",
      });
    } finally {
      await closeServer(server);
    }
  });
});

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}
