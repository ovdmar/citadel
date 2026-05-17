import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-action)] text-white hover:bg-[var(--color-action-hover)]",
        secondary:
          "border border-[color-mix(in_srgb,CanvasText_14%,transparent)] bg-transparent text-[CanvasText] hover:bg-[color-mix(in_srgb,CanvasText_7%,transparent)]",
        ghost: "bg-transparent text-[CanvasText] hover:bg-[color-mix(in_srgb,CanvasText_7%,transparent)]",
      },
      size: {
        default: "min-h-9 px-3",
        icon: "h-9 w-9 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";
