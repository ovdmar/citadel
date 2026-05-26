import { describe, expect, it, vi } from "vitest";
import { consumeNewWorkspaceDeeplink, shouldOpenNewWorkspaceModal } from "./new-workspace-deeplink.js";

describe("shouldOpenNewWorkspaceModal", () => {
  it("true for ?modal=new-workspace", () => {
    expect(shouldOpenNewWorkspaceModal("?modal=new-workspace")).toBe(true);
  });

  it("false for an empty search string", () => {
    expect(shouldOpenNewWorkspaceModal("")).toBe(false);
  });

  it("false for any other modal value", () => {
    expect(shouldOpenNewWorkspaceModal("?modal=add-repo")).toBe(false);
    expect(shouldOpenNewWorkspaceModal("?modal=")).toBe(false);
  });

  it("false when the param is missing entirely", () => {
    expect(shouldOpenNewWorkspaceModal("?source=mobile&workspace=ws_1")).toBe(false);
  });

  it("true when the param is one of several", () => {
    expect(shouldOpenNewWorkspaceModal("?source=satellite&modal=new-workspace")).toBe(true);
  });
});

describe("consumeNewWorkspaceDeeplink", () => {
  it("strips only the modal param via replaceState, preserving other params", () => {
    const history = { replaceState: vi.fn() };
    consumeNewWorkspaceDeeplink({
      pathname: "/",
      search: "?source=satellite&modal=new-workspace",
      hash: "",
      history,
    });
    expect(history.replaceState).toHaveBeenCalledTimes(1);
    const [, , url] = history.replaceState.mock.calls[0] ?? [];
    expect(url).toBe("/?source=satellite");
  });

  it("strips the search entirely when modal was the only param", () => {
    const history = { replaceState: vi.fn() };
    consumeNewWorkspaceDeeplink({
      pathname: "/",
      search: "?modal=new-workspace",
      hash: "",
      history,
    });
    const [, , url] = history.replaceState.mock.calls[0] ?? [];
    expect(url).toBe("/");
  });

  it("preserves the hash fragment when stripping the modal param", () => {
    const history = { replaceState: vi.fn() };
    consumeNewWorkspaceDeeplink({
      pathname: "/dashboard",
      search: "?modal=new-workspace",
      hash: "#x",
      history,
    });
    const [, , url] = history.replaceState.mock.calls[0] ?? [];
    expect(url).toBe("/dashboard#x");
  });

  it("does nothing when the param isn't present", () => {
    const history = { replaceState: vi.fn() };
    consumeNewWorkspaceDeeplink({
      pathname: "/",
      search: "?other=1",
      hash: "",
      history,
    });
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
