import { z } from "zod";

export const SystemHealthToneSchema = z.enum(["healthy", "degraded", "critical", "unknown"]);
export type SystemHealthTone = z.infer<typeof SystemHealthToneSchema>;

const PercentSchema = z.number().min(0).max(100).nullable();
const NullableBytesSchema = z.number().nonnegative().nullable();

export const SystemMemorySnapshotSchema = z.object({
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  freeBytes: z.number().nonnegative(),
  percentUsed: PercentSchema,
});
export type SystemMemorySnapshot = z.infer<typeof SystemMemorySnapshotSchema>;

export const SystemDiskSnapshotSchema = z.object({
  path: z.string().min(1),
  device: z.string().min(1).nullable().default(null),
  totalBytes: NullableBytesSchema,
  usedBytes: NullableBytesSchema,
  freeBytes: NullableBytesSchema,
  percentUsed: PercentSchema,
  ioUtilizationPercent: PercentSchema,
  error: z.string().nullable().default(null),
});
export type SystemDiskSnapshot = z.infer<typeof SystemDiskSnapshotSchema>;

export const SystemCpuSnapshotSchema = z.object({
  percentUsed: PercentSchema,
  loadAverage1m: z.number().nonnegative().nullable(),
  cores: z.number().int().positive(),
});
export type SystemCpuSnapshot = z.infer<typeof SystemCpuSnapshotSchema>;

export const CitadelProcessSnapshotSchema = z.object({
  pid: z.number().int().positive(),
  rssBytes: z.number().nonnegative(),
  heapUsedBytes: z.number().nonnegative(),
  heapTotalBytes: z.number().nonnegative(),
  percentOfMachineMemory: PercentSchema,
});
export type CitadelProcessSnapshot = z.infer<typeof CitadelProcessSnapshotSchema>;

export const SystemHealthSnapshotSchema = z.object({
  tone: SystemHealthToneSchema,
  reason: z.string().nullable().default(null),
  checkedAt: z.string().datetime(),
  machine: z.object({
    cpu: SystemCpuSnapshotSchema,
    memory: SystemMemorySnapshotSchema,
    disk: SystemDiskSnapshotSchema,
  }),
  process: CitadelProcessSnapshotSchema,
});
export type SystemHealthSnapshot = z.infer<typeof SystemHealthSnapshotSchema>;
