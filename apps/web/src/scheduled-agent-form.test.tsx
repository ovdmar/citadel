// @vitest-environment happy-dom
import type { AgentRuntime, Repo, Workspace } from "@citadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "./components/ui/test-utils.js";
import { ScheduledAgentForm } from "./scheduled-agent-form.js";

// First test coverage for ScheduledAgentForm — added together with the
// FormField migration of the Name field. The form has many other fields
// still on bespoke `<label>` wrappers (tracked via TODO comments) — this
// suite locks in the FormField contract for the migrated field so a
// future full migration doesn't silently break label-association or
// required semantics.

const repos: Repo[] = [{ id: "repo-1", name: "demo-repo" } as unknown as Repo];
const runtimes: AgentRuntime[] = [{ id: "claude", displayName: "Claude" } as unknown as AgentRuntime];
const workspaces: Workspace[] = [];

let cleanup: (() => void) | null = null;

beforeEach(() => {
  vi.spyOn(window, "fetch").mockResolvedValue(
    new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } }),
  );
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

function mountForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <ScheduledAgentForm mode="create" repos={repos} runtimes={runtimes} workspaces={workspaces} />
    </QueryClientProvider>,
  );
  cleanup = result.unmount;
  return result;
}

describe("ScheduledAgentForm — migrated Name field", () => {
  it("associates the Name label with the underlying input (FormField wiring)", () => {
    const { container } = mountForm();
    // FormField + Input renders a <label> with htmlFor → an <input> with the
    // matching id. Verify the connection so the future full migration of
    // other fields can rely on the same contract.
    const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.includes("Name"));
    expect(label).toBeDefined();
    const forId = label?.getAttribute("for");
    expect(forId).toBeTruthy();
    const input = container.querySelector(`input#${CSS.escape(forId as string)}`);
    expect(input).not.toBeNull();
  });

  it("renders the required marker for the Name field", () => {
    const { container } = mountForm();
    // FormField renders a `*` inside `[data-slot="form-required"]` when
    // `required` is true. The marker lives next to the label text.
    const marker = container.querySelector('[data-slot="form-required"]');
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain("*");
  });

  it("propagates required onto the underlying control so HTML form validation kicks in", () => {
    const { container } = mountForm();
    const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent?.includes("Name"));
    const forId = label?.getAttribute("for") ?? "";
    const input = container.querySelector(`input#${CSS.escape(forId)}`) as HTMLInputElement | null;
    expect(input?.required).toBe(true);
  });
});
