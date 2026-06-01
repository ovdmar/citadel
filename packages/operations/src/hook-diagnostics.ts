import type { CitadelConfig, HookConfig } from "@citadel/config";
import type { Repo, Workspace } from "@citadel/contracts";
import { listHookDiagnostics } from "./helpers.js";

type HookDiagnosticsConfig = {
  hooks: HookConfig[];
  repoDefaults: {
    appHookIds?: string[];
    actionHookIds?: string[];
  };
  commandPolicy: CitadelConfig["commandPolicy"];
};

export function hookDiagnostics(input: {
  config: HookDiagnosticsConfig | undefined;
  repo: Repo;
  workspace: Workspace | null | undefined;
}) {
  const { config, repo, workspace } = input;
  return listHookDiagnostics({
    repo,
    workspace,
    hooks: config?.hooks ?? [],
    appHookIds: config?.repoDefaults.appHookIds ?? [],
    actionHookIds: config?.repoDefaults.actionHookIds ?? [],
    hookTimeoutMs: config?.commandPolicy.hookTimeoutMs ?? 120000,
  });
}
