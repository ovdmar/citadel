import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";
import { cn } from "../../lib/utils.js";

// One TooltipProvider is mounted at the cockpit root (apps/web/src/main.tsx)
// with cockpit-tuned defaults: delayDuration=250 (faster than Radix's 700ms
// default — matches B.8 #3 "calm, dense, premium, operational") and
// skipDelayDuration=100 so once one tooltip is shown the dense cluster on
// the inspector / chrome stays instantly responsive.
export const COCKPIT_TOOLTIP_DELAY_MS = 250;
export const COCKPIT_TOOLTIP_SKIP_DELAY_MS = 100;

export const TooltipProvider = ({
  delayDuration = COCKPIT_TOOLTIP_DELAY_MS,
  skipDelayDuration = COCKPIT_TOOLTIP_SKIP_DELAY_MS,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) => (
  <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />
);

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export const TooltipPortal = TooltipPrimitive.Portal;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-md border border-[var(--c-line-2)] bg-[var(--c-dark)] px-2 py-1 text-xs text-[var(--c-on-dark)] shadow-[var(--sh-2)]",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = "TooltipContent";
