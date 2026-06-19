import type * as React from "react";
import { cn } from "../../lib/utils.js";

export interface SkeletonProps extends Omit<React.OutputHTMLAttributes<HTMLOutputElement>, "children"> {
  width?: number | string;
  height?: number | string;
  label?: string;
}

function dimensionToCss(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" ? `${value}px` : value;
}

// `<output role="status">` is the WAI-ARIA-conformant element for an aria-busy
// placeholder per Biome's useSemanticElements rule. Visually it behaves like
// any block-level shimmer — the role+busy attrs are what assistive tech reads.
export function Skeleton({ width, height, label, className, style, ...props }: SkeletonProps) {
  const mergedStyle = {
    ...style,
    ...(width !== undefined ? { width: dimensionToCss(width) } : {}),
    ...(height !== undefined ? { height: dimensionToCss(height) } : {}),
  };
  return (
    <output
      data-component="skeleton"
      aria-busy="true"
      aria-label={label}
      className={cn(
        "inline-block animate-pulse rounded-md bg-[color-mix(in_srgb,CanvasText_10%,transparent)]",
        className,
      )}
      style={mergedStyle}
      {...props}
    >
      {label ? <span className="sr-only">{label}</span> : null}
    </output>
  );
}
