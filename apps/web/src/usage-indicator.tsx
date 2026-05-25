import type { AgentRuntime, RuntimeUsageSummary } from "@citadel/contracts";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
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
//   - health === "healthy"            (unhealthy runtimes have nothing to fetch)
//   - capabilities.supportsUsage      (only runtimes with a fetcher)
//   - showUsageInTopBar               (operator opted in from Settings)
// Click navigates to /settings so the user can drill into the full breakdown.
export function UsageIndicator(props: { runtimes: AgentRuntime[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const configRuntimes = configQuery.data?.config.runtimes ?? [];
  const enabled = props.runtimes
    .map((runtime) => {
      if (runtime.health !== "healthy") return null;
      if (!runtime.capabilities.supportsUsage) return null;
      const entry = configRuntimes.find((candidate) => candidate.id === runtime.id);
      if (entry?.showUsageInTopBar !== true) return null;
      return { runtime, topBarKey: entry.topBarCategoryKey };
    })
    .filter((entry): entry is { runtime: AgentRuntime; topBarKey: string | undefined } => entry !== null);

  const usageQueries = useQueries({
    queries: enabled.map(({ runtime }) => ({
      queryKey: ["runtime-usage", runtime.id],
      queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${runtime.id}/usage`),
      // Daemon caches for 5 min; mirror that here so cockpit re-renders don't
      // hammer the endpoint while the user moves around.
      staleTime: 5 * 60_000,
    })),
  });

  if (enabled.length === 0) return null;
  return (
    <div className="cit-usage-indicator">
      {enabled.map(({ runtime, topBarKey }, index) => (
        <UsagePill key={runtime.id} runtime={runtime} topBarKey={topBarKey} usage={usageQueries[index]?.data?.usage} />
      ))}
    </div>
  );
}

function UsagePill(props: {
  runtime: AgentRuntime;
  topBarKey: string | undefined;
  usage: RuntimeUsageSummary | undefined;
}) {
  const summary = props.usage;
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
      : `${props.runtime.displayName}: usage unavailable — click to retry`;
    return (
      <button
        type="button"
        className="cit-usage-pill cit-usage-pill--reload"
        title={tooltip}
        aria-label={tooltip}
        disabled={refreshMutation.isPending}
        onClick={() => refreshMutation.mutate()}
      >
        <span className="cit-usage-pill-mark" aria-hidden>
          <RuntimeMark runtimeId={props.runtime.id} size={14} />
        </span>
        <span className="cit-usage-pill-value">
          <RefreshCw size={12} aria-hidden />
        </span>
      </button>
    );
  }
  const category = pickTopBarCategory(summary?.categories ?? [], props.topBarKey);
  const timeLeft = category ? formatTimeUntilReset(category.reset) : null;
  const tooltip = buildTooltip(props.runtime.displayName, summary, category);
  return (
    <Link to="/settings" className="cit-usage-pill" title={tooltip} aria-label={tooltip}>
      <span className="cit-usage-pill-mark" aria-hidden>
        <RuntimeMark runtimeId={props.runtime.id} size={14} />
      </span>
      <span className="cit-usage-pill-value">
        {category ? (
          <>
            <span className="cit-usage-pill-pct">{category.percentUsed}%</span>
            {timeLeft ? (
              <>
                <span className="cit-usage-pill-sep" aria-hidden>
                  ·
                </span>
                <span className="cit-usage-pill-time">{timeLeft}</span>
              </>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </span>
    </Link>
  );
}

function buildTooltip(
  displayName: string,
  summary: RuntimeUsageSummary | undefined,
  selected: { label: string; section: string | null } | null,
): string {
  if (!summary) return `${displayName} — loading usage…`;
  if (summary.status !== "healthy" || summary.categories.length === 0) {
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
