import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readCss(): string {
  return fs.readFileSync(path.join(HERE, "cockpit-extras.css"), "utf8");
}

function declarationBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "m"));
  if (!match?.[1]) throw new Error(`Missing CSS block for ${selector}`);
  return match[1];
}

function pxDeclaration(block: string, property: string): number {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`${escaped}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`));
  if (!match?.[1]) throw new Error(`Missing px declaration for ${property}`);
  return Number(match[1]);
}

describe("workspace-card control lane", () => {
  it("keeps PR diff totals clear of the structured workspace action buttons", () => {
    const css = readCss();
    const controlBlock = declarationBlock(css, ".workspace-card-right-control");
    const spacerBlock = declarationBlock(css, ".workspace-card-right-control-spacer");
    const buttonBlock = declarationBlock(css, ".workspace-card-collapse");

    const rightOffset = pxDeclaration(controlBlock, "right");
    const controlGap = pxDeclaration(controlBlock, "gap");
    const buttonWidth = pxDeclaration(buttonBlock, "width");
    const spacerWidth = pxDeclaration(spacerBlock, "width");

    const maxVisibleControls = 2;
    const requiredLaneWidth = rightOffset + buttonWidth * maxVisibleControls + controlGap * (maxVisibleControls - 1);

    expect(spacerWidth).toBeGreaterThanOrEqual(requiredLaneWidth);
  });
});
