import type { AgentRuntime, GitHubQuotaSummary, RuntimeUsageSummary } from "@citadel/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleOff, Github, RefreshCw } from "lucide-react";
import { api } from "./api.js";
import { categoryKey, formatLocalReset, formatTimeUntilReset, pickTopBarCategory } from "./lib/usage-format.js";
import { RuntimeMark } from "./runtime-mark.js";

export function usagePillNeedsReload(summary: RuntimeUsageSummary | undefined): boolean {
  if (!summary) return true;
  if (summary.status !== "healthy") return true;
  if (summary.categories.length === 0) return true;
  return false;
}

type RuntimeConfigEntry = {
  id: string;
  showUsageInTopBar?: boolean;
  topBarCategoryKey?: string;
};

type ConfigResponse = { config: { runtimes: RuntimeConfigEntry[] } };

// Low-contrast usage pill rendered in the cockpit top bar, left of the
// Settings icon. One pill per runtime where:
//   - capabilities.supportsUsage      (only runtimes with a fetcher)
//   - showUsageInTopBar               (operator opted in from Settings)
// Unhealthy runtimes stay visible so the usage route can surface why no usage
// can be fetched (for example Claude Code subscription/auth failures).
// Click navigates to /settings so the user can drill into the full breakdown.
export function UsageIndicator(props: { runtimes: AgentRuntime[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const configRuntimes = configQuery.data?.config.runtimes ?? [];
  const githubQuota = useQuery({
    queryKey: ["github-quota"],
    queryFn: () => api<{ quota: GitHubQuotaSummary }>("/api/integrations/github/quota"),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  const enabled = selectTopBarUsageRuntimes(props.runtimes, configRuntimes);

  const usageQueries = useQueries({
    queries: enabled.map(({ runtime }) => ({
      queryKey: ["runtime-usage", runtime.id],
      queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${runtime.id}/usage`),
      // Daemon caches for 5 min; mirror that here so cockpit re-renders don't
      // hammer the endpoint while the user moves around.
      staleTime: 5 * 60_000,
    })),
  });

  if (enabled.length === 0 && !githubQuota.data?.quota) return null;
  return (
    <div className="cit-usage-indicator">
      <GitHubQuotaPill quota={githubQuota.data?.quota} />
      {enabled.map(({ runtime, topBarKey }, index) => (
        <UsagePill key={runtime.id} runtime={runtime} topBarKey={topBarKey} usage={usageQueries[index]?.data?.usage} />
      ))}
    </div>
  );
}

export type TopBarUsageRuntime = { runtime: AgentRuntime; topBarKey: string | undefined };

export function selectTopBarUsageRuntimes(
  runtimes: AgentRuntime[],
  configRuntimes: RuntimeConfigEntry[],
): TopBarUsageRuntime[] {
  return runtimes
    .map((runtime) => {
      if (!runtime.capabilities.supportsUsage) return null;
      const entry = configRuntimes.find((candidate) => candidate.id === runtime.id);
      if (entry?.showUsageInTopBar !== true) return null;
      return { runtime, topBarKey: entry.topBarCategoryKey };
    })
    .filter((entry): entry is TopBarUsageRuntime => entry !== null);
}

function GitHubQuotaPill(props: { quota: GitHubQuotaSummary | undefined }) {
  const quota = props.quota;
  const resource = pickGitHubQuotaResource(quota);
  const cooldownLeft = quota?.cooldownUntil ? formatTimeUntilReset(quota.cooldownUntil) : null;
  const resetLeft = resource?.resetAt ? formatTimeUntilReset(resource.resetAt) : null;
  const tooltip = buildGitHubTooltip(quota, resource);
  const value = !quota
    ? "..."
    : !quota.automationEnabled
      ? "off"
      : cooldownLeft
        ? resource
          ? `${resource.percentUsed}% · ${resetLeft ?? cooldownLeft}`
          : cooldownLeft
        : resource
          ? `${resource.percentUsed}%${resetLeft ? ` · ${resetLeft}` : ""}`
          : "--";
  return (
    <Link
      to="/settings"
      className={`cit-usage-pill ${quota?.cooldownUntil ? "is-warn" : ""}`}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className="cit-usage-pill-mark" aria-hidden>
        <Github size={14} />
      </span>
      <span className="cit-usage-pill-value">{value}</span>
    </Link>
  );
}

function UsagePill(props: {
  runtime: AgentRuntime;
  topBarKey: string | undefined;
  usage: RuntimeUsageSummary | undefined;
}) {
  const summary = props.usage;
  const state = resolveUsagePillState(props.runtime, summary, props.topBarKey);
  const queryClient = useQueryClient();
  const refreshMutation = useMutation({
    mutationFn: () => api(`/api/runtimes/${props.runtime.id}/usage/refresh`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runtime-usage", props.runtime.id] }),
  });
  // Reload affordance for missing / errored / empty usage data. Pill keeps
  // the same chrome (min-width on .cit-usage-pill) so swapping percentage ↔
  // refresh icon doesn't shift neighboring controls.
  if (usagePillNeedsReload(summary)) {
    const tooltip = summary?.reason
      ? `${props.runtime.displayName}: ${summary.reason} — click to retry`
      : `${state.tooltip} — click to retry`;
    return (
      <button
        type="button"
        className={`${usagePillClassName(state.tone)} cit-usage-pill--reload`}
        title={tooltip}
        aria-label={tooltip}
        disabled={refreshMutation.isPending}
        onClick={() => refreshMutation.mutate()}
      >
        <span className="cit-usage-pill-mark" aria-hidden>
          {state.tone === "unavailable" ? (
            <CircleOff size={14} />
          ) : (
            <RuntimeMark runtimeId={props.runtime.id} size={14} />
          )}
        </span>
        <span className="cit-usage-pill-value">
          <RefreshCw size={12} aria-hidden />
        </span>
      </button>
    );
  }
  return (
    <Link to="/settings" className={usagePillClassName(state.tone)} title={state.tooltip} aria-label={state.tooltip}>
      <span className="cit-usage-pill-mark" aria-hidden>
        {state.tone === "unavailable" ? (
          <CircleOff size={14} />
        ) : (
          <RuntimeMark runtimeId={props.runtime.id} size={14} />
        )}
      </span>
      <span className="cit-usage-pill-value">
        {state.category ? (
          <>
            <span className="cit-usage-pill-pct">{state.category.percentUsed}%</span>
            {state.timeLeft ? (
              <>
                <span className="cit-usage-pill-sep" aria-hidden>
                  ·
                </span>
                <span className="cit-usage-pill-time">{state.timeLeft}</span>
              </>
            ) : null}
          </>
        ) : (
          state.value
        )}
      </span>
    </Link>
  );
}

type UsagePillTone = RuntimeUsageSummary["status"] | "loading";
type SelectedUsageCategory = ReturnType<typeof pickTopBarCategory>;

export type UsagePillState = {
  tone: UsagePillTone;
  value: string;
  tooltip: string;
  category: SelectedUsageCategory;
  timeLeft: string | null;
};

export function resolveUsagePillState(
  runtime: AgentRuntime,
  summary: RuntimeUsageSummary | undefined,
  topBarKey: string | undefined,
): UsagePillState {
  const tone: UsagePillTone = summary?.status ?? (runtime.health !== "healthy" ? runtime.health : "loading");
  const category = summary?.status === "healthy" ? pickTopBarCategory(summary.categories, topBarKey) : null;
  const timeLeft = category ? formatTimeUntilReset(category.reset) : null;
  return {
    tone,
    value: usagePillFallbackValue(tone),
    tooltip: buildTooltip(runtime.displayName, summary, category, runtime),
    category,
    timeLeft,
  };
}

function usagePillClassName(tone: UsagePillTone): string {
  const modifier = tone === "unavailable" ? "is-bad" : tone === "degraded" || tone === "unknown" ? "is-warn" : "";
  return modifier ? `cit-usage-pill ${modifier}` : "cit-usage-pill";
}

function usagePillFallbackValue(tone: UsagePillTone): string {
  if (tone === "loading") return "...";
  if (tone === "unavailable") return "off";
  return "--";
}

function buildTooltip(
  displayName: string,
  summary: RuntimeUsageSummary | undefined,
  selected: { label: string; section: string | null } | null,
  runtime?: AgentRuntime,
): string {
  if (!summary && runtime && runtime.health !== "healthy") {
    return `${displayName}: ${runtime.healthReason ?? `runtime is ${runtime.health}`}`;
  }
  if (!summary) return `${displayName} — loading usage…`;
  // Mirror the reload-pill predicate so the tooltip and the button stay in
  // lockstep — a future change to one (e.g. treating "degraded" differently)
  // can't silently desync them.
  if (usagePillNeedsReload(summary)) {
    return `${displayName}: ${summary.reason ?? "no usage data"}`;
  }
  const selectedKey = selected ? categoryKey(selected) : null;
  const lines = summary.categories.map((category) => {
    const sectionPrefix = category.section ? `[${category.section}] ` : "";
    const localReset = formatLocalReset(category.reset);
    const resetSuffix = localReset ? ` · resets ${localReset}` : "";
    const marker = categoryKey(category) === selectedKey ? "★ " : "  ";
    return `${marker}${sectionPrefix}${category.label}: ${category.percentUsed}% used${resetSuffix}`;
  });
  return `${displayName}\n${lines.join("\n")}`;
}

function pickGitHubQuotaResource(summary: GitHubQuotaSummary | undefined) {
  return (
    summary?.resources.reduce<GitHubQuotaSummary["resources"][number] | null>(
      (best, resource) => (!best || resource.percentUsed > best.percentUsed ? resource : best),
      null,
    ) ?? null
  );
}

function buildGitHubTooltip(
  summary: GitHubQuotaSummary | undefined,
  selected: GitHubQuotaSummary["resources"][number] | null,
): string {
  if (!summary) return "GitHub quota loading";
  if (!summary.automationEnabled) return summary.reason ?? "GitHub automation disabled";
  if (summary.resources.length === 0) return summary.reason ?? "No GitHub quota data";
  const selectedName = selected?.name;
  const lines = summary.resources.map((resource) => {
    const marker = resource.name === selectedName ? "* " : "  ";
    const reset = resource.resetAt ? ` · resets ${formatLocalReset(resource.resetAt) ?? "later"}` : "";
    return `${marker}${resource.name}: ${resource.percentUsed}% used (${resource.remaining}/${resource.limit} left)${reset}`;
  });
  const header = summary.cooldownUntil
    ? `GitHub rate-limited; retry ${formatLocalReset(summary.cooldownUntil) ?? "later"}`
    : "GitHub quota";
  return `${header}\n${lines.join("\n")}`;
}
