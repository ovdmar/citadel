import { z } from "zod";

export const DEFAULT_PROVIDER_REFRESH = {
  enabled: true,
  workingHours: { startHour: 9, endHour: 18, weekdaysOnly: true },
  intervals: { prCiMs: 60_000, ciMs: 5 * 60_000, jiraMs: 5 * 60_000, usageMs: 5 * 60_000 },
  focusRefreshThresholdMs: 30_000,
  maxConcurrentRefreshes: 4,
} as const;

export const ProviderRefreshConfigSchema = z
  .object({
    enabled: z.boolean().default(DEFAULT_PROVIDER_REFRESH.enabled),
    // Uses the daemon process's local clock; set explicit hours or enabled:false
    // when the laptop clock is not the desired refresh window.
    workingHours: z
      .object({
        startHour: z.number().int().min(0).max(23).default(DEFAULT_PROVIDER_REFRESH.workingHours.startHour),
        endHour: z.number().int().min(0).max(24).default(DEFAULT_PROVIDER_REFRESH.workingHours.endHour),
        weekdaysOnly: z.boolean().default(DEFAULT_PROVIDER_REFRESH.workingHours.weekdaysOnly),
      })
      .default(DEFAULT_PROVIDER_REFRESH.workingHours),
    intervals: z
      .object({
        // Legacy name kept for config compatibility. This controls
        // version-control/PR metadata; CI run-list refresh is slower because PR
        // summaries already include statusCheckRollup.
        prCiMs: z.number().int().min(15_000).default(DEFAULT_PROVIDER_REFRESH.intervals.prCiMs),
        ciMs: z.number().int().min(60_000).default(DEFAULT_PROVIDER_REFRESH.intervals.ciMs),
        jiraMs: z.number().int().min(30_000).default(DEFAULT_PROVIDER_REFRESH.intervals.jiraMs),
        usageMs: z.number().int().min(30_000).default(DEFAULT_PROVIDER_REFRESH.intervals.usageMs),
      })
      .default(DEFAULT_PROVIDER_REFRESH.intervals),
    focusRefreshThresholdMs: z.number().int().min(5_000).default(DEFAULT_PROVIDER_REFRESH.focusRefreshThresholdMs),
    maxConcurrentRefreshes: z.number().int().min(1).max(16).default(DEFAULT_PROVIDER_REFRESH.maxConcurrentRefreshes),
  })
  .default(DEFAULT_PROVIDER_REFRESH);
