import { describe, expect, it } from "vitest";
import { deployedAppsQueryKey, deployedAppsUrl, redeployPayload, undeployPayload } from "./deployed-apps-target.js";

describe("deployed apps target helpers", () => {
  it("keeps workspace Home deploy calls workspace-scoped", () => {
    expect(deployedAppsQueryKey("ws_1", null)).toEqual(["deployed-apps", "ws_1", "home"]);
    expect(deployedAppsUrl("ws_1", null)).toBe("/api/workspaces/ws_1/deployed-apps");
    expect(redeployPayload(undefined, null)).toEqual({});
    expect(undeployPayload(undefined, null)).toEqual({});
  });

  it("threads checkoutId through list and deploy action calls", () => {
    expect(deployedAppsQueryKey("ws_1", "co_api")).toEqual(["deployed-apps", "ws_1", "co_api"]);
    expect(deployedAppsUrl("ws_1", "co_api")).toBe("/api/workspaces/ws_1/deployed-apps?checkoutId=co_api");
    expect(redeployPayload("web", "co_api")).toEqual({ name: "web", checkoutId: "co_api" });
    expect(undeployPayload("web", "co_api")).toEqual({ name: "web", checkoutId: "co_api" });
  });
});
