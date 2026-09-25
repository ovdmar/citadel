import type { Namespace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { namespaceIdsAfterMove } from "./namespace-order.js";

const ts = "2026-01-01T00:00:00.000Z";

function namespace(id: string, position: number): Namespace {
  return { id, name: id, color: null, position, createdAt: ts, updatedAt: ts, archivedAt: null };
}

describe("namespaceIdsAfterMove", () => {
  const namespaces = [namespace("a", 1), namespace("b", 2), namespace("c", 3)];

  it("moves downward after the target", () => {
    expect(namespaceIdsAfterMove(namespaces, "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("moves upward before the target", () => {
    expect(namespaceIdsAfterMove(namespaces, "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("ignores self and unknown drops", () => {
    expect(namespaceIdsAfterMove(namespaces, "b", "b")).toBeNull();
    expect(namespaceIdsAfterMove(namespaces, "x", "b")).toBeNull();
  });
});
