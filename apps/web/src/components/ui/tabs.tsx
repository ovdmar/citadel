import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";
import { cn } from "../../lib/utils.js";

export const Tabs = TabsPrimitive.Root;

// Compact pill-style tab strip matching B.2 Inspector Tabs #1 — only
// occupies its content width, never a half-panel-sized control.
export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-0.5 rounded-full border border-[var(--c-line-2)] bg-[var(--c-elev)] p-0.5",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-[var(--c-fg-3)] transition-colors",
      "hover:text-[var(--c-fg-1)]",
      "data-[state=active]:bg-[var(--c-card)] data-[state=active]:text-[var(--c-fg-1)] data-[state=active]:shadow-[var(--sh-1)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-1",
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-action)] focus-visible:ring-offset-1",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";
