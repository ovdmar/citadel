import { describe, expect, it } from "vitest";
import { materializePlanDeliveryUnits, parsePlanDeliveryUnitsBlock } from "./plan-delivery-units.js";

const block = `\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "API",
      "checkoutName": "api",
      "branch": "feature/api",
      "childIssue": { "provider": "jira", "key": "CIT-2" },
      "dependencies": []
    },
    {
      "key": "web",
      "repoName": "API",
      "checkoutName": "web",
      "branch": "feature/web",
      "childIssue": { "provider": "jira", "key": "CIT-3" },
      "dependencies": [{ "fromUnitKey": "api", "type": "stacked_on_pr" }]
    }
  ]
}
\`\`\``;

describe("plan delivery unit parser", () => {
  it("parses and materializes the delivery-unit block", () => {
    const parsed = parsePlanDeliveryUnitsBlock(`# Plan\n\n${block}`);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) throw new Error("expected parser success");

    const materialized = materializePlanDeliveryUnits(parsed.block, {
      workspaceId: "ws_1",
      planVersionId: "plan_1",
      timestamp: "2026-06-01T00:00:00.000Z",
    });

    expect(materialized.deliveryUnits).toMatchObject([
      { key: "api", workspaceId: "ws_1", planVersionId: "plan_1", dependencies: [] },
      { key: "web", dependencies: [{ fromUnitKey: "api", type: "stacked_on_pr" }] },
    ]);
    expect(materialized.dependencyEdges).toMatchObject([{ fromUnitKey: "api", toUnitKey: "web" }]);
  });

  it("requires exactly one delivery-unit block", () => {
    expect(parsePlanDeliveryUnitsBlock("# Plan").ok).toBe(false);
    const duplicate = parsePlanDeliveryUnitsBlock(`${block}\n\n${block}`);
    expect(duplicate).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "multiple_delivery_units_blocks" })],
    });
  });

  it("reports JSON and schema validation failures", () => {
    const json = parsePlanDeliveryUnitsBlock("```json citadel.delivery_units.v1\n{nope}\n```");
    expect(json).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "delivery_units_json_invalid" })],
    });

    const schema = parsePlanDeliveryUnitsBlock(`\`\`\`json citadel.delivery_units.v1
{ "deliveryUnits": [{ "key": "api", "checkoutName": "../api", "branch": "bad branch" }] }
\`\`\``);
    expect(schema).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: "delivery_units_schema_invalid" })]),
    });
  });

  it("rejects direct and multi-node dependency cycles", () => {
    const direct = parsePlanDeliveryUnitsBlock(`\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "API",
      "checkoutName": "api",
      "branch": "feature/api",
      "dependencies": [{ "fromUnitKey": "api" }]
    }
  ]
}
\`\`\``);
    expect(direct).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "delivery_units_schema_invalid" })],
    });

    const cycle = parsePlanDeliveryUnitsBlock(`\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "API",
      "checkoutName": "api",
      "branch": "feature/api",
      "dependencies": [{ "fromUnitKey": "web" }]
    },
    {
      "key": "web",
      "repoName": "API",
      "checkoutName": "web",
      "branch": "feature/web",
      "dependencies": [{ "fromUnitKey": "api" }]
    }
  ]
}
\`\`\``);
    expect(cycle).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "delivery_units_dependency_cycle" })],
    });
  });
});
