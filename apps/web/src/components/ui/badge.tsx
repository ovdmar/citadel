import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva("inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium leading-none", {
  variants: {
    variant: {
      neutral: "bg-[color-mix(in_srgb,CanvasText_8%,transparent)] text-[CanvasText]",
      ready: "bg-[color-mix(in_srgb,var(--color-success)_13%,transparent)] text-[var(--color-success)]",
      blocked: "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)]",
      info: "bg-[color-mix(in_srgb,var(--c-info)_15%,transparent)] text-[var(--c-info)]",
      warn: "bg-[color-mix(in_srgb,var(--color-warning)_13%,transparent)] text-[var(--color-warning)]",
      merged: "bg-[color-mix(in_srgb,var(--color-merged)_13%,transparent)] text-[var(--color-merged)]",
      "neutral-strong": "bg-[color-mix(in_srgb,CanvasText_18%,transparent)] text-[CanvasText]",
    },
  },
  defaultVariants: { variant: "neutral" },
});

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const dotTone: Record<BadgeVariant, string> = {
  neutral: "bg-[color-mix(in_srgb,CanvasText_55%,transparent)]",
  ready: "bg-[var(--color-success)]",
  blocked: "bg-[var(--color-danger)]",
  info: "bg-[var(--c-info)]",
  warn: "bg-[var(--color-warning)]",
  merged: "bg-[var(--color-merged)]",
  "neutral-strong": "bg-[CanvasText]",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

export function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  const resolvedVariant: BadgeVariant = variant ?? "neutral";
  return (
    <span
      data-variant={resolvedVariant}
      className={cn(badgeVariants({ variant: resolvedVariant }), className)}
      {...props}
    >
      {dot ? (
        <span
          data-slot="badge-dot"
          aria-hidden="true"
          className={cn("inline-block h-1.5 w-1.5 rounded-full", dotTone[resolvedVariant])}
        />
      ) : null}
      {children}
    </span>
  );
}
