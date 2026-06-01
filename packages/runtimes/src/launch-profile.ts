import type { LaunchSettings, RuntimeLaunchOptionCapabilities } from "@citadel/contracts";

type LaunchArgvMapping = { argv: string[] };
export type RuntimeLaunchOptionsInput = {
  models?: Array<{ id: string; label: string; default?: boolean; deprecated?: boolean }>;
  defaultModel?: string | null;
  effortValues?: string[];
  supportsFastMode?: boolean;
  contextModes?: string[];
  modelArgv?: LaunchArgvMapping | undefined;
  effortArgv?: LaunchArgvMapping | undefined;
  fastArgv?: LaunchArgvMapping | undefined;
  contextArgv?: LaunchArgvMapping | undefined;
};

export type RuntimeWithLaunchOptions = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  promptArg?: string | undefined;
  sessionIdArg?: string | undefined;
  resumeArg?: string | undefined;
  launchOptions?: RuntimeLaunchOptionsInput | undefined;
};

export type ResolvedLaunchProfile = {
  runtime: RuntimeWithLaunchOptions;
  args: string[];
  capabilities: RuntimeLaunchOptionCapabilities;
  launchWarnings: string[];
  resolvedSettings: LaunchSettings;
};

export function runtimeLaunchOptionCapabilities(
  runtime: Pick<RuntimeWithLaunchOptions, "id" | "launchOptions">,
  options: { now?: () => string } = {},
): RuntimeLaunchOptionCapabilities {
  const launchOptions = runtime.launchOptions;
  const models = (launchOptions?.models ?? []).map((model) => ({
    id: model.id,
    label: model.label,
    default: model.default ?? false,
    deprecated: model.deprecated ?? false,
  }));
  const configuredDefault =
    launchOptions?.defaultModel ??
    models.find((model) => model.default && !model.deprecated)?.id ??
    models.find((model) => !model.deprecated)?.id ??
    null;
  return {
    runtimeId: runtime.id,
    models,
    defaultModel: configuredDefault,
    effortValues: launchOptions?.effortValues ?? [],
    supportsFastMode: launchOptions?.supportsFastMode ?? false,
    contextModes: launchOptions?.contextModes ?? [],
    checkedAt: options.now?.() ?? new Date().toISOString(),
    stale: false,
    reason: launchOptions ? null : "static_fallback",
  };
}

export function resolveRuntimeLaunchProfile(input: {
  runtime: RuntimeWithLaunchOptions;
  settings?: LaunchSettings | null | undefined;
  now?: (() => string) | undefined;
}): ResolvedLaunchProfile {
  const runtime = input.runtime;
  const settings = normalizeSettings(runtime.id, input.settings);
  const capabilities = runtimeLaunchOptionCapabilities(runtime, input.now ? { now: input.now } : {});
  const launchOptions = runtime.launchOptions;
  const args = [...runtime.args];
  const launchWarnings: string[] = [];

  const model = resolveModel(settings.model, capabilities, launchWarnings);
  if (model) appendMappedArg(args, launchOptions?.modelArgv, model, "model", launchWarnings);

  if (settings.effort) {
    const effort = resolveEnumOption("effort", settings.effort, capabilities.effortValues, launchWarnings);
    if (effort) appendMappedArg(args, launchOptions?.effortArgv, effort, "effort", launchWarnings);
  }

  if (settings.fastMode === true) {
    if (capabilities.supportsFastMode)
      appendMappedArg(args, launchOptions?.fastArgv, null, "fast mode", launchWarnings);
    else launchWarnings.push(`Runtime ${runtime.id} does not support fast mode; dropping fastMode`);
  }

  if (settings.contextMode) {
    const contextMode = resolveEnumOption(
      "context mode",
      settings.contextMode,
      capabilities.contextModes,
      launchWarnings,
    );
    if (contextMode) appendMappedArg(args, launchOptions?.contextArgv, contextMode, "context mode", launchWarnings);
  }

  return {
    runtime,
    args,
    capabilities,
    launchWarnings,
    resolvedSettings: {
      runtimeId: runtime.id,
      model,
      effort: resolveNullable(settings.effort, capabilities.effortValues),
      fastMode: capabilities.supportsFastMode ? settings.fastMode : null,
      contextMode: resolveNullable(settings.contextMode, capabilities.contextModes),
    },
  };
}

function normalizeSettings(runtimeId: string, settings: LaunchSettings | null | undefined): LaunchSettings {
  return {
    runtimeId,
    model: settings?.model ?? null,
    effort: settings?.effort ?? null,
    fastMode: settings?.fastMode ?? null,
    contextMode: settings?.contextMode ?? null,
  };
}

function resolveModel(
  requested: string | null,
  capabilities: RuntimeLaunchOptionCapabilities,
  warnings: string[],
): string | null {
  if (!requested) return null;
  const models = capabilities.models;
  if (!models.length) return requested;
  const match = models.find((model) => model.id === requested);
  if (match && !match.deprecated) return requested;
  const fallback = capabilities.defaultModel;
  warnings.push(
    `Runtime ${capabilities.runtimeId} model ${requested} is unavailable; ${
      fallback ? `using ${fallback}` : "dropping model selection"
    }`,
  );
  return fallback;
}

function resolveEnumOption(label: string, requested: string, supported: string[], warnings: string[]): string | null {
  if (!supported.length || supported.includes(requested)) return requested;
  warnings.push(`${label} ${requested} is not supported; dropping ${label}`);
  return null;
}

function resolveNullable(value: string | null, supported: string[]) {
  if (!value) return null;
  return !supported.length || supported.includes(value) ? value : null;
}

function appendMappedArg(
  args: string[],
  mapping: LaunchArgvMapping | undefined,
  value: string | null,
  label: string,
  warnings: string[],
) {
  if (!mapping) {
    warnings.push(`Runtime launch profile has no argv mapping for ${label}; dropping ${label}`);
    return;
  }
  for (const token of mapping.argv) {
    args.push(value === null ? token : token.replaceAll("{value}", value));
  }
}
