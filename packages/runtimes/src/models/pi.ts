import type { RuntimeModelListerResult } from "./index.js";

// pi runtime doesn't advertise model selection; ship a single default.
export async function fetchPiModels(_input: {
  command: string;
  args?: string[];
}): Promise<RuntimeModelListerResult> {
  return { models: [{ id: "default", isDefault: true }] };
}
