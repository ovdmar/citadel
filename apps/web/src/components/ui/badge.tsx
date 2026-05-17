import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.js";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-1 text-xs font-medium leading-none", {
  variants: {
    variant: {
      neutral: "bg-[color-mix(in_srgb,CanvasText_8%,transparent)] text-[CanvasText]",
      ready: "bg-[color-mix(in_srgb,var(--color-success)_13%,transparent)] text-[var(--color-success)]",
      blocked: "bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] text-[var(--color-danger)]",
    },
  },
  defaultVariants: { variant: "neutral" },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
