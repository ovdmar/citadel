import type {
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDeliveryUnitsBlock,
  WorkspacePlanDependencyEdge,
} from "@citadel/contracts";
import { WorkspacePlanDeliveryUnitsBlockSchema } from "@citadel/contracts";
import { createId } from "@citadel/core";

export const DELIVERY_UNITS_BLOCK_LANGUAGE = "citadel.delivery_units.v1";

export type PlanDeliveryUnitsValidationIssue = {
  code: string;
  message: string;
  path: string;
};

export type PlanDeliveryUnitsParseResult =
  | { ok: true; block: WorkspacePlanDeliveryUnitsBlock }
  | { ok: false; issues: PlanDeliveryUnitsValidationIssue[] };

export type MaterializedPlanDeliveryUnits = {
  deliveryUnits: WorkspacePlanDeliveryUnit[];
  dependencyEdges: WorkspacePlanDependencyEdge[];
};

type FenceBlock = {
  info: string;
  body: string;
};

export function parsePlanDeliveryUnitsBlock(content: string): PlanDeliveryUnitsParseResult {
  const blocks = extractFenceBlocks(content).filter((block) => {
    const tokens = block.info.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.includes(DELIVERY_UNITS_BLOCK_LANGUAGE);
  });
  if (blocks.length === 0) {
    return { ok: false, issues: [issue("plan_delivery_units_required", "Missing delivery units block", "")] };
  }
  if (blocks.length > 1) {
    return { ok: false, issues: [issue("multiple_delivery_units_blocks", "Multiple delivery units blocks found", "")] };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(blocks[0]?.body ?? "");
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue(
          "delivery_units_json_invalid",
          error instanceof Error ? error.message : "Delivery units block is not valid JSON",
          "",
        ),
      ],
    };
  }

  const parsed = WorkspacePlanDeliveryUnitsBlockSchema.safeParse(decoded);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((entry) =>
        issue("delivery_units_schema_invalid", entry.message, entry.path.join(".")),
      ),
    };
  }

  const cycle = findDependencyCycle(parsed.data);
  if (cycle) {
    return {
      ok: false,
      issues: [issue("delivery_units_dependency_cycle", `Dependency cycle: ${cycle.join(" -> ")}`, "deliveryUnits")],
    };
  }

  return { ok: true, block: parsed.data };
}

export function materializePlanDeliveryUnits(
  block: WorkspacePlanDeliveryUnitsBlock,
  input: { workspaceId: string; planVersionId: string; timestamp: string },
): MaterializedPlanDeliveryUnits {
  const dependencyEdges = block.deliveryUnits.flatMap((unit) =>
    unit.dependencies.map((dependency) => ({
      id: createId("edge"),
      workspaceId: input.workspaceId,
      planVersionId: input.planVersionId,
      fromUnitKey: dependency.fromUnitKey,
      toUnitKey: unit.key,
      type: dependency.type,
      reason: dependency.reason ?? null,
      createdAt: input.timestamp,
    })),
  );
  const deliveryUnits = block.deliveryUnits.map((unit) => ({
    ...unit,
    id: createId("unit"),
    workspaceId: input.workspaceId,
    planVersionId: input.planVersionId,
    repoId: unit.repoId ?? null,
    repoName: unit.repoName ?? null,
    providerRepoUrl: unit.providerRepoUrl ?? null,
    baseBranch: unit.baseBranch ?? null,
    childIssue: unit.childIssue ?? null,
    dependencies: dependencyEdges.filter((edge) => edge.toUnitKey === unit.key).map(dependencyForUnit),
    status: unit.status ?? "pending",
    createdAt: input.timestamp,
    updatedAt: input.timestamp,
  }));
  return { deliveryUnits, dependencyEdges };
}

function extractFenceBlocks(content: string): FenceBlock[] {
  const blocks: FenceBlock[] = [];
  const fence = /^```([^\r\n]*)\r?\n([\s\S]*?)\r?\n```\s*$/gm;
  for (const match of content.matchAll(fence)) {
    blocks.push({ info: match[1] ?? "", body: match[2] ?? "" });
  }
  return blocks;
}

function findDependencyCycle(block: WorkspacePlanDeliveryUnitsBlock): string[] | null {
  const graph = new Map<string, string[]>();
  for (const unit of block.deliveryUnits) graph.set(unit.key, []);
  for (const unit of block.deliveryUnits) {
    for (const dependency of unit.dependencies) {
      graph.get(dependency.fromUnitKey)?.push(unit.key);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (key: string): string[] | null => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      return [...stack.slice(start), key];
    }
    if (visited.has(key)) return null;
    visiting.add(key);
    stack.push(key);
    for (const next of graph.get(key) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(key);
    visited.add(key);
    return null;
  };

  for (const key of graph.keys()) {
    const cycle = visit(key);
    if (cycle) return cycle;
  }
  return null;
}

function dependencyForUnit(edge: WorkspacePlanDependencyEdge): Omit<WorkspacePlanDependencyEdge, "toUnitKey"> {
  return {
    id: edge.id,
    workspaceId: edge.workspaceId,
    planVersionId: edge.planVersionId,
    fromUnitKey: edge.fromUnitKey,
    type: edge.type,
    reason: edge.reason,
    createdAt: edge.createdAt,
  };
}

function issue(code: string, message: string, path: string): PlanDeliveryUnitsValidationIssue {
  return { code, message, path };
}
