import { describe, expect, it } from "vitest";
import { __testing__ } from "./add-repo-modal.js";

const { pathCompletionSelection } = __testing__;

describe("add repo path completion", () => {
  it("selects git repositories instead of drilling into them", () => {
    expect(pathCompletionSelection({ path: "/home/me/project", isGit: true })).toEqual({
      value: "/home/me/project",
      keepOpen: false,
    });
  });

  it("keeps navigating through ordinary directories", () => {
    expect(pathCompletionSelection({ path: "/home/me/projects", isGit: false })).toEqual({
      value: "/home/me/projects/",
      keepOpen: true,
    });
  });
});
