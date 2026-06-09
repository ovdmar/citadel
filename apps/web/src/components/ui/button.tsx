import { Slot } from "@radix-ui/react-slot";
import { type VariantProps, cva } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center gap-2 rounded-[7px] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-55",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-action)] text-white hover:bg-[var(--color-action-hover)]",
        secondary:
          "border border-[color-mix(in_srgb,CanvasText_14%,transparent)] bg-transparent text-[CanvasText] hover:bg-[color-mix(in_srgb,CanvasText_7%,transparent)]",
        ghost: "bg-transparent text-[CanvasText] hover:bg-[color-mix(in_srgb,CanvasText_7%,transparent)]",
        destructive: "bg-[var(--color-danger)] text-white hover:opacity-90 focus-visible:ring-[var(--color-danger)]",
        link: "bg-transparent px-0 text-[var(--color-action)] underline-offset-4 hover:underline",
      },
      size: {
        sm: "min-h-7 px-2 text-xs",
        default: "min-h-9 px-3 py-2",
        lg: "min-h-10 px-4 py-2",
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
  loading?: boolean;
}

function Spinner() {
  return (
    <span
      aria-hidden="true"
      data-slot="spinner"
      className="inline-block h-3.5 w-3.5 animate-[spin_0.7s_linear_infinite] rounded-full border-2 border-current border-r-transparent opacity-70"
    />
  );
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const isDisabled = disabled || loading;
    const ariaBusy = loading ? "true" : undefined;
    // Slot requires a single child. When asChild=true, pass `children`
    // through unchanged; the spinner is not injected because the consumer
    // chose polymorphism. Disabled / aria-busy still apply.
    const content = asChild ? (
      children
    ) : (
      <>
        {loading ? <Spinner /> : null}
        {children}
      </>
    );
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        disabled={isDisabled}
        aria-busy={ariaBusy}
        {...props}
      >
        {content}
      </Comp>
    );
  },
);
Button.displayName = "Button";
