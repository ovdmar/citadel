import type { Operation } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { operationHighlightStatus } from "./operations-helpers.js";

const op = (id: string): Operation => ({
  id,
  type: "workspace.deploy.redeploy",
  status: "running",
  repoId: null,
  workspaceId: null,
  progress: 10,
  message: "",
  error: null,
  logs: [],
  retriable: false,
  retryInput: null,
  createdAt: "2026-05-26T00:00:00.000Z",
  updatedAt: "2026-05-26T00:00:00.000Z",
});

describe("operationHighlightStatus", () => {
  it("returns 'none' when no id is supplied", () => {
    expect(operationHighlightStatus([op("a")], undefined)).toBe("none");
  });

  it("returns 'found' when the id matches a row", () => {
    expect(operationHighlightStatus([op("a"), op("b")], "b")).toBe("found");
  });

  it("returns 'missing' when the id is present in the query but not in the list (e.g., purged)", () => {
    expect(operationHighlightStatus([op("a")], "ghost")).toBe("missing");
  });
});
