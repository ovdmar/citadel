import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pin the `data-cit-on-dark` CSS contract so a future CSS reorganization
// can't silently drop the overrides that make the Jira chip (and the
// .workspace-card-issue chip) legible on deliberately-dark surfaces
// regardless of cockpit theme.
//
// We deliberately assert on the CSS source text (not computed styles via
// JSDOM, which has poor cascading support) AND on the React render code
// (the workspace card must actually set the attribute). Visual confirmation
// is the Playwright spec's job.

const HERE = path.dirname(fileURLToPath(import.meta.url));

function read(file: string): string {
  return fs.readFileSync(path.join(HERE, file), "utf8");
}

describe("data-cit-on-dark chip variant", () => {
  it("inspector-stats.css carries an on-dark variant for .cit-jira foreground", () => {
    const css = read("inspector-stats.css");
    expect(css).toMatch(/\[data-cit-on-dark="true"\]\s+\.cit-jira\b/);
    expect(css).toMatch(/\[data-cit-on-dark="true"\]\s+\.cit-jira-title\b/);
    expect(css).toMatch(/\[data-cit-on-dark="true"\]\s+\.cit-jira-key\b/);
  });

  it("inspector-stats.css carries an on-dark variant for each .cit-jira-status-- tone", () => {
    const css = read("inspector-stats.css");
    for (const tone of ["progress", "review", "done", "blocked"] as const) {
      expect(css, `missing on-dark override for --${tone}`).toMatch(
        new RegExp(`\\[data-cit-on-dark="true"\\]\\s+\\.cit-jira-status--${tone}\\b`),
      );
    }
  });

  it("cockpit-extras.css carries an on-dark variant for .workspace-card-issue (the active-card chip bug)", () => {
    const css = read("cockpit-extras.css");
    expect(css).toMatch(/\[data-cit-on-dark="true"\]\s+\.workspace-card-issue\b/);
  });

  it("workspace-card.tsx sets data-cit-on-dark on the active card (and only the active card)", () => {
    const tsx = read("workspace-card.tsx");
    // The attribute write is conditional on props.active, returning undefined
    // when not active so React omits the attribute entirely.
    expect(tsx).toMatch(/data-cit-on-dark=\{props\.active\s+\?\s+["']true["']\s+:\s+undefined\}/);
  });
});
